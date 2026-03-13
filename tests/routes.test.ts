import { describe, it, expect, vi } from 'vitest';
import { handleRoute, type RouteContext } from '../src/server/routes.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig } from '../src/config.js';

/** Create a mock IncomingMessage */
function mockRequest(method: string, url: string, body?: string): IncomingMessage {
  const req = {
    method,
    url,
    headers: { host: 'localhost:3333' },
    on: vi.fn((event: string, handler: (data?: unknown) => void) => {
      if (event === 'data' && body) {
        handler(Buffer.from(body));
      }
      if (event === 'end') {
        handler();
      }
    }),
    destroy: vi.fn(),
  } as unknown as IncomingMessage;
  return req;
}

/** Create a mock ServerResponse that captures output */
function mockResponse(): ServerResponse & { _status: number; _body: string; _headers: Record<string, string> } {
  const res = {
    _status: 200,
    _body: '',
    _headers: {} as Record<string, string>,
    writeHead: vi.fn(function (this: { _status: number; _headers: Record<string, string> }, status: number, headers?: Record<string, string>) {
      this._status = status;
      if (headers) Object.assign(this._headers, headers);
    }),
    end: vi.fn(function (this: { _body: string }, data?: string) {
      if (data) this._body = data;
    }),
    write: vi.fn(),
    headersSent: false,
  } as unknown as ServerResponse & { _status: number; _body: string; _headers: Record<string, string> };
  return res;
}

/** Create a mock RouteContext */
function mockContext(overrides?: Partial<RouteContext>): RouteContext {
  return {
    agent: {
      run: vi.fn().mockResolvedValue({ content: 'Agent response', sessionId: 'sess-1' }),
      runStream: vi.fn(),
    },
    memory: {
      recall: vi.fn().mockReturnValue({ formatted: '', totalItems: 0, estimatedChars: 0 }),
      saveSession: vi.fn().mockReturnValue('session-123'),
      healthCheck: vi.fn().mockReturnValue(true),
      stats: vi.fn().mockReturnValue({ memories: 5, sessions: 3 }),
      getHistory: vi.fn().mockReturnValue([]),
      getSession: vi.fn().mockReturnValue(null),
      exportMemories: vi.fn().mockReturnValue({ version: 1, memories: [], count: 0 }),
      importMemories: vi.fn().mockReturnValue({ imported: 0, errors: 0, skills: 0 }),
    },
    inference: {
      healthCheck: vi.fn().mockResolvedValue(true),
    },
    config: loadConfig(),
    ...overrides,
  } as unknown as RouteContext;
}

describe('Routes', () => {
  describe('GET /v1/config', () => {
    it('should return current config defaults', async () => {
      const ctx = mockContext();
      const req = mockRequest('GET', '/v1/config');
      const res = mockResponse();

      const handled = await handleRoute(req, res, ctx);

      expect(handled).toBe(true);
      expect(res._status).toBe(200);

      const body = JSON.parse(res._body);
      expect(body.temperature).toBe(0.7);
      expect(body.maxTokens).toBe(512);
      expect(body.topP).toBe(0.9);
      expect(body.contextSize).toBe(4096);
      expect(body.recallLimit).toBe(5);
      expect(body.thinkingMode).toBe(false);
      expect(body.modelName).toBeDefined();
    });
  });

  describe('GET /v1/models/available', () => {
    it('should return models list', async () => {
      const ctx = mockContext();
      const req = mockRequest('GET', '/v1/models/available');
      const res = mockResponse();

      const handled = await handleRoute(req, res, ctx);

      expect(handled).toBe(true);
      expect(res._status).toBe(200);

      const body = JSON.parse(res._body);
      expect(body.models).toBeDefined();
      expect(Array.isArray(body.models)).toBe(true);
      expect(body.modelsDir).toBeDefined();
    });
  });

  describe('POST /v1/models/switch', () => {
    it('should reject empty body', async () => {
      const ctx = mockContext();
      const req = mockRequest('POST', '/v1/models/switch');
      const res = mockResponse();

      const handled = await handleRoute(req, res, ctx);

      expect(handled).toBe(true);
      expect(res._status).toBe(400);
    });

    it('should reject missing modelPath', async () => {
      const ctx = mockContext();
      const req = mockRequest('POST', '/v1/models/switch', JSON.stringify({}));
      const res = mockResponse();

      const handled = await handleRoute(req, res, ctx);

      expect(handled).toBe(true);
      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error.message).toContain('modelPath');
    });

    it('should reject non-existent model', async () => {
      const ctx = mockContext();
      const req = mockRequest('POST', '/v1/models/switch', JSON.stringify({ modelPath: '/nonexistent/model.gguf' }));
      const res = mockResponse();

      const handled = await handleRoute(req, res, ctx);

      expect(handled).toBe(true);
      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error.message).toContain('not found');
    });
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const ctx = mockContext();
      const req = mockRequest('GET', '/health');
      const res = mockResponse();

      const handled = await handleRoute(req, res, ctx);

      expect(handled).toBe(true);
      expect(res._status).toBe(200);

      const body = JSON.parse(res._body);
      expect(body.status).toBe('ok');
      expect(body.memory).toBe('ok');
      expect(body.inference).toBe('running');
      expect(body.stats).toBeDefined();
    });

    it('should report degraded when memory is unhealthy', async () => {
      const ctx = mockContext();
      (ctx.memory.healthCheck as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const req = mockRequest('GET', '/health');
      const res = mockResponse();

      await handleRoute(req, res, ctx);

      const body = JSON.parse(res._body);
      expect(body.status).toBe('degraded');
      expect(body.memory).toBe('error');
    });
  });

  describe('POST /v1/chat/completions', () => {
    it('should reject empty body', async () => {
      const ctx = mockContext();
      const req = mockRequest('POST', '/v1/chat/completions');
      const res = mockResponse();

      const handled = await handleRoute(req, res, ctx);

      expect(handled).toBe(true);
      expect(res._status).toBe(400);
    });

    it('should reject invalid JSON', async () => {
      const ctx = mockContext();
      const req = mockRequest('POST', '/v1/chat/completions', 'not json');
      const res = mockResponse();

      await handleRoute(req, res, ctx);

      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error.message).toContain('Invalid JSON');
    });

    it('should reject missing messages', async () => {
      const ctx = mockContext();
      const req = mockRequest('POST', '/v1/chat/completions', JSON.stringify({}));
      const res = mockResponse();

      await handleRoute(req, res, ctx);

      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error.message).toContain('messages');
    });

    it('should reject messages without role', async () => {
      const ctx = mockContext();
      const req = mockRequest('POST', '/v1/chat/completions', JSON.stringify({
        messages: [{ content: 'hello' }],
      }));
      const res = mockResponse();

      await handleRoute(req, res, ctx);

      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error.message).toContain('role');
    });

    it('should reject messages without content', async () => {
      const ctx = mockContext();
      const req = mockRequest('POST', '/v1/chat/completions', JSON.stringify({
        messages: [{ role: 'user' }],
      }));
      const res = mockResponse();

      await handleRoute(req, res, ctx);

      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error.message).toContain('content');
    });

    it('should process valid non-streaming request', async () => {
      const ctx = mockContext();
      const req = mockRequest('POST', '/v1/chat/completions', JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
      }));
      const res = mockResponse();

      await handleRoute(req, res, ctx);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.choices[0].message.content).toBe('Agent response');
      expect(body.choices[0].finish_reason).toBe('stop');
    });

    it('should pass per-request overrides to agent', async () => {
      const ctx = mockContext();
      const req = mockRequest('POST', '/v1/chat/completions', JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.5,
        max_tokens: 1024,
        top_p: 0.8,
        system_prompt: 'Be concise',
      }));
      const res = mockResponse();

      await handleRoute(req, res, ctx);

      const agentCall = (ctx.agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(agentCall.temperature).toBe(0.5);
      expect(agentCall.maxTokens).toBe(1024);
      expect(agentCall.topP).toBe(0.8);
      expect(agentCall.systemPrompt).toBe('Be concise');
    });
  });

  describe('unhandled routes', () => {
    it('should return false for unknown routes', async () => {
      const ctx = mockContext();
      const req = mockRequest('GET', '/unknown');
      const res = mockResponse();

      const handled = await handleRoute(req, res, ctx);
      expect(handled).toBe(false);
    });
  });

  describe('GET /v1/models', () => {
    it('should return current model', async () => {
      const ctx = mockContext();
      const req = mockRequest('GET', '/v1/models');
      const res = mockResponse();

      await handleRoute(req, res, ctx);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.object).toBe('list');
      expect(body.data).toHaveLength(1);
      expect(body.data[0].owned_by).toBe('local');
    });
  });

  describe('memory endpoints', () => {
    it('GET /v1/memories/export should return exported data', async () => {
      const ctx = mockContext();
      const req = mockRequest('GET', '/v1/memories/export');
      const res = mockResponse();

      await handleRoute(req, res, ctx);

      expect(res._status).toBe(200);
      expect(ctx.memory.exportMemories).toHaveBeenCalled();
    });

    it('POST /v1/memories/import should reject invalid format', async () => {
      const ctx = mockContext();
      const req = mockRequest('POST', '/v1/memories/import', JSON.stringify({ foo: 'bar' }));
      const res = mockResponse();

      await handleRoute(req, res, ctx);

      expect(res._status).toBe(400);
      expect(JSON.parse(res._body).error.message).toContain('version');
    });

    it('POST /v1/memories/import should accept valid format', async () => {
      const ctx = mockContext();
      const req = mockRequest('POST', '/v1/memories/import', JSON.stringify({
        version: 1,
        memories: [{ content: 'test', category: 'fact', tags: [] }],
      }));
      const res = mockResponse();

      await handleRoute(req, res, ctx);

      expect(res._status).toBe(200);
      expect(ctx.memory.importMemories).toHaveBeenCalled();
    });
  });
});
