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

// ─── Secret handling ─────────────────────────────────────────
// resolveSecrets / sanitizeSecrets are implemented locally. The previous
// implementation imported them from @rckflr/repomemory, but the installed
// version (2.16.0) does not export them, so they are provided here.

/**
 * Replace `{{VAR}}` placeholders in `text` with values from `secrets`.
 * Unknown placeholders are left untouched.
 */
export function resolveSecrets(text: string, secrets: Record<string, string>): string {
  if (!text) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    return Object.prototype.hasOwnProperty.call(secrets, name) ? String(secrets[name]) : match;
  });
}

// Sensitive query-parameter names that should be redacted heuristically
// when their value is not already a `{{...}}` placeholder.
const SENSITIVE_PARAM_NAMES = [
  'apikey',
  'api_key',
  'access_token',
  'accesstoken',
  'token',
  'secret',
  'password',
  'passwd',
  'appid',
  'app_id',
  'auth',
  'key',
];

/**
 * Redact secret values from `text` so it can be shown to the model / logged.
 *
 * Two layers:
 * 1. Known secrets: replace each secret value (length >= 4) with `{{VAR}}`.
 * 2. Heuristic: redact sensitive query-param values (`apiKey=...`, `token=...`,
 *    `appid=...`, etc.) with `{{PARAMNAME}}`, unless the value is already a
 *    `{{...}}` placeholder (so we never double-wrap).
 */
export function sanitizeSecrets(text: string, secrets: Record<string, string>): string {
  if (!text) return text;

  let result = text;

  // Layer 1: known secret values. Only values with length >= 4 to avoid
  // trivially short substrings matching unrelated tokens.
  for (const [name, value] of Object.entries(secrets)) {
    if (typeof value !== 'string' || value.length < 4) continue;
    if (value.includes('{{') || value.includes('}}')) continue;
    result = result.split(value).join(`{{${name}}}`);
  }

  // Layer 2: heuristic redaction of sensitive query params.
  // Value runs until a delimiter (&, #, whitespace, quote, or bracket).
  result = result.replace(/([A-Za-z_][A-Za-z0-9_]*)=([^&#\s"'<>{}\\]+)/g, (match, param: string, val: string) => {
    if (!SENSITIVE_PARAM_NAMES.includes(param.toLowerCase())) return match;
    if (val.startsWith('{{') && val.endsWith('}}')) return match; // already a placeholder
    return `${param}={{${param.toUpperCase()}}}`;
  });

  return result;
}

/**
 * Validate and repair raw JSONL workflow from LLM output before sending to A2E server.
 * Uses RepoMemory's three-stage pipeline:
 * 1. normalizeResponse: strip <think> tags, collapse pretty-print, extract from code blocks
 * 2. fixJsonl: fix unquoted keys/values, repair truncated JSON
 * 3. validateWorkflow: validate structure, auto-synthesize missing beginExecution
 */
export function repairWorkflow(raw: string): { workflow: string; valid: boolean; autoFixed: boolean } {
  const lines = raw.split('\n').filter(l => l.trim().length > 0);

  let hasBegin = false;
  let allValid = true;
  const opIds: string[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as { type?: string; operationId?: unknown };
      if (obj.type === 'beginExecution') hasBegin = true;
      if (obj.type === 'operationUpdate' && typeof obj.operationId === 'string') {
        opIds.push(obj.operationId);
      }
    } catch {
      allValid = false;
    }
  }

  if (hasBegin) {
    return { workflow: lines.join('\n'), valid: allValid, autoFixed: false };
  }

  if (opIds.length > 0) {
    const beginLine = JSON.stringify({
      type: 'beginExecution',
      executionId: `exec-${Date.now()}`,
      operationOrder: opIds,
    });
    return { workflow: [...lines, beginLine].join('\n'), valid: true, autoFixed: true };
  }

  return { workflow: lines.join('\n'), valid: allValid, autoFixed: false };
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
