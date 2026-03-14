// ─── A2E Tool ─────────────────────────────────────────────────
// Integrates the A2E (Agent-to-Execution) protocol v1.0.0 with MicroExpert.
// Parses [A2E: ...] tags and executes workflows against a local
// or remote A2E server. Unlike FETCH, this tool allows localhost
// connections since A2E is a trusted local service.
//
// Uses RepoMemory's validation pipeline (normalizeResponse → fixJsonl →
// validateWorkflow) to repair LLM output before sending to A2E server.
//
// Spec-compliant JSONL format:
//   {"type":"operationUpdate","operationId":"op-1","operation":{"ApiCall":{...}}}
//   {"type":"beginExecution","executionId":"exec-1","operationOrder":["op-1"]}

import {
  sanitizeSecrets,
  resolveSecrets,
  validateWorkflow,
  normalizeResponse,
  fixJsonl,
} from '@rckflr/repomemory';

export const A2E_TIMEOUT_MS = 30_000;
export const A2E_MAX_RESULT_CHARS = 2048;

export interface A2eConfig {
  /** A2E server base URL (e.g., http://localhost:8000) */
  url: string;
  /** API key for authentication */
  apiKey?: string;
}

export interface A2eWorkflowRequest {
  /** JSONL workflow string */
  workflow: string;
  /** Whether to validate before execution */
  validate?: boolean;
}

/**
 * Parse an [A2E: ...] tag's inner content.
 *
 * Supports two formats:
 *
 * 1. Inline workflow JSON (spec-compliant JSONL):
 *    [A2E: {"type":"operationUpdate","operationId":"op-1","operation":{"ApiCall":{...}}}
 *    {"type":"beginExecution","executionId":"exec-1","operationOrder":["op-1"]}]
 *
 * 2. Named operation shorthand:
 *    [A2E: ApiCall GET https://api.example.com/users]
 *    [A2E: FilterData /workflow/users points > 100]
 */
export function parseA2eTag(raw: string): A2eWorkflowRequest {
  const trimmed = raw.trim();

  // Format 1: Raw JSONL (starts with { ) — run through repair pipeline
  if (trimmed.startsWith('{')) {
    const repaired = repairWorkflow(trimmed);
    return { workflow: repaired.workflow, validate: !repaired.valid };
  }

  // Format 2: Shorthand — convert to spec-compliant JSONL (already valid, skip server validation)
  const workflow = shorthandToWorkflow(trimmed);
  return { workflow, validate: false };
}

/**
 * Convert shorthand notation to A2E spec v1.0.0 JSONL workflow.
 *
 * Produces spec-compliant format:
 *   {"type":"operationUpdate","operationId":"op-1","operation":{"ApiCall":{...}}}
 *   {"type":"beginExecution","executionId":"exec-<ts>","operationOrder":["op-1"]}
 */
function shorthandToWorkflow(input: string): string {
  const parts = input.split(/\s+/);
  const opType = parts[0];

  let operation: Record<string, unknown>;

  switch (opType) {
    case 'ApiCall': {
      const method = parts[1] || 'GET';
      const url = parts[2] || '';
      const bodyStr = parts.slice(3).join(' ');
      operation = {
        ApiCall: {
          method,
          url,
          outputPath: '/workflow/result',
          ...(bodyStr && method !== 'GET' ? { body: tryParseJson(bodyStr) } : {}),
        },
      };
      break;
    }
    case 'FilterData': {
      const inputPath = parts[1] || '/workflow/data';
      const field = parts[2] || '';
      const operator = parts[3] || '==';
      const value = parts.slice(4).join(' ');
      operation = {
        FilterData: {
          inputPath,
          conditions: [{ field, operator, value: tryParseValue(value) }],
          outputPath: '/workflow/filtered',
        },
      };
      break;
    }
    case 'TransformData': {
      const inputPath = parts[1] || '/workflow/data';
      const transform = parts[2] || 'map';
      const configStr = parts.slice(3).join(' ');
      operation = {
        TransformData: {
          inputPath,
          transform,
          config: tryParseJson(configStr) || {},
          outputPath: '/workflow/transformed',
        },
      };
      break;
    }
    case 'McpCall': {
      const tool = parts[1] || '';
      const argsStr = parts.slice(2).join(' ');
      operation = {
        McpCall: {
          tool,
          args: tryParseJson(argsStr) || {},
          outputPath: '/workflow/mcp-result',
        },
      };
      break;
    }
    case 'MemoryCall': {
      const action = parts[1] || 'search';
      const rest = parts.slice(2).join(' ');
      const memConfig: Record<string, unknown> = {
        action,
        outputPath: '/workflow/memory-result',
      };
      if (action === 'search' || action === 'recall') {
        memConfig.query = rest;
      } else if (action === 'save') {
        const parsed = tryParseJson(rest);
        if (parsed && typeof parsed === 'object') {
          Object.assign(memConfig, parsed);
        } else {
          memConfig.content = rest;
        }
      }
      operation = { MemoryCall: memConfig };
      break;
    }
    default: {
      // Pass through as generic operation
      const rest = parts.slice(1).join(' ');
      operation = { [opType]: tryParseJson(rest) || {} };
      break;
    }
  }

  const execId = `exec-${Date.now()}`;

  const opLine = JSON.stringify({
    type: 'operationUpdate',
    operationId: 'op-1',
    operation,
  });

  const execLine = JSON.stringify({
    type: 'beginExecution',
    executionId: execId,
    operationOrder: ['op-1'],
  });

  return `${opLine}\n${execLine}`;
}

/**
 * Execute an A2E workflow against the server.
 */
export async function executeA2e(
  request: A2eWorkflowRequest,
  config: A2eConfig,
): Promise<string> {
  const url = `${config.url.replace(/\/$/, '')}/api/v1/workflows/execute`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey) {
    headers['X-API-Key'] = config.apiKey;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), A2E_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workflow: request.workflow,
        validate: request.validate ?? true,
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    let body = text;

    // Try to extract just the data portion for conciseness
    try {
      const json = JSON.parse(text);
      if (json.results) {
        // Spec-compliant response: extract results
        body = JSON.stringify(json.results, null, 2);
      } else if (json.data) {
        // Legacy response format
        body = JSON.stringify(json.data, null, 2);
      } else if (json.error) {
        body = `A2E Error: ${json.error.message || JSON.stringify(json.error)}`;
      }
    } catch {
      // Not JSON, use raw text
    }

    // Truncate for model context
    if (body.length > A2E_MAX_RESULT_CHARS) {
      body = body.slice(0, A2E_MAX_RESULT_CHARS) + '... [truncated]';
    }

    return body;
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') {
      throw new Error(`A2E request timed out after ${A2E_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`A2E request failed: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

// sanitizeSecrets, resolveSecrets imported from @rckflr/repomemory (4-layer sanitization)
// Re-export for backwards compatibility with existing imports
export { sanitizeSecrets, resolveSecrets };

/**
 * Validate and repair raw JSONL workflow from LLM output before sending to A2E server.
 * Uses RepoMemory's three-stage pipeline:
 * 1. normalizeResponse: strip <think> tags, collapse pretty-print, extract from code blocks
 * 2. fixJsonl: fix unquoted keys/values, repair truncated JSON
 * 3. validateWorkflow: validate structure, auto-synthesize missing beginExecution
 */
export function repairWorkflow(raw: string): { workflow: string; valid: boolean; autoFixed: boolean } {
  const normalized = normalizeResponse(raw);
  const fixed = fixJsonl(normalized);
  const result = validateWorkflow(fixed);

  if (result.valid) {
    // Reconstruct clean JSONL from validated messages
    const cleanLines = result.messages.map(m => JSON.stringify(m));
    return { workflow: cleanLines.join('\n'), valid: true, autoFixed: result.autoFixed ?? false };
  }

  // Not fully valid but return the best-effort fix
  return { workflow: fixed, valid: false, autoFixed: false };
}

function tryParseJson(str: string): unknown {
  if (!str) return undefined;
  try { return JSON.parse(str); } catch { return str; }
}

function tryParseValue(str: string): unknown {
  if (!str) return '';
  if (str === 'true') return true;
  if (str === 'false') return false;
  const num = Number(str);
  if (!isNaN(num)) return num;
  return str;
}
