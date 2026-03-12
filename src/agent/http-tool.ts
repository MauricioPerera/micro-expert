// ─── HTTP Fetch Tool ──────────────────────────────────────────
// Safe HTTP client for tag-based tool calling.
// Parses [FETCH: METHOD url ...] tags and executes requests
// with security restrictions (blocked hosts, timeout, size limits).

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 32 * 1024;
export const MAX_RESULT_CHARS = 2048;

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
]);

const BLOCKED_SCHEMES = new Set(['file:', 'ftp:', 'data:', 'javascript:']);

export interface FetchRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Parse a [FETCH: ...] tag's inner content into a structured request.
 *
 * Single-line: `GET https://example.com/api`
 * Multi-line:
 *   POST https://example.com/api
 *   Header: Authorization: Bearer token
 *   Body: {"key": "value"}
 */
export function parseFetchTag(raw: string): FetchRequest {
  const lines = raw.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);

  if (lines.length === 0) {
    throw new Error('Empty FETCH tag');
  }

  // First line: METHOD URL
  const firstLine = lines[0];
  const spaceIdx = firstLine.indexOf(' ');
  if (spaceIdx === -1) {
    throw new Error(`Invalid FETCH format: expected "METHOD URL", got "${firstLine}"`);
  }

  const method = firstLine.slice(0, spaceIdx).toUpperCase();
  const url = firstLine.slice(spaceIdx + 1).trim();

  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`Unsupported HTTP method: ${method}. Allowed: ${[...ALLOWED_METHODS].join(', ')}`);
  }

  if (!url) {
    throw new Error('Missing URL in FETCH tag');
  }

  const headers: Record<string, string> = {};
  let body: string | undefined;

  // Remaining lines: Header: or Body:
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    if (line.toLowerCase().startsWith('header:')) {
      const headerValue = line.slice(7).trim();
      const colonIdx = headerValue.indexOf(':');
      if (colonIdx === -1) {
        throw new Error(`Invalid header format: "${line}". Expected "Header: Name: Value"`);
      }
      const name = headerValue.slice(0, colonIdx).trim();
      const value = headerValue.slice(colonIdx + 1).trim();
      headers[name] = value;
    } else if (line.toLowerCase().startsWith('body:')) {
      body = line.slice(5).trim();
    }
  }

  return { method, url, headers, body };
}

/**
 * Check if a URL is safe to fetch.
 * Blocks: file://, ftp://, data:, localhost, loopback, private IPs.
 */
export function isUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Block dangerous schemes
  if (BLOCKED_SCHEMES.has(parsed.protocol)) {
    return false;
  }

  // Only allow http: and https:
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const hostname = (parsed.hostname ?? '').toLowerCase();

  // Block known localhost names
  if (BLOCKED_HOSTS.has(hostname)) {
    return false;
  }

  // Block private IP ranges
  if (isPrivateIP(hostname)) {
    return false;
  }

  return true;
}

/**
 * Check if a hostname looks like a private IP address.
 */
function isPrivateIP(hostname: string): boolean {
  // IPv4 patterns
  const parts = hostname.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
    const octets = parts.map(Number);

    // 10.0.0.0/8
    if (octets[0] === 10) return true;

    // 172.16.0.0/12
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;

    // 192.168.0.0/16
    if (octets[0] === 192 && octets[1] === 168) return true;

    // 169.254.0.0/16 (link-local)
    if (octets[0] === 169 && octets[1] === 254) return true;
  }

  return false;
}

/**
 * Execute an HTTP fetch request with safety limits.
 * Returns the response body as text, truncated if needed.
 */
export async function executeFetch(request: FetchRequest): Promise<string> {
  // Validate URL
  if (!isUrlAllowed(request.url)) {
    throw new Error(`Blocked URL: ${request.url} (private/local addresses not allowed)`);
  }

  // Set up timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const fetchOptions: RequestInit = {
      method: request.method,
      headers: request.headers,
      signal: controller.signal,
      redirect: 'follow',
    };

    if (request.body && request.method !== 'GET') {
      fetchOptions.body = request.body;
      // Set Content-Type if not already set
      if (!Object.keys(request.headers).some(k => k.toLowerCase() === 'content-type')) {
        (fetchOptions.headers as Record<string, string>)['Content-Type'] = 'application/json';
      }
    }

    const response = await fetch(request.url, fetchOptions);

    // Read response with size limit
    const reader = response.body?.getReader();
    if (!reader) {
      return `HTTP ${response.status} (no body)`;
    }

    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalSize += value.byteLength;
      if (totalSize > MAX_RESPONSE_BYTES) {
        reader.cancel();
        break;
      }
      chunks.push(value);
    }

    const decoder = new TextDecoder();
    let body = chunks.map(c => decoder.decode(c, { stream: true })).join('');
    body += decoder.decode(); // flush

    // Truncate for model context
    const truncated = totalSize > MAX_RESPONSE_BYTES;
    if (body.length > MAX_RESULT_CHARS) {
      body = body.slice(0, MAX_RESULT_CHARS) + '... [truncated]';
    } else if (truncated) {
      body += '... [truncated]';
    }

    return `HTTP ${response.status}\n${body}`;
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`Fetch failed: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}
