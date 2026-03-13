import { describe, it, expect, vi, beforeEach } from 'vitest';
import { splitMessage } from '../src/telegram/bot.js';
import { TelegramBot } from '../src/telegram/bot.js';
import type { AgentLoop } from '../src/agent/loop.js';

// Mock node:https to prevent real network calls
vi.mock('node:https', () => {
  return {
    default: {
      request: vi.fn(),
      get: vi.fn(),
    },
  };
});

import https from 'node:https';

/** Create a mock agent */
function mockAgent(response = 'Hello from agent'): AgentLoop {
  return {
    run: vi.fn().mockResolvedValue({ content: response, sessionId: 'sess-1' }),
    runStream: vi.fn(),
  } as unknown as AgentLoop;
}

/** Simulate an https.request that returns a JSON response */
function mockApiResponse(responseBody: Record<string, unknown>): void {
  const mockReq = {
    on: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  };

  (https.request as ReturnType<typeof vi.fn>).mockImplementation(
    (_opts: unknown, callback: (res: unknown) => void) => {
      const mockRes = {
        on: vi.fn((event: string, handler: (data?: unknown) => void) => {
          if (event === 'data') {
            handler(Buffer.from(JSON.stringify(responseBody)));
          }
          if (event === 'end') {
            handler();
          }
        }),
      };
      // Call the callback asynchronously to match real behavior
      process.nextTick(() => callback(mockRes));
      return mockReq;
    },
  );
}

describe('splitMessage', () => {
  it('should return single chunk for short text', () => {
    expect(splitMessage('hello', 4096)).toEqual(['hello']);
  });

  it('should return single chunk for text exactly at limit', () => {
    const text = 'a'.repeat(4096);
    expect(splitMessage(text, 4096)).toEqual([text]);
  });

  it('should split at newline boundaries', () => {
    const line = 'a'.repeat(50);
    // Create text with newlines, total > 100
    const text = `${line}\n${line}\n${line}`;
    const chunks = splitMessage(text, 100);
    // Should split at newlines, not mid-word
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Reassembled content should match original (accounting for removed newlines at split points)
    const rejoined = chunks.join('\n');
    expect(rejoined).toBe(text);
  });

  it('should hard-split when no newlines exist', () => {
    const text = 'a'.repeat(200);
    const chunks = splitMessage(text, 100);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe('a'.repeat(100));
    expect(chunks[1]).toBe('a'.repeat(100));
  });

  it('should handle empty string', () => {
    expect(splitMessage('', 4096)).toEqual(['']);
  });

  it('should handle text with only newlines', () => {
    const text = '\n\n\n\n\n';
    const chunks = splitMessage(text, 3);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('TelegramBot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should construct with token and no allowedUsers', () => {
    const agent = mockAgent();
    const bot = new TelegramBot(agent, 'test-token');
    expect(bot).toBeDefined();
  });

  it('should construct with allowedUsers', () => {
    const agent = mockAgent();
    const bot = new TelegramBot(agent, 'test-token', [111, 222]);
    expect(bot).toBeDefined();
  });

  it('should construct with empty allowedUsers (allow all)', () => {
    const agent = mockAgent();
    const bot = new TelegramBot(agent, 'test-token', []);
    expect(bot).toBeDefined();
  });

  it('should throw on invalid token during start', async () => {
    const agent = mockAgent();
    const bot = new TelegramBot(agent, 'bad-token');

    mockApiResponse({ ok: false, description: 'Unauthorized' });

    await expect(bot.start()).rejects.toThrow('Invalid Telegram bot token: Unauthorized');
  });

  it('should connect successfully with valid token', async () => {
    const agent = mockAgent();
    const bot = new TelegramBot(agent, 'good-token');

    // First call = getMe (success), then getUpdates will loop — stop immediately
    let callCount = 0;
    const mockReq = {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };

    (https.request as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: { path: string }, callback: (res: unknown) => void) => {
        callCount++;
        const body = opts.path.includes('getMe')
          ? { ok: true, result: { username: 'test_bot' } }
          : { ok: true, result: [] };

        const mockRes = {
          on: vi.fn((event: string, handler: (data?: unknown) => void) => {
            if (event === 'data') handler(Buffer.from(JSON.stringify(body)));
            if (event === 'end') handler();
          }),
        };
        process.nextTick(() => callback(mockRes));

        // Stop after getMe + one getUpdates
        if (callCount >= 2) {
          process.nextTick(() => bot.stop());
        }

        return mockReq;
      },
    );

    await bot.start();
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  it('should stop polling when stop() is called', () => {
    const agent = mockAgent();
    const bot = new TelegramBot(agent, 'test-token');
    bot.stop();
    // No error, just sets flag
    expect(bot).toBeDefined();
  });
});

describe('TelegramBot message handling', () => {
  it('should call agent.run with the message text', async () => {
    const agent = mockAgent('Bot response');
    const bot = new TelegramBot(agent, 'test-token');

    // Expose handleMessage by accessing it through the prototype
    const handleMessage = (bot as unknown as { handleMessage: (msg: unknown) => Promise<void> }).handleMessage.bind(bot);

    // Mock the api method to capture sendMessage calls
    const apiCalls: Array<{ method: string; body: unknown }> = [];
    (bot as unknown as { api: (method: string, body?: unknown) => Promise<unknown> }).api = vi.fn(
      async (method: string, body?: unknown) => {
        apiCalls.push({ method, body });
        return { ok: true };
      },
    );

    await handleMessage({
      message_id: 1,
      from: { id: 12345 },
      chat: { id: 12345 },
      text: 'Hello bot',
    });

    expect(agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Hello bot',
        userId: '12345',
      }),
    );

    // Should have sent typing + response
    expect(apiCalls.some(c => c.method === 'sendChatAction')).toBe(true);
    expect(apiCalls.some(c => c.method === 'sendMessage')).toBe(true);
  });

  it('should reject unauthorized users when allowlist is set', async () => {
    const agent = mockAgent();
    const bot = new TelegramBot(agent, 'test-token', [99999]);

    const handleMessage = (bot as unknown as { handleMessage: (msg: unknown) => Promise<void> }).handleMessage.bind(bot);

    const apiCalls: Array<{ method: string; body: unknown }> = [];
    (bot as unknown as { api: (method: string, body?: unknown) => Promise<unknown> }).api = vi.fn(
      async (method: string, body?: unknown) => {
        apiCalls.push({ method, body });
        return { ok: true };
      },
    );

    await handleMessage({
      message_id: 1,
      from: { id: 12345 },
      chat: { id: 12345 },
      text: 'Hello',
    });

    // Agent should NOT be called
    expect(agent.run).not.toHaveBeenCalled();

    // Should send unauthorized message
    const sendMsg = apiCalls.find(c => c.method === 'sendMessage');
    expect(sendMsg).toBeDefined();
    expect((sendMsg!.body as { text: string }).text).toContain('not authorized');
  });

  it('should allow authorized users', async () => {
    const agent = mockAgent();
    const bot = new TelegramBot(agent, 'test-token', [12345]);

    const handleMessage = (bot as unknown as { handleMessage: (msg: unknown) => Promise<void> }).handleMessage.bind(bot);

    (bot as unknown as { api: (method: string, body?: unknown) => Promise<unknown> }).api = vi.fn(
      async () => ({ ok: true }),
    );

    await handleMessage({
      message_id: 1,
      from: { id: 12345 },
      chat: { id: 12345 },
      text: 'Hello',
    });

    expect(agent.run).toHaveBeenCalled();
  });

  it('should ignore messages without from field', async () => {
    const agent = mockAgent();
    const bot = new TelegramBot(agent, 'test-token');

    const handleMessage = (bot as unknown as { handleMessage: (msg: unknown) => Promise<void> }).handleMessage.bind(bot);

    (bot as unknown as { api: (method: string, body?: unknown) => Promise<unknown> }).api = vi.fn(
      async () => ({ ok: true }),
    );

    await handleMessage({
      message_id: 1,
      chat: { id: 12345 },
      text: 'Hello',
    });

    expect(agent.run).not.toHaveBeenCalled();
  });

  it('should ignore messages without text', async () => {
    const agent = mockAgent();
    const bot = new TelegramBot(agent, 'test-token');

    const handleMessage = (bot as unknown as { handleMessage: (msg: unknown) => Promise<void> }).handleMessage.bind(bot);

    (bot as unknown as { api: (method: string, body?: unknown) => Promise<unknown> }).api = vi.fn(
      async () => ({ ok: true }),
    );

    await handleMessage({
      message_id: 1,
      from: { id: 12345 },
      chat: { id: 12345 },
      // no text, no caption, no photo
    });

    expect(agent.run).not.toHaveBeenCalled();
  });

  it('should use caption when text is absent but caption exists', async () => {
    const agent = mockAgent();
    const bot = new TelegramBot(agent, 'test-token');

    const handleMessage = (bot as unknown as { handleMessage: (msg: unknown) => Promise<void> }).handleMessage.bind(bot);

    (bot as unknown as { api: (method: string, body?: unknown) => Promise<unknown> }).api = vi.fn(
      async () => ({ ok: true }),
    );

    await handleMessage({
      message_id: 1,
      from: { id: 12345 },
      chat: { id: 12345 },
      caption: 'A caption text',
    });

    expect(agent.run).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'A caption text' }),
    );
  });

  it('should maintain per-user conversation history', async () => {
    // Capture history snapshots at each agent.run call (array is mutated after)
    const historySnapshots: unknown[][] = [];
    const agent = {
      run: vi.fn().mockImplementation((req: { history: unknown[] }) => {
        historySnapshots.push([...req.history]);
        return Promise.resolve({ content: `Response ${historySnapshots.length}`, sessionId: `sess-${historySnapshots.length}` });
      }),
    } as unknown as AgentLoop;

    const freshBot = new TelegramBot(agent, 'test-token');

    const handleMessage = (freshBot as unknown as { handleMessage: (msg: unknown) => Promise<void> }).handleMessage.bind(freshBot);

    (freshBot as unknown as { api: (method: string, body?: unknown) => Promise<unknown> }).api = vi.fn(
      async () => ({ ok: true }),
    );

    // First message — empty history
    await handleMessage({
      message_id: 1,
      from: { id: 12345 },
      chat: { id: 12345 },
      text: 'First message',
    });

    // Second message — should include history from first turn
    await handleMessage({
      message_id: 2,
      from: { id: 12345 },
      chat: { id: 12345 },
      text: 'Second message',
    });

    expect(historySnapshots[0]).toHaveLength(0); // First call has no history
    expect(historySnapshots[1]).toHaveLength(2); // Second call has first turn
    expect(historySnapshots[1][0]).toEqual({ role: 'user', content: 'First message' });
    expect(historySnapshots[1][1]).toEqual({ role: 'assistant', content: 'Response 1' });
  });

  it('should send error message when agent throws', async () => {
    const agent = mockAgent();
    (agent.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Agent failed'));
    const bot = new TelegramBot(agent, 'test-token');

    const handleMessage = (bot as unknown as { handleMessage: (msg: unknown) => Promise<void> }).handleMessage.bind(bot);

    const apiCalls: Array<{ method: string; body: unknown }> = [];
    (bot as unknown as { api: (method: string, body?: unknown) => Promise<unknown> }).api = vi.fn(
      async (method: string, body?: unknown) => {
        apiCalls.push({ method, body });
        return { ok: true };
      },
    );

    await handleMessage({
      message_id: 1,
      from: { id: 12345 },
      chat: { id: 12345 },
      text: 'Hello',
    });

    const errorMsg = apiCalls.find(
      c => c.method === 'sendMessage' && (c.body as { text: string }).text.includes('error'),
    );
    expect(errorMsg).toBeDefined();
  });
});
