/**
 * Deterministic validator for Memory Packs (v1 / v2).
 *
 * No external dependencies, no network. Pure data validation that runs
 * BEFORE a pack is imported into memory, so a malformed pack is rejected
 * instead of being amplified via recall.
 *
 * Pack shapes (see README "Memory Packs"):
 *   v1: { version: 1, memories: [...] }  (version field optional — an object
 *       with a memories array is treated as v1)
 *   v2: { version: 2, pack: { name: string, ... }, memories: [...], skills: [...] }
 *
 * Tool-calling tags inside `content` are validated structurally:
 *   [MCP: tool_name {json_args}]   — name non-empty, args valid JSON (bracket-aware)
 *   [FETCH: METHOD url]             — METHOD in GET/POST/PUT/DELETE/PATCH, url http(s)://
 *   [CALC: expression]              — expression non-empty
 */

export interface PackValidationResult {
  valid: boolean;
  errors: string[];
}

const MCP_MARKER = '[MCP:';
const FETCH_MARKER = '[FETCH:';
const CALC_MARKER = '[CALC:';
const FETCH_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * Validate a parsed pack object. Returns { valid, errors } with per-entry
 * error messages (index + cause) — never throws.
 */
export function validatePack(data: unknown): PackValidationResult {
  const errors: string[] = [];

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['Pack must be a JSON object.'] };
  }

  const obj = data as Record<string, unknown>;
  const version = obj.version;

  if (version === 2) {
    validateV2(obj, errors);
  } else if (version === 1) {
    if (!Array.isArray(obj.memories)) {
      errors.push('Invalid pack: "memories" must be an array.');
    } else {
      validateEntries(obj.memories, 'memories', errors);
    }
  } else if (version === undefined && Array.isArray(obj.memories)) {
    // Lenient v1: an object with a memories array and no version field.
    validateEntries(obj.memories, 'memories', errors);
  } else {
    errors.push(
      `Unknown pack structure: unsupported version ${JSON.stringify(version)}. ` +
      'Expected a memories array (v1) or version 2 with pack metadata.',
    );
  }

  return { valid: errors.length === 0, errors };
}

function validateV2(obj: Record<string, unknown>, errors: string[]): void {
  const pack = obj.pack;
  if (pack === null || typeof pack !== 'object' || Array.isArray(pack)) {
    errors.push('Invalid v2 pack: "pack" must be an object.');
  } else {
    const name = (pack as Record<string, unknown>).name;
    if (typeof name !== 'string' || name.trim() === '') {
      errors.push('Invalid v2 pack: "pack.name" must be a non-empty string.');
    }
  }

  if (!Array.isArray(obj.memories)) {
    errors.push('Invalid v2 pack: "memories" must be an array.');
  } else {
    validateEntries(obj.memories, 'memories', errors);
  }

  if (!Array.isArray(obj.skills)) {
    errors.push('Invalid v2 pack: "skills" must be an array.');
  } else {
    validateEntries(obj.skills, 'skills', errors);
  }
}

/**
 * Validate an array of memory/skill entries. Each must be an object with a
 * non-empty string `content`; `category` (if present) a string; `tags`
 * (if present) an array of strings. Content tool tags are then validated.
 */
function validateEntries(
  entries: unknown[],
  label: string,
  errors: string[],
): void {
  entries.forEach((entry, i) => {
    const where = `${label}[${i}]`;

    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${where}: must be an object.`);
      return;
    }

    const e = entry as Record<string, unknown>;

    if (typeof e.content !== 'string' || e.content.length === 0) {
      errors.push(`${where}: "content" must be a non-empty string.`);
    }
    if (e.category !== undefined && typeof e.category !== 'string') {
      errors.push(`${where}: "category" must be a string.`);
    }
    if (e.tags !== undefined) {
      if (!Array.isArray(e.tags) || !e.tags.every((t) => typeof t === 'string')) {
        errors.push(`${where}: "tags" must be an array of strings.`);
      }
    }

    if (typeof e.content === 'string' && e.content.length > 0) {
      validateContent(e.content, where, errors);
    }
  });
}

/**
 * Validate tool-calling tags within a content string.
 * Reimplements bracket-aware extraction locally (does not import the agent
 * loop) so the validator stays decoupled from runtime tool execution.
 */
function validateContent(content: string, where: string, errors: string[]): void {
  // --- [MCP: tool_name {json_args}] ---
  if (content.includes(MCP_MARKER)) {
    const tags = extractTags(content, MCP_MARKER);
    if (tags.length === 0) {
      errors.push(`${where}: malformed or unclosed [MCP:] tag.`);
    }
    for (const inner of tags) {
      const parsed = parseMcpInner(inner);
      if (!parsed.toolName) {
        errors.push(`${where}: [MCP:] tag has empty tool name.`);
        continue;
      }
      if (parsed.argsRaw !== '') {
        try {
          JSON.parse(parsed.argsRaw);
        } catch {
          errors.push(
            `${where}: [MCP: ${parsed.toolName}] has invalid JSON args: ${parsed.argsRaw}`,
          );
        }
      }
    }
  }

  // --- [FETCH: METHOD url] ---
  for (const inner of extractTags(content, FETCH_MARKER)) {
    const trimmed = inner.trim();
    const parts = trimmed.split(/\s+/).filter(Boolean);
    const method = parts[0]?.toUpperCase();
    const url = parts[1];

    if (!method || !FETCH_METHODS.has(method)) {
      errors.push(
        `${where}: [FETCH:] has invalid method "${method ?? ''}" (expected GET/POST/PUT/DELETE/PATCH).`,
      );
    }
    if (!url || !/^https?:\/\//i.test(url)) {
      errors.push(
        `${where}: [FETCH:] URL must be http(s)://, got "${url ?? ''}".`,
      );
    }
  }

  // --- [CALC: expression] ---
  for (const inner of extractTags(content, CALC_MARKER)) {
    if (inner.trim() === '') {
      errors.push(`${where}: [CALC:] has empty expression.`);
    }
  }
}

interface McpParsed {
  toolName: string;
  argsRaw: string;
}

/** Parse the inner text of an MCP tag: first token = tool name, rest = args. */
function parseMcpInner(inner: string): McpParsed {
  let i = 0;
  while (i < inner.length && /\s/.test(inner[i])) i++;
  const nameStart = i;
  while (i < inner.length && /\S/.test(inner[i])) i++;
  const toolName = inner.slice(nameStart, i);
  while (i < inner.length && /\s/.test(inner[i])) i++;
  const argsRaw = inner.slice(i).trim();
  return { toolName, argsRaw };
}

/**
 * Bracket-aware extraction: returns the inner text of every balanced
 * `<marker> ... ]` tag. Handles nested `[]` (e.g. JSON arrays in MCP args).
 * Unclosed markers are skipped.
 */
function extractTags(content: string, marker: string): string[] {
  const results: string[] = [];
  let searchFrom = 0;

  while (searchFrom <= content.length) {
    const start = content.indexOf(marker, searchFrom);
    if (start === -1) break;

    let i = start + marker.length;
    let depth = 1;
    while (i < content.length && depth > 0) {
      if (content[i] === '[') depth++;
      else if (content[i] === ']') depth--;
      if (depth > 0) i++;
    }

    if (depth !== 0) {
      // Unclosed tag — skip past the marker.
      searchFrom = start + marker.length;
      continue;
    }

    results.push(content.slice(start + marker.length, i));
    searchFrom = i + 1;
  }

  return results;
}