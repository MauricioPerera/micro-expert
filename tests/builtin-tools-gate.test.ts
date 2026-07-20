import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../src/agent/loop.js';
import type { InferenceClient, ChatMessage, StreamDelta } from '../src/inference/client.js';
import type { MemoryProvider, RecallResult } from '../src/memory/provider.js';
import type { McpClientManager } from '../src/mcp/index.js';
import { loadConfig } from '../src/config.js';

/** Build a config with builtinTools overridden (defaults are otherwise untouched). */
function configWith(builtinTools: boolean) {
  return { ...loadConfig(), builtinTools };
}

/** Mock inference client returning a fixed response string. */
function mockInferenceClient(response: string): InferenceClient {
  return {
    chatCompletion: vi.fn().mockResolvedValue({
      id: 'test-id',
      choices: [{ index: 0, message: { role: 'assistant', content: response }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    chatCompletionStream: vi.fn().mockImplementation(async function* () {
      for (const char of response) {
        yield { content: char, done: false } as StreamDelta;
      }
      yield { content: '', done: true, finishReason: 'stop' } as StreamDelta;
    }),
  } as unknown as InferenceClient;
}

/** Mock memory provider with configurable recalled context. */
function mockMemoryProvider(contextToReturn = ''): MemoryProvider {
  return {
    recall: vi.fn().mockReturnValue({
      formatted: contextToReturn,
      totalItems: contextToReturn ? 1 : 0,
      estimatedChars: contextToReturn.length,
    } as RecallResult),
    saveSession: vi.fn().mockReturnValue('session-123'),
    saveMemory: vi.fn(),
    searchMemories: vi.fn().mockReturnValue([]),
    getHistory: vi.fn().mockReturnValue([]),
    getSession: vi.fn().mockReturnValue(null),
    healthCheck: vi.fn().mockReturnValue(true),
    stats: vi.fn().mockReturnValue({}),
    dispose: vi.fn(),
  } as unknown as MemoryProvider;
}

function mockMcp(): McpClientManager {
  return {
    listTools: vi.fn().mockReturnValue([
      { qualifiedName: 'greet', serverName: 'test', originalName: 'greet', description: 'Greet', inputSchema: { type: 'object' } },
    ]),
    toSystemPromptSection: vi.fn().mockReturnValue('To use external tools, write [MCP: tool_name {"param": "value"}].\nMCP tools:\n- greet: Greet'),
    callTool: vi.fn().mockResolvedValue('Hi there!'),
  } as unknown as McpClientManager;
}

/** Extract the system message from the first chatCompletion call. */
function systemMessage(inference: InferenceClient): string {
  const callArgs = (inference.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0];
  const messages = callArgs[0] as ChatMessage[];
  return messages.find(m => m.role === 'system')!.content;
}

const CALC_INSTRUCTION = 'To perform calculations, write [CALC: expression]';
const FETCH_INSTRUCTION = 'To fetch data from the web, write [FETCH: GET url]';

describe('builtinTools gate', () => {
  describe('default (builtinTools = true) — behavior unchanged', () => {
    it('appends CALC/FETCH instructions in the no-context branch', async () => {
      const inference = mockInferenceClient('I can help!');
      const memory = mockMemoryProvider(''); // no context → branch 3
      const agent = new AgentLoop(inference, memory, configWith(true));

      await agent.run({ message: 'hi', userId: 'u' });

      const sys = systemMessage(inference);
      expect(sys).toContain(CALC_INSTRUCTION);
      expect(sys).toContain(FETCH_INSTRUCTION);
    });

    it('appends CALC/FETCH instructions in the context branch', async () => {
      const inference = mockInferenceClient('ok');
      const memory = mockMemoryProvider('User likes TS'); // branch 2
      const agent = new AgentLoop(inference, memory, configWith(true));

      await agent.run({ message: 'hi', userId: 'u' });

      const sys = systemMessage(inference);
      expect(sys).toContain(CALC_INSTRUCTION);
      expect(sys).toContain(FETCH_INSTRUCTION);
    });

    it('appends CALC/FETCH instructions for a custom system prompt', async () => {
      const inference = mockInferenceClient('ok');
      const memory = mockMemoryProvider('User likes TS'); // branch 1
      const agent = new AgentLoop(inference, memory, configWith(true));

      await agent.run({ message: 'hi', userId: 'u', systemPrompt: 'Be brief.' });

      const sys = systemMessage(inference);
      expect(sys).toContain(CALC_INSTRUCTION);
      expect(sys).toContain(FETCH_INSTRUCTION);
    });

    it('executes [CALC:] and [FETCH:] tags in the response', async () => {
      const inference = mockInferenceClient('Math: [CALC: 6 * 7]');
      const memory = mockMemoryProvider();
      const agent = new AgentLoop(inference, memory, configWith(true));

      const result = await agent.run({ message: 'calc', userId: 'u' });
      expect(result.content).toBe('Math: 42');
    });
  });

  describe('builtinTools = false — instructions removed, tags left literal', () => {
    it('omits CALC/FETCH instructions in the no-context branch', async () => {
      const inference = mockInferenceClient('Paris is the capital of France.');
      const memory = mockMemoryProvider(''); // branch 3
      const agent = new AgentLoop(inference, memory, configWith(false));

      await agent.run({ message: 'capital of France?', userId: 'u' });

      const sys = systemMessage(inference);
      expect(sys).not.toContain(CALC_INSTRUCTION);
      expect(sys).not.toContain(FETCH_INSTRUCTION);
      // Date context and base persona remain intact
      expect(sys).toContain('You are MicroExpert');
      expect(sys).toContain('Current date:');
    });

    it('omits CALC/FETCH instructions in the context branch', async () => {
      const inference = mockInferenceClient('ok');
      const memory = mockMemoryProvider('User likes TS'); // branch 2
      const agent = new AgentLoop(inference, memory, configWith(false));

      await agent.run({ message: 'hi', userId: 'u' });

      const sys = systemMessage(inference);
      expect(sys).not.toContain(CALC_INSTRUCTION);
      expect(sys).not.toContain(FETCH_INSTRUCTION);
      expect(sys).toContain('You are MicroExpert');
    });

    it('omits CALC/FETCH instructions for a custom system prompt', async () => {
      const inference = mockInferenceClient('ok');
      const memory = mockMemoryProvider('User likes TS'); // branch 1
      const agent = new AgentLoop(inference, memory, configWith(false));

      await agent.run({ message: 'hi', userId: 'u', systemPrompt: 'Be brief.' });

      const sys = systemMessage(inference);
      expect(sys).not.toContain(CALC_INSTRUCTION);
      expect(sys).not.toContain(FETCH_INSTRUCTION);
      expect(sys).toContain('Be brief.');
    });

    it('leaves a [CALC:] tag as literal text (not executed)', async () => {
      const inference = mockInferenceClient('The answer is [CALC: 6 * 7]');
      const memory = mockMemoryProvider();
      const agent = new AgentLoop(inference, memory, configWith(false));

      const result = await agent.run({ message: 'calc', userId: 'u' });
      expect(result.content).toBe('The answer is [CALC: 6 * 7]');
    });

    it('leaves a [FETCH:] tag as literal text (not executed)', async () => {
      const inference = mockInferenceClient('See [FETCH: GET https://example.com]');
      const memory = mockMemoryProvider();
      const agent = new AgentLoop(inference, memory, configWith(false));

      const result = await agent.run({ message: 'fetch', userId: 'u' });
      // Tag preserved verbatim — no "[error: Fetch failed]" replacement.
      expect(result.content).toBe('See [FETCH: GET https://example.com]');
      expect(result.content).not.toContain('[error:');
    });

    it('still processes [MCP:] tags when builtinTools is false (MCP branch unchanged)', async () => {
      const inference = mockInferenceClient('Greet: [MCP: greet {"name": "World"}]');
      const memory = mockMemoryProvider();
      const mcp = mockMcp();
      const agent = new AgentLoop(inference, memory, configWith(false), mcp);

      const result = await agent.run({ message: 'greet', userId: 'u' });
      expect(result.content).toBe('Greet: Hi there!');
      // MCP instruction is still injected even with built-ins off
      expect(systemMessage(inference)).toContain('[MCP: tool_name');
    });

    it('leaves both [CALC:] and [FETCH:] literal while MCP still runs', async () => {
      const inference = mockInferenceClient('A=[CALC: 1+1] B=[FETCH: GET https://x.com] C=[MCP: greet {}]');
      const memory = mockMemoryProvider();
      const mcp = mockMcp();
      const agent = new AgentLoop(inference, memory, configWith(false), mcp);

      const result = await agent.run({ message: 'mix', userId: 'u' });
      expect(result.content).toBe('A=[CALC: 1+1] B=[FETCH: GET https://x.com] C=Hi there!');
    });

    it('does not execute built-in tags during streaming either', async () => {
      const inference = mockInferenceClient('Result: [CALC: 2+2]');
      const memory = mockMemoryProvider();
      const agent = new AgentLoop(inference, memory, configWith(false));

      const chunks: StreamDelta[] = [];
      for await (const delta of agent.runStream({ message: 'calc', userId: 'u' })) {
        chunks.push(delta);
      }
      const content = chunks.map(c => c.content).join('');
      expect(content).toBe('Result: [CALC: 2+2]');

      // Session saved with the literal tag preserved
      const saved = (memory.saveSession as ReturnType<typeof vi.fn>).mock.calls[0][1] as ChatMessage[];
      expect(saved[1].content).toBe('Result: [CALC: 2+2]');
    });
  });
});