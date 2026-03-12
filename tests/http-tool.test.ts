import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseFetchTag, isUrlAllowed, executeFetch } from '../src/agent/http-tool.js';

describe('parseFetchTag', () => {
  it('should parse a simple GET request', () => {
    const result = parseFetchTag('GET https://api.example.com/data');
    expect(result.method).toBe('GET');
    expect(result.url).toBe('https://api.example.com/data');
    expect(result.headers).toEqual({});
    expect(result.body).toBeUndefined();
  });

  it('should parse POST with body', () => {
    const result = parseFetchTag(
      'POST https://api.example.com/items\nBody: {"name": "test"}'
    );
    expect(result.method).toBe('POST');
    expect(result.url).toBe('https://api.example.com/items');
    expect(result.body).toBe('{"name": "test"}');
  });

  it('should parse request with headers', () => {
    const result = parseFetchTag(
      'GET https://api.example.com/data\nHeader: Authorization: Bearer token123\nHeader: Accept: application/json'
    );
    expect(result.method).toBe('GET');
    expect(result.headers).toEqual({
      Authorization: 'Bearer token123',
      Accept: 'application/json',
    });
  });

  it('should parse full POST with headers and body', () => {
    const result = parseFetchTag(
      'POST https://api.example.com/items\nHeader: Authorization: Bearer xyz\nBody: {"key": "value"}'
    );
    expect(result.method).toBe('POST');
    expect(result.url).toBe('https://api.example.com/items');
    expect(result.headers).toEqual({ Authorization: 'Bearer xyz' });
    expect(result.body).toBe('{"key": "value"}');
  });

  it('should handle PUT and DELETE methods', () => {
    expect(parseFetchTag('PUT https://api.example.com/1').method).toBe('PUT');
    expect(parseFetchTag('DELETE https://api.example.com/1').method).toBe('DELETE');
  });

  it('should be case-insensitive for method', () => {
    const result = parseFetchTag('get https://api.example.com/data');
    expect(result.method).toBe('GET');
  });

  it('should throw on empty input', () => {
    expect(() => parseFetchTag('')).toThrow('Empty FETCH tag');
  });

  it('should throw on missing URL', () => {
    expect(() => parseFetchTag('GET')).toThrow('Invalid FETCH format');
  });

  it('should throw on unsupported method', () => {
    expect(() => parseFetchTag('PATCH https://example.com')).toThrow('Unsupported HTTP method');
  });

  it('should throw on malformed header', () => {
    expect(() => parseFetchTag('GET https://example.com\nHeader: bad-no-colon')).toThrow('Invalid header format');
  });
});

describe('isUrlAllowed', () => {
  it('should allow https URLs', () => {
    expect(isUrlAllowed('https://api.example.com/data')).toBe(true);
  });

  it('should allow http URLs', () => {
    expect(isUrlAllowed('http://api.example.com/data')).toBe(true);
  });

  it('should block file:// URLs', () => {
    expect(isUrlAllowed('file:///etc/passwd')).toBe(false);
  });

  it('should block ftp:// URLs', () => {
    expect(isUrlAllowed('ftp://files.example.com')).toBe(false);
  });

  it('should block data: URLs', () => {
    expect(isUrlAllowed('data:text/html,<h1>hi</h1>')).toBe(false);
  });

  it('should block localhost', () => {
    expect(isUrlAllowed('http://localhost:3000')).toBe(false);
    expect(isUrlAllowed('http://localhost/api')).toBe(false);
  });

  it('should block 127.0.0.1', () => {
    expect(isUrlAllowed('http://127.0.0.1:8080')).toBe(false);
  });

  it('should block 0.0.0.0', () => {
    expect(isUrlAllowed('http://0.0.0.0')).toBe(false);
  });

  it('should block private 10.x.x.x IPs', () => {
    expect(isUrlAllowed('http://10.0.0.1')).toBe(false);
    expect(isUrlAllowed('http://10.255.255.255')).toBe(false);
  });

  it('should block private 172.16-31.x.x IPs', () => {
    expect(isUrlAllowed('http://172.16.0.1')).toBe(false);
    expect(isUrlAllowed('http://172.31.255.255')).toBe(false);
  });

  it('should allow non-private 172.x IPs', () => {
    expect(isUrlAllowed('http://172.15.0.1')).toBe(true);
    expect(isUrlAllowed('http://172.32.0.1')).toBe(true);
  });

  it('should block private 192.168.x.x IPs', () => {
    expect(isUrlAllowed('http://192.168.1.1')).toBe(false);
    expect(isUrlAllowed('http://192.168.0.100')).toBe(false);
  });

  it('should block link-local 169.254.x.x IPs', () => {
    expect(isUrlAllowed('http://169.254.1.1')).toBe(false);
  });

  it('should return false for invalid URLs', () => {
    expect(isUrlAllowed('not a url')).toBe(false);
    expect(isUrlAllowed('')).toBe(false);
  });
});

describe('executeFetch', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchResponse(body: string, status = 200): void {
    const encoder = new TextEncoder();
    const encoded = encoder.encode(body);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      status,
      body: stream,
    } as unknown as Response);
  }

  it('should execute a GET request and return response', async () => {
    mockFetchResponse('{"message": "hello"}');

    const result = await executeFetch({
      method: 'GET',
      url: 'https://api.example.com/data',
      headers: {},
    });

    expect(result).toContain('HTTP 200');
    expect(result).toContain('{"message": "hello"}');
  });

  it('should include status code in response', async () => {
    mockFetchResponse('Not Found', 404);

    const result = await executeFetch({
      method: 'GET',
      url: 'https://api.example.com/missing',
      headers: {},
    });

    expect(result).toContain('HTTP 404');
    expect(result).toContain('Not Found');
  });

  it('should pass headers and body for POST', async () => {
    mockFetchResponse('{"id": 1}', 201);

    await executeFetch({
      method: 'POST',
      url: 'https://api.example.com/items',
      headers: { Authorization: 'Bearer token' },
      body: '{"name": "test"}',
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].method).toBe('POST');
    expect(fetchCall[1].body).toBe('{"name": "test"}');
    expect(fetchCall[1].headers.Authorization).toBe('Bearer token');
  });

  it('should truncate long responses', async () => {
    const longBody = 'x'.repeat(3000);
    mockFetchResponse(longBody);

    const result = await executeFetch({
      method: 'GET',
      url: 'https://api.example.com/big',
      headers: {},
    });

    expect(result).toContain('... [truncated]');
    expect(result.length).toBeLessThan(longBody.length);
  });

  it('should reject blocked URLs', async () => {
    await expect(
      executeFetch({
        method: 'GET',
        url: 'http://localhost:3000/secret',
        headers: {},
      })
    ).rejects.toThrow('Blocked URL');
  });

  it('should reject private IPs', async () => {
    await expect(
      executeFetch({
        method: 'GET',
        url: 'http://192.168.1.1/admin',
        headers: {},
      })
    ).rejects.toThrow('Blocked URL');
  });

  it('should handle network errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    await expect(
      executeFetch({
        method: 'GET',
        url: 'https://unreachable.example.com',
        headers: {},
      })
    ).rejects.toThrow('Fetch failed: Network error');
  });

  it('should handle timeout (abort)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    globalThis.fetch = vi.fn().mockRejectedValue(abortError);

    await expect(
      executeFetch({
        method: 'GET',
        url: 'https://slow.example.com',
        headers: {},
      })
    ).rejects.toThrow('timed out');
  });
});
