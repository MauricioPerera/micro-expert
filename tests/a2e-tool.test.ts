import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import {
  parseA2eTag,
  executeA2e,
  resolveSecrets,
  sanitizeSecrets,
  A2E_TIMEOUT_MS,
  A2E_MAX_RESULT_CHARS,
  type A2eConfig,
  type A2eWorkflowRequest,
} from '../src/agent/a2e-tool.js';

// ─── Helper: parse JSONL lines from workflow ───
function parseWorkflowLines(workflow: string) {
  const lines = workflow.split('\n').filter(Boolean);
  return lines.map(l => JSON.parse(l));
}

function getOperation(workflow: string) {
  const [opLine] = parseWorkflowLines(workflow);
  return opLine.operation;
}

function getOperationType(workflow: string) {
  const op = getOperation(workflow);
  return Object.keys(op)[0];
}

function getOperationConfig(workflow: string) {
  const op = getOperation(workflow);
  const [type] = Object.keys(op);
  return op[type];
}

// ═══════════════════════════════════════════════════════════════
// 1. parseA2eTag — Parsing
// ═══════════════════════════════════════════════════════════════

describe('parseA2eTag', () => {

  // ─── ApiCall shorthand ───

  describe('ApiCall shorthand', () => {
    it('should parse GET with URL', () => {
      const r = parseA2eTag('ApiCall GET https://httpbin.org/get');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.method).toBe('GET');
      expect(cfg.url).toBe('https://httpbin.org/get');
      expect(cfg.outputPath).toBe('/workflow/result');
      expect(cfg.body).toBeUndefined();
      expect(r.validate).toBe(false);
    });

    it('should parse POST with JSON body', () => {
      const r = parseA2eTag('ApiCall POST https://httpbin.org/post {"name":"John","age":30}');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.method).toBe('POST');
      expect(cfg.url).toBe('https://httpbin.org/post');
      expect(cfg.body).toEqual({ name: 'John', age: 30 });
    });

    it('should parse PUT with body', () => {
      const r = parseA2eTag('ApiCall PUT https://api.example.com/users/1 {"name":"Updated"}');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.method).toBe('PUT');
      expect(cfg.body).toEqual({ name: 'Updated' });
    });

    it('should parse DELETE without body', () => {
      const r = parseA2eTag('ApiCall DELETE https://api.example.com/users/1');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.method).toBe('DELETE');
      expect(cfg.url).toBe('https://api.example.com/users/1');
    });

    it('should ignore body for GET even if provided', () => {
      const r = parseA2eTag('ApiCall GET https://example.com {"ignored":true}');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.method).toBe('GET');
      expect(cfg.body).toBeUndefined();
    });

    it('should handle POST with non-JSON body as string', () => {
      const r = parseA2eTag('ApiCall POST https://example.com plain-text-body');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.body).toBe('plain-text-body');
    });

    it('should handle URL with query params', () => {
      const r = parseA2eTag('ApiCall GET https://api.example.com/search?q=test&limit=10');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.url).toBe('https://api.example.com/search?q=test&limit=10');
    });

    it('should handle URL with port', () => {
      const r = parseA2eTag('ApiCall GET http://localhost:8080/api/v1/data');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.url).toBe('http://localhost:8080/api/v1/data');
    });

    it('should default method to GET if missing', () => {
      const r = parseA2eTag('ApiCall');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.method).toBe('GET');
      expect(cfg.url).toBe('');
    });
  });

  // ─── FilterData shorthand ───

  describe('FilterData shorthand', () => {
    it('should parse numeric comparison', () => {
      const r = parseA2eTag('FilterData /workflow/users age > 18');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.inputPath).toBe('/workflow/users');
      expect(cfg.conditions[0].field).toBe('age');
      expect(cfg.conditions[0].operator).toBe('>');
      expect(cfg.conditions[0].value).toBe(18);
      expect(cfg.outputPath).toBe('/workflow/filtered');
    });

    it('should parse string comparison', () => {
      const r = parseA2eTag('FilterData /workflow/items status == active');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.conditions[0].field).toBe('status');
      expect(cfg.conditions[0].operator).toBe('==');
      expect(cfg.conditions[0].value).toBe('active');
    });

    it('should parse boolean value true', () => {
      const r = parseA2eTag('FilterData /workflow/tasks completed == true');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.conditions[0].value).toBe(true);
    });

    it('should parse boolean value false', () => {
      const r = parseA2eTag('FilterData /workflow/tasks completed == false');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.conditions[0].value).toBe(false);
    });

    it('should parse less-than operator', () => {
      const r = parseA2eTag('FilterData /workflow/products price < 100');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.conditions[0].operator).toBe('<');
      expect(cfg.conditions[0].value).toBe(100);
    });

    it('should default inputPath to /workflow/data', () => {
      const r = parseA2eTag('FilterData');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.inputPath).toBe('/workflow/data');
    });
  });

  // ─── TransformData shorthand ───

  describe('TransformData shorthand', () => {
    it('should parse map with select config', () => {
      const r = parseA2eTag('TransformData /workflow/users map {"select":["name","email"]}');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.inputPath).toBe('/workflow/users');
      expect(cfg.transform).toBe('map');
      expect(cfg.config).toEqual({ select: ['name', 'email'] });
      expect(cfg.outputPath).toBe('/workflow/transformed');
    });

    it('should handle non-JSON config as empty object', () => {
      const r = parseA2eTag('TransformData /workflow/data sort');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.transform).toBe('sort');
      expect(cfg.config).toEqual({});
    });

    it('should default to map transform', () => {
      const r = parseA2eTag('TransformData /workflow/data');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.transform).toBe('map');
    });
  });

  // ─── McpCall shorthand ───

  describe('McpCall shorthand', () => {
    it('should parse tool name with JSON args', () => {
      const r = parseA2eTag('McpCall n8n_list_workflows {}');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.tool).toBe('n8n_list_workflows');
      expect(cfg.args).toEqual({});
      expect(cfg.outputPath).toBe('/workflow/mcp-result');
    });

    it('should parse tool name with complex args', () => {
      const r = parseA2eTag('McpCall read_file {"path":"/tmp/test.txt"}');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.tool).toBe('read_file');
      expect(cfg.args).toEqual({ path: '/tmp/test.txt' });
    });

    it('should handle tool name without args', () => {
      const r = parseA2eTag('McpCall some_tool');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.tool).toBe('some_tool');
      expect(cfg.args).toEqual({});
    });

    it('should set operation type to McpCall', () => {
      const r = parseA2eTag('McpCall my_tool {}');
      const op = getOperation(r.workflow);
      expect(op.McpCall).toBeDefined();
    });
  });

  // ─── MemoryCall shorthand ───

  describe('MemoryCall shorthand', () => {
    it('should parse search action with query', () => {
      const r = parseA2eTag('MemoryCall search weather API endpoint');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.action).toBe('search');
      expect(cfg.query).toBe('weather API endpoint');
      expect(cfg.outputPath).toBe('/workflow/memory-result');
    });

    it('should parse recall action with query', () => {
      const r = parseA2eTag('MemoryCall recall how to use openweathermap');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.action).toBe('recall');
      expect(cfg.query).toBe('how to use openweathermap');
    });

    it('should parse save action with JSON content', () => {
      const r = parseA2eTag('MemoryCall save {"content":"weather API: GET https://api.openweathermap.org","category":"skill","tags":["api"]}');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.action).toBe('save');
      expect(cfg.content).toBe('weather API: GET https://api.openweathermap.org');
      expect(cfg.category).toBe('skill');
      expect(cfg.tags).toEqual(['api']);
    });

    it('should parse save action with plain text content', () => {
      const r = parseA2eTag('MemoryCall save Remember this API pattern');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.action).toBe('save');
      expect(cfg.content).toBe('Remember this API pattern');
    });

    it('should default action to search', () => {
      const r = parseA2eTag('MemoryCall');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.action).toBe('search');
    });

    it('should set operation type to MemoryCall', () => {
      const r = parseA2eTag('MemoryCall search test');
      const op = getOperation(r.workflow);
      expect(op.MemoryCall).toBeDefined();
    });
  });

  // ─── Raw JSONL ───

  describe('Raw JSONL format', () => {
    it('should pass through raw JSON starting with { (with auto-beginExecution)', () => {
      const raw = '{"type":"operationUpdate","operationId":"op-1","operation":{"ApiCall":{"method":"GET","url":"https://example.com","outputPath":"/workflow/r"}}}';
      const r = parseA2eTag(raw);
      // repairWorkflow auto-synthesizes beginExecution, so workflow now has 2 lines
      const lines = r.workflow.split('\n');
      expect(lines.length).toBe(2);
      const op = JSON.parse(lines[0]);
      expect(op.type).toBe('operationUpdate');
      expect(op.operationId).toBe('op-1');
      const begin = JSON.parse(lines[1]);
      expect(begin.type).toBe('beginExecution');
      expect(begin.operationOrder).toEqual(['op-1']);
    });

    it('should pass through multi-line JSONL', () => {
      const raw = '{"type":"operationUpdate","operationId":"op-1","operation":{}}\n{"type":"beginExecution","executionId":"exec-1","operationOrder":["op-1"]}';
      const r = parseA2eTag(raw);
      expect(r.workflow).toBe(raw);
    });

    it('should trim whitespace before detecting format', () => {
      const raw = '  {"type":"operationUpdate"}  ';
      const r = parseA2eTag(raw);
      expect(r.workflow).toBe(raw.trim());
    });
  });

  // ─── Generic/unknown operations ───

  describe('Generic operations', () => {
    it('should pass unknown operation type with JSON args', () => {
      const r = parseA2eTag('CustomOp {"key":"value"}');
      const op = getOperation(r.workflow);
      expect(op.CustomOp).toEqual({ key: 'value' });
    });

    it('should pass unknown operation with non-JSON as empty object', () => {
      const r = parseA2eTag('SomeOp');
      const op = getOperation(r.workflow);
      expect(op.SomeOp).toEqual({});
    });
  });

  // ─── JSONL structure (spec v1.0.0) ───

  describe('JSONL output structure (spec v1.0.0)', () => {
    it('should produce two lines: operationUpdate + beginExecution', () => {
      const r = parseA2eTag('ApiCall GET https://example.com');
      const lines = parseWorkflowLines(r.workflow);
      expect(lines).toHaveLength(2);
      expect(lines[0].type).toBe('operationUpdate');
      expect(lines[1].type).toBe('beginExecution');
    });

    it('should set operationId to op-1', () => {
      const r = parseA2eTag('ApiCall GET https://example.com');
      const lines = parseWorkflowLines(r.workflow);
      expect(lines[0].operationId).toBe('op-1');
    });

    it('should generate executionId with exec- prefix', () => {
      const r = parseA2eTag('ApiCall GET https://example.com');
      const lines = parseWorkflowLines(r.workflow);
      expect(lines[1].executionId).toMatch(/^exec-\d+$/);
    });

    it('should set operationOrder to ["op-1"]', () => {
      const r = parseA2eTag('ApiCall GET https://example.com');
      const lines = parseWorkflowLines(r.workflow);
      expect(lines[1].operationOrder).toEqual(['op-1']);
    });

    it('should have operation as direct property (not nested in array)', () => {
      const r = parseA2eTag('ApiCall GET https://example.com');
      const lines = parseWorkflowLines(r.workflow);
      // Spec: {"type":"operationUpdate","operationId":"op-1","operation":{"ApiCall":{...}}}
      expect(lines[0].operation).toBeDefined();
      expect(lines[0].operation.ApiCall).toBeDefined();
    });
  });

  // ─── Edge cases ───

  describe('Edge cases', () => {
    it('should handle extra whitespace', () => {
      const r = parseA2eTag('  ApiCall   GET   https://example.com  ');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.method).toBe('GET');
      expect(cfg.url).toBe('https://example.com');
    });

    it('should handle POST body with spaces in JSON values', () => {
      const r = parseA2eTag('ApiCall POST https://example.com {"msg":"hello world"}');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.body).toEqual({ msg: 'hello world' });
    });

    it('should handle POST body with nested JSON', () => {
      const r = parseA2eTag('ApiCall POST https://example.com {"user":{"name":"John","tags":["a","b"]}}');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.body).toEqual({ user: { name: 'John', tags: ['a', 'b'] } });
    });

    it('should handle FilterData with multi-word string value', () => {
      const r = parseA2eTag('FilterData /workflow/items name == hello world');
      const cfg = getOperationConfig(r.workflow);
      expect(cfg.conditions[0].value).toBe('hello world');
    });

    it('should handle empty input', () => {
      const r = parseA2eTag('');
      // Should not throw, produces a generic op
      expect(r.workflow).toBeTruthy();
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. executeA2e — Execution against mock server
// ═══════════════════════════════════════════════════════════════

describe('executeA2e', () => {
  let server: http.Server;
  let config: A2eConfig;
  let serverHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      serverHandler(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    config = { url: `http://127.0.0.1:${addr.port}` };
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  // helper: set server behavior
  function setHandler(handler: typeof serverHandler) {
    serverHandler = handler;
  }

  // helper: handler that captures request and returns data
  function captureAndRespond(data: unknown) {
    let captured: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string } | null = null;

    setHandler((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        captured = { method: req.method!, url: req.url!, headers: req.headers, body };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      });
    });

    return () => captured;
  }

  // ─── Endpoint & method ───

  describe('Request routing', () => {
    it('should POST to /api/v1/workflows/execute', async () => {
      const getCaptured = captureAndRespond({ data: { ok: true } });
      const req = parseA2eTag('ApiCall GET https://example.com');
      await executeA2e(req, config);

      const c = getCaptured()!;
      expect(c.method).toBe('POST');
      expect(c.url).toBe('/api/v1/workflows/execute');
    });

    it('should set Content-Type to application/json', async () => {
      const getCaptured = captureAndRespond({ data: {} });
      const req = parseA2eTag('ApiCall GET https://example.com');
      await executeA2e(req, config);

      expect(getCaptured()!.headers['content-type']).toBe('application/json');
    });

    it('should strip trailing slash from config url', async () => {
      const getCaptured = captureAndRespond({ data: {} });
      const req = parseA2eTag('ApiCall GET https://example.com');
      await executeA2e(req, { url: config.url + '/' });

      expect(getCaptured()!.url).toBe('/api/v1/workflows/execute');
    });
  });

  // ─── Request body ───

  describe('Request body', () => {
    it('should send workflow string and validate flag', async () => {
      const getCaptured = captureAndRespond({ data: {} });
      const req = parseA2eTag('ApiCall GET https://example.com');
      await executeA2e(req, config);

      const body = JSON.parse(getCaptured()!.body);
      expect(body).toHaveProperty('workflow');
      expect(body).toHaveProperty('validate', false);
      expect(typeof body.workflow).toBe('string');
    });

    it('should send workflow with spec-compliant operationUpdate and beginExecution', async () => {
      const getCaptured = captureAndRespond({ data: {} });
      const req = parseA2eTag('ApiCall POST https://example.com {"key":"val"}');
      await executeA2e(req, config);

      const body = JSON.parse(getCaptured()!.body);
      const lines = body.workflow.split('\n');
      const opLine = JSON.parse(lines[0]);
      const execLine = JSON.parse(lines[1]);

      // Spec v1.0.0 format
      expect(opLine.type).toBe('operationUpdate');
      expect(opLine.operationId).toBe('op-1');
      expect(opLine.operation.ApiCall.method).toBe('POST');
      expect(opLine.operation.ApiCall.body).toEqual({ key: 'val' });

      expect(execLine.type).toBe('beginExecution');
      expect(execLine.operationOrder).toEqual(['op-1']);
    });

    it('should send raw JSONL when provided', async () => {
      const getCaptured = captureAndRespond({ data: {} });
      const rawWorkflow = '{"type":"operationUpdate","operationId":"op-1","operation":{"ApiCall":{"method":"GET","url":"https://example.com","outputPath":"/workflow/r"}}}';
      const req: A2eWorkflowRequest = { workflow: rawWorkflow, validate: true };
      await executeA2e(req, config);

      const body = JSON.parse(getCaptured()!.body);
      expect(body.workflow).toBe(rawWorkflow);
    });

    it('should default validate to true when undefined', async () => {
      const getCaptured = captureAndRespond({ data: {} });
      const req: A2eWorkflowRequest = { workflow: '{}' };
      await executeA2e(req, config);

      const body = JSON.parse(getCaptured()!.body);
      expect(body.validate).toBe(true);
    });
  });

  // ─── Authentication ───

  describe('Authentication', () => {
    it('should send X-API-Key header when apiKey configured', async () => {
      const getCaptured = captureAndRespond({ data: {} });
      const req = parseA2eTag('ApiCall GET https://example.com');
      await executeA2e(req, { ...config, apiKey: 'my-secret-key' });

      expect(getCaptured()!.headers['x-api-key']).toBe('my-secret-key');
    });

    it('should NOT send X-API-Key header when apiKey not configured', async () => {
      const getCaptured = captureAndRespond({ data: {} });
      const req = parseA2eTag('ApiCall GET https://example.com');
      await executeA2e(req, config);

      expect(getCaptured()!.headers['x-api-key']).toBeUndefined();
    });

    it('should send empty string apiKey as header', async () => {
      const getCaptured = captureAndRespond({ data: {} });
      const req = parseA2eTag('ApiCall GET https://example.com');
      await executeA2e(req, { ...config, apiKey: '' });

      // empty string is falsy, so no header
      expect(getCaptured()!.headers['x-api-key']).toBeUndefined();
    });
  });

  // ─── Response handling ───

  describe('Response handling', () => {
    it('should extract results field from spec-compliant response', async () => {
      captureAndRespond({ results: { 'op-1': { status: 200, data: { users: ['Alice'] } } } });
      const req = parseA2eTag('ApiCall GET https://example.com');
      const result = await executeA2e(req, config);

      const parsed = JSON.parse(result);
      expect(parsed['op-1'].data.users).toEqual(['Alice']);
    });

    it('should extract data field from legacy response', async () => {
      captureAndRespond({ data: { users: [{ name: 'Alice' }] } });
      const req = parseA2eTag('ApiCall GET https://example.com');
      const result = await executeA2e(req, config);

      const parsed = JSON.parse(result);
      expect(parsed.users).toEqual([{ name: 'Alice' }]);
    });

    it('should prefer results over data when both present', async () => {
      captureAndRespond({
        results: { 'op-1': { value: 42 } },
        data: { value: 99 },
      });
      const req = parseA2eTag('ApiCall GET https://example.com');
      const result = await executeA2e(req, config);

      const parsed = JSON.parse(result);
      expect(parsed['op-1'].value).toBe(42);
    });

    it('should format A2E error from error field', async () => {
      captureAndRespond({ error: { message: 'Workflow not found' } });
      const req = parseA2eTag('ApiCall GET https://example.com');
      const result = await executeA2e(req, config);

      expect(result).toBe('A2E Error: Workflow not found');
    });

    it('should format A2E error without message', async () => {
      captureAndRespond({ error: { code: 'NOT_FOUND', details: 'missing' } });
      const req = parseA2eTag('ApiCall GET https://example.com');
      const result = await executeA2e(req, config);

      expect(result).toContain('A2E Error:');
      expect(result).toContain('NOT_FOUND');
    });

    it('should return raw text for non-JSON response', async () => {
      setHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('plain text result');
      });

      const req = parseA2eTag('ApiCall GET https://example.com');
      const result = await executeA2e(req, config);

      expect(result).toBe('plain text result');
    });

    it('should return full response when no results, data, or error field', async () => {
      captureAndRespond({ status: 'ok', count: 42 });
      const req = parseA2eTag('ApiCall GET https://example.com');
      const result = await executeA2e(req, config);

      expect(result).toBe('{"status":"ok","count":42}');
    });

    it('should handle empty response body', async () => {
      setHandler((_req, res) => {
        res.writeHead(200);
        res.end('');
      });

      const req = parseA2eTag('ApiCall GET https://example.com');
      const result = await executeA2e(req, config);

      expect(result).toBe('');
    });

    it('should handle HTTP error status codes without throwing', async () => {
      setHandler((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Internal Server Error' } }));
      });

      const req = parseA2eTag('ApiCall GET https://example.com');
      const result = await executeA2e(req, config);

      expect(result).toBe('A2E Error: Internal Server Error');
    });

    it('should handle 404 with data field', async () => {
      setHandler((_req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: null }));
      });

      const req = parseA2eTag('ApiCall GET https://example.com');
      const result = await executeA2e(req, config);

      // data is null, so falls through to raw text
      expect(result).toBe('{"data":null}');
    });
  });

  // ─── Truncation ───

  describe('Truncation', () => {
    it('should truncate response longer than A2E_MAX_RESULT_CHARS', async () => {
      const longData = { data: { payload: 'x'.repeat(3000) } };
      captureAndRespond(longData);

      const req = parseA2eTag('ApiCall GET https://example.com');
      const result = await executeA2e(req, config);

      expect(result.length).toBeLessThanOrEqual(A2E_MAX_RESULT_CHARS + 20); // +margin for suffix
      expect(result).toContain('... [truncated]');
    });

    it('should NOT truncate response within limit', async () => {
      captureAndRespond({ data: { short: 'ok' } });

      const req = parseA2eTag('ApiCall GET https://example.com');
      const result = await executeA2e(req, config);

      expect(result).not.toContain('[truncated]');
    });

    it('should truncate raw text responses too', async () => {
      setHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('y'.repeat(3000));
      });

      const req = parseA2eTag('ApiCall GET https://example.com');
      const result = await executeA2e(req, config);

      expect(result).toContain('... [truncated]');
    });
  });

  // ─── Localhost access ───

  describe('Localhost access (unlike FETCH)', () => {
    it('should allow connections to localhost', async () => {
      captureAndRespond({ data: { local: true } });

      const req = parseA2eTag('ApiCall GET http://localhost:9999/api');
      // executeA2e connects to the config.url, not the ApiCall URL
      // The ApiCall URL is part of the workflow, not the connection target
      const result = await executeA2e(req, config);

      const parsed = JSON.parse(result);
      expect(parsed.local).toBe(true);
    });

    it('should allow connections to 127.0.0.1', async () => {
      captureAndRespond({ data: { loopback: true } });

      const req = parseA2eTag('ApiCall GET https://example.com');
      const result = await executeA2e(req, { url: `http://127.0.0.1:${(server.address() as { port: number }).port}` });

      const parsed = JSON.parse(result);
      expect(parsed.loopback).toBe(true);
    });
  });

  // ─── Error handling ───

  describe('Error handling', () => {
    it('should throw on connection refused', async () => {
      const req = parseA2eTag('ApiCall GET https://example.com');
      await expect(
        executeA2e(req, { url: 'http://127.0.0.1:1' })
      ).rejects.toThrow('A2E request failed');
    });

    it('should throw on invalid URL', async () => {
      const req = parseA2eTag('ApiCall GET https://example.com');
      await expect(
        executeA2e(req, { url: 'not-a-url' })
      ).rejects.toThrow('A2E request failed');
    });

    it('should throw on timeout', async () => {
      setHandler((_req, _res) => {
        // Never respond — let it hang
      });

      const req = parseA2eTag('ApiCall GET https://example.com');

      // Use a short timeout to avoid slow tests — mock the constant behavior
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 100);

      try {
        await expect(
          fetch(`${config.url}/api/v1/workflows/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workflow: req.workflow, validate: true }),
            signal: controller.signal,
          })
        ).rejects.toThrow();
      } finally {
        clearTimeout(timeoutId);
      }
    });

    it('should include error message in thrown error', async () => {
      const req = parseA2eTag('ApiCall GET https://example.com');
      try {
        await executeA2e(req, { url: 'http://127.0.0.1:1' });
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as Error).message).toMatch(/A2E request failed:/);
      }
    });
  });

  // ─── Full end-to-end flows ───

  describe('End-to-end flows', () => {
    it('E2E: ApiCall GET → server receives spec-compliant workflow → returns data', async () => {
      let receivedWorkflow = '';
      setHandler((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body);
          receivedWorkflow = parsed.workflow;

          // Simulate: server parses spec-compliant workflow
          const lines = receivedWorkflow.split('\n');
          const opLine = JSON.parse(lines[0]);
          const apiCall = opLine.operation.ApiCall;

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            results: {
              'op-1': {
                url: apiCall.url,
                method: apiCall.method,
                headers: { 'User-Agent': 'a2e-server/1.0' },
                response: { ip: '1.2.3.4' },
              },
            },
          }));
        });
      });

      const req = parseA2eTag('ApiCall GET https://httpbin.org/get');
      const result = await executeA2e(req, config);
      const parsed = JSON.parse(result);

      expect(parsed['op-1'].url).toBe('https://httpbin.org/get');
      expect(parsed['op-1'].method).toBe('GET');
      expect(parsed['op-1'].response.ip).toBe('1.2.3.4');

      // Verify workflow was correctly structured (spec v1.0.0)
      const wfLines = receivedWorkflow.split('\n');
      expect(wfLines).toHaveLength(2);
      const opLine = JSON.parse(wfLines[0]);
      expect(opLine.type).toBe('operationUpdate');
      expect(opLine.operationId).toBe('op-1');
    });

    it('E2E: ApiCall POST with body → server receives body → returns created resource', async () => {
      setHandler((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body);
          const wfLines = parsed.workflow.split('\n');
          const opLine = JSON.parse(wfLines[0]);
          const apiCall = opLine.operation.ApiCall;

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              id: 42,
              ...apiCall.body,
              created: true,
            },
          }));
        });
      });

      const req = parseA2eTag('ApiCall POST https://api.example.com/users {"name":"Alice","email":"alice@example.com"}');
      const result = await executeA2e(req, config);
      const parsed = JSON.parse(result);

      expect(parsed.id).toBe(42);
      expect(parsed.name).toBe('Alice');
      expect(parsed.email).toBe('alice@example.com');
      expect(parsed.created).toBe(true);
    });

    it('E2E: FilterData → server filters and returns subset', async () => {
      setHandler((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body);
          const wfLines = parsed.workflow.split('\n');
          const opLine = JSON.parse(wfLines[0]);
          const filter = opLine.operation.FilterData;

          // Simulate filtering
          const allUsers = [
            { name: 'Alice', age: 25 },
            { name: 'Bob', age: 15 },
            { name: 'Charlie', age: 30 },
            { name: 'Dave', age: 12 },
          ];

          const threshold = filter.conditions[0].value;
          const filtered = allUsers.filter(u => u.age > threshold);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { results: filtered, count: filtered.length } }));
        });
      });

      const req = parseA2eTag('FilterData /workflow/users age > 18');
      const result = await executeA2e(req, config);
      const parsed = JSON.parse(result);

      expect(parsed.count).toBe(2);
      expect(parsed.results).toEqual([
        { name: 'Alice', age: 25 },
        { name: 'Charlie', age: 30 },
      ]);
    });

    it('E2E: TransformData → server transforms and returns result', async () => {
      setHandler((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body);
          const wfLines = parsed.workflow.split('\n');
          const opLine = JSON.parse(wfLines[0]);
          const transform = opLine.operation.TransformData;

          // Simulate: select only specified fields
          const users = [
            { name: 'Alice', email: 'a@b.com', age: 25, role: 'admin' },
            { name: 'Bob', email: 'b@b.com', age: 30, role: 'user' },
          ];

          const selectFields = transform.config.select;
          const mapped = users.map(u => {
            const out: Record<string, unknown> = {};
            for (const f of selectFields) out[f] = (u as Record<string, unknown>)[f];
            return out;
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: mapped }));
        });
      });

      const req = parseA2eTag('TransformData /workflow/users map {"select":["name","email"]}');
      const result = await executeA2e(req, config);
      const parsed = JSON.parse(result);

      expect(parsed).toEqual([
        { name: 'Alice', email: 'a@b.com' },
        { name: 'Bob', email: 'b@b.com' },
      ]);
    });

    it('E2E: Server returns error → formatted as A2E Error', async () => {
      setHandler((_req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: 'Invalid workflow: missing beginExecution' },
        }));
      });

      const req = parseA2eTag('ApiCall GET https://example.com');
      const result = await executeA2e(req, config);

      expect(result).toBe('A2E Error: Invalid workflow: missing beginExecution');
    });

    it('E2E: Auth flow → API key sent → server validates', async () => {
      setHandler((req, res) => {
        const apiKey = req.headers['x-api-key'];
        if (apiKey !== 'valid-key') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
          return;
        }

        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { authenticated: true } }));
        });
      });

      // Without key → error
      const req1 = parseA2eTag('ApiCall GET https://example.com');
      const result1 = await executeA2e(req1, config);
      expect(result1).toBe('A2E Error: Unauthorized');

      // With wrong key → error
      const result2 = await executeA2e(req1, { ...config, apiKey: 'wrong-key' });
      expect(result2).toBe('A2E Error: Unauthorized');

      // With correct key → success
      const result3 = await executeA2e(req1, { ...config, apiKey: 'valid-key' });
      const parsed = JSON.parse(result3);
      expect(parsed.authenticated).toBe(true);
    });

    it('E2E: Large response → truncated correctly', async () => {
      setHandler((_req, res) => {
        const bigArray = Array.from({ length: 500 }, (_, i) => ({
          id: i,
          name: `User ${i}`,
          email: `user${i}@example.com`,
          bio: `This is the biography of user ${i} which is intentionally verbose.`,
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: bigArray }));
      });

      const req = parseA2eTag('ApiCall GET https://example.com/users');
      const result = await executeA2e(req, config);

      expect(result).toContain('... [truncated]');
      expect(result.length).toBeLessThanOrEqual(A2E_MAX_RESULT_CHARS + 20);
    });

    it('E2E: Raw JSONL workflow → server receives as-is', async () => {
      let receivedWorkflow = '';
      setHandler((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
          receivedWorkflow = JSON.parse(body).workflow;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { received: true } }));
        });
      });

      const rawWorkflow = '{"type":"operationUpdate","operationId":"step-1","operation":{"ApiCall":{"method":"GET","url":"https://api.github.com/users/octocat","outputPath":"/workflow/result"}}}\n{"type":"beginExecution","executionId":"exec-1","operationOrder":["step-1"]}';
      const req: A2eWorkflowRequest = { workflow: rawWorkflow, validate: false };
      await executeA2e(req, config);

      expect(receivedWorkflow).toBe(rawWorkflow);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Constants
// ═══════════════════════════════════════════════════════════════

describe('A2E constants', () => {
  it('should have 30s timeout', () => {
    expect(A2E_TIMEOUT_MS).toBe(30_000);
  });

  it('should have 2048 char max result', () => {
    expect(A2E_MAX_RESULT_CHARS).toBe(2048);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Secret handling
// ═══════════════════════════════════════════════════════════════

describe('resolveSecrets', () => {
  it('should replace {{VAR}} placeholders with secret values', () => {
    const result = resolveSecrets(
      'ApiCall GET https://api.weather.com?appid={{WEATHER_KEY}}&city=Madrid',
      { WEATHER_KEY: 'abc123' },
    );
    expect(result).toBe('ApiCall GET https://api.weather.com?appid=abc123&city=Madrid');
  });

  it('should handle multiple placeholders', () => {
    const result = resolveSecrets(
      'ApiCall POST https://{{HOST}}/api?key={{API_KEY}}',
      { HOST: 'example.com', API_KEY: 'secret-key-42' },
    );
    expect(result).toBe('ApiCall POST https://example.com/api?key=secret-key-42');
  });

  it('should leave unknown placeholders as-is', () => {
    const result = resolveSecrets(
      'ApiCall GET https://api.example.com?key={{UNKNOWN}}',
      { WEATHER_KEY: 'abc123' },
    );
    expect(result).toContain('{{UNKNOWN}}');
  });

  it('should return text unchanged when secrets map is empty', () => {
    const text = 'ApiCall GET https://api.example.com?key={{KEY}}';
    expect(resolveSecrets(text, {})).toBe(text);
  });

  it('should handle empty text', () => {
    expect(resolveSecrets('', { KEY: 'val' })).toBe('');
  });
});

describe('sanitizeSecrets', () => {
  it('should replace known secret values with {{VAR}} placeholders', () => {
    const result = sanitizeSecrets(
      'ApiCall GET https://api.weather.com?appid=abc123&city=Madrid',
      { WEATHER_KEY: 'abc123' },
    );
    expect(result).toContain('{{WEATHER_KEY}}');
    expect(result).not.toContain('abc123');
  });

  it('should redact common auth query params heuristically', () => {
    const result = sanitizeSecrets(
      'ApiCall GET https://api.example.com?apiKey=xyz789&city=Madrid',
      {},
    );
    expect(result).toContain('{{APIKEY}}');
    expect(result).not.toContain('xyz789');
    expect(result).toContain('city=Madrid');
  });

  it('should redact multiple sensitive params', () => {
    const result = sanitizeSecrets(
      'ApiCall GET https://api.example.com?token=secret1&appid=secret2&q=test',
      {},
    );
    expect(result).toContain('{{TOKEN}}');
    expect(result).toContain('{{APPID}}');
    expect(result).toContain('q=test');
  });

  it('should not redact already-placeholder values', () => {
    const result = sanitizeSecrets(
      'ApiCall GET https://api.example.com?apiKey={{MY_KEY}}&city=Madrid',
      {},
    );
    expect(result).toContain('{{MY_KEY}}');
    // Should NOT double-wrap
    expect(result).not.toContain('{{APIKEY}}');
  });

  it('should prefer known secrets over heuristic redaction', () => {
    const result = sanitizeSecrets(
      'ApiCall GET https://api.example.com?apiKey=my-secret-key-1234',
      { MY_API: 'my-secret-key-1234' },
    );
    // Known secret replaced first — value is now {{MY_API}}, no longer matches heuristic
    expect(result).toContain('{{MY_API}}');
  });

  it('should handle secrets in POST body', () => {
    const result = sanitizeSecrets(
      'ApiCall POST https://api.example.com {"auth":"bearer-token-abc123"}',
      { AUTH_TOKEN: 'bearer-token-abc123' },
    );
    expect(result).toContain('{{AUTH_TOKEN}}');
    expect(result).not.toContain('bearer-token-abc123');
  });

  it('should not match trivially short secret values (< 4 chars)', () => {
    const result = sanitizeSecrets(
      'ApiCall GET https://api.example.com?key=abc',
      { SHORT: 'abc' },
    );
    // 'abc' is too short — should not be replaced as known secret
    // But heuristic should still redact the 'key' param
    expect(result).not.toContain('{{SHORT}}');
  });

  it('should sanitize secrets in raw JSONL workflows', () => {
    const jsonl = '{"type":"operationUpdate","operationId":"op-1","operation":{"ApiCall":{"method":"GET","url":"https://api.example.com?token=super-secret-key"}}}';
    const result = sanitizeSecrets(jsonl, { MY_TOKEN: 'super-secret-key' });
    expect(result).toContain('{{MY_TOKEN}}');
    expect(result).not.toContain('super-secret-key');
  });

  it('should handle text with no URLs or secrets', () => {
    const text = 'FilterData /workflow/users age > 18';
    expect(sanitizeSecrets(text, {})).toBe(text);
    expect(sanitizeSecrets(text, { KEY: 'value123' })).toBe(text);
  });
});
