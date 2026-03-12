import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentLoop } from '../agent/loop.js';
import type { MemoryProvider } from '../memory/provider.js';
import type { InferenceManager } from '../inference/manager.js';
import type { MicroExpertConfig } from '../config.js';

export interface RouteContext {
  agent: AgentLoop;
  memory: MemoryProvider;
  inference: InferenceManager;
  config: MicroExpertConfig;
}

/**
 * Handle API routes. Returns true if the route was handled, false otherwise.
 */
export async function handleRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // Health check
  if (path === '/health' && method === 'GET') {
    return handleHealth(res, ctx);
  }

  // Chat completions (OpenAI-compatible)
  if (path === '/v1/chat/completions' && method === 'POST') {
    return handleChatCompletion(req, res, ctx);
  }

  // Models list
  if (path === '/v1/models' && method === 'GET') {
    return handleModels(res, ctx);
  }

  // Conversation history
  if (path === '/history' && method === 'GET') {
    return handleHistoryList(res, ctx, url);
  }

  // Specific session
  if (path.startsWith('/history/') && method === 'GET') {
    const sessionId = path.slice('/history/'.length);
    return handleHistoryGet(res, ctx, sessionId);
  }

  // Memory export
  if (path === '/v1/memories/export' && method === 'GET') {
    return handleMemoryExport(res, ctx, url);
  }

  // Memory import
  if (path === '/v1/memories/import' && method === 'POST') {
    return handleMemoryImport(req, res, ctx, url);
  }

  return false; // Not handled
}

// --- Route handlers ---

async function handleHealth(res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const memoryOk = ctx.memory.healthCheck();
  const inferenceOk = await ctx.inference.healthCheck();

  const status = {
    status: memoryOk ? 'ok' : 'degraded',
    memory: memoryOk ? 'ok' : 'error',
    inference: inferenceOk ? 'running' : 'stopped',
    stats: ctx.memory.stats(),
  };

  sendJson(res, status);
  return true;
}

async function handleChatCompletion(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const body = await readBody(req);
  if (!body) {
    sendError(res, 400, 'Empty request body');
    return true;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendError(res, 400, 'Invalid JSON');
    return true;
  }

  const messages = parsed.messages as Array<{ role: string; content: string }> | undefined;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    sendError(res, 400, 'messages array is required and must not be empty');
    return true;
  }

  // Extract the last user message
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) {
    sendError(res, 400, 'No user message found');
    return true;
  }

  const userId = (parsed.user as string) ?? ctx.config.defaultUserId;
  const stream = parsed.stream === true;

  // Build history from previous messages (exclude the last user message)
  const history = messages.slice(0, -1).filter(m => m.role === 'user' || m.role === 'assistant');

  const request = {
    message: lastUserMsg.content,
    userId,
    history,
    image: parsed.image as string | undefined,
  };

  if (stream) {
    // SSE streaming
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const id = `chatcmpl-${Date.now()}`;

    // Timeout SSE connections after 5 minutes of inactivity
    const SSE_TIMEOUT_MS = 5 * 60 * 1000;
    let sseTimer = setTimeout(() => res.end(), SSE_TIMEOUT_MS);
    const resetSseTimer = () => {
      clearTimeout(sseTimer);
      sseTimer = setTimeout(() => res.end(), SSE_TIMEOUT_MS);
    };

    try {
      for await (const delta of ctx.agent.runStream(request)) {
        resetSseTimer();
        const chunk = {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          choices: [{
            index: 0,
            delta: delta.content ? { content: delta.content } : {},
            finish_reason: delta.finishReason ?? null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
    } catch (e) {
      const errChunk = { error: { message: (e as Error).message } };
      res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
    }

    clearTimeout(sseTimer);
    res.end();
  } else {
    // Non-streaming
    try {
      const result = await ctx.agent.run(request);
      const response = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        choices: [{
          index: 0,
          message: { role: 'assistant', content: result.content },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      sendJson(res, response);
    } catch (e) {
      sendError(res, 500, (e as Error).message);
    }
  }

  return true;
}

async function handleModels(res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const modelName = ctx.config.modelPath.split(/[/\\]/).pop() ?? 'unknown';
  sendJson(res, {
    object: 'list',
    data: [{
      id: modelName,
      object: 'model',
      owned_by: 'local',
    }],
  });
  return true;
}

async function handleHistoryList(
  res: ServerResponse,
  ctx: RouteContext,
  url: URL,
): Promise<boolean> {
  const userId = url.searchParams.get('userId') ?? ctx.config.defaultUserId;
  const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
  const sessions = ctx.memory.getHistory(userId, limit);
  sendJson(res, { sessions });
  return true;
}

async function handleHistoryGet(
  res: ServerResponse,
  ctx: RouteContext,
  sessionId: string,
): Promise<boolean> {
  const session = ctx.memory.getSession(sessionId);
  if (!session) {
    sendError(res, 404, 'Session not found');
    return true;
  }
  sendJson(res, session);
  return true;
}

async function handleMemoryExport(
  res: ServerResponse,
  ctx: RouteContext,
  url: URL,
): Promise<boolean> {
  const userId = url.searchParams.get('userId') ?? ctx.config.defaultUserId;

  try {
    const exported = ctx.memory.exportMemories(userId);

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="memories-${userId}.json"`,
    });
    res.end(JSON.stringify(exported, null, 2));
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }

  return true;
}

async function handleMemoryImport(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  url: URL,
): Promise<boolean> {
  const userId = url.searchParams.get('userId') ?? ctx.config.defaultUserId;

  const body = await readBody(req);
  if (!body) {
    sendError(res, 400, 'Empty request body');
    return true;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body);
  } catch {
    sendError(res, 400, 'Invalid JSON');
    return true;
  }

  // Validate required fields before passing to importMemories
  if (typeof data.version !== 'number' || !Array.isArray(data.memories)) {
    sendError(res, 400, 'Invalid import format: requires "version" (number) and "memories" (array)');
    return true;
  }

  try {
    const result = ctx.memory.importMemories(userId, data as unknown as import('../memory/provider.js').MemoryExportFile);
    sendJson(res, result);
  } catch (e) {
    sendError(res, 400, (e as Error).message);
  }

  return true;
}

// --- Helpers ---

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_BYTES) {
        req.destroy(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, { error: { message } }, status);
}
