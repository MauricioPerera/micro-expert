import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../src/agent/loop.js';
import type { InferenceClient, ChatMessage, StreamDelta, ChatCompletionOptions } from '../src/inference/client.js';
import type { MemoryProvider, RecallResult } from '../src/memory/provider.js';
import { loadConfig } from '../src/config.js';

/** Create a mock inference client */
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

/** Create a mock memory provider */
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

describe('AgentLoop', () => {
  const config = loadConfig();

  it('should run the full pipeline: recall → infer → save', async () => {
    const inference = mockInferenceClient('Hello, world!');
    const memory = mockMemoryProvider('User likes TypeScript');
    const agent = new AgentLoop(inference, memory, config);

    const result = await agent.run({
      message: 'Hi there',
      userId: 'test-user',
    });

    // Verify recall was called
    expect(memory.recall).toHaveBeenCalledWith('Hi there', 'test-user');

    // Verify inference was called with context injected
    expect(inference.chatCompletion).toHaveBeenCalled();
    const callArgs = (inference.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0];
    const messages = callArgs[0] as ChatMessage[];

    // System message should contain the recalled context
    const systemMsg = messages.find(m => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain('User likes TypeScript');

    // User message should be present
    const userMsg = messages.find(m => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe('Hi there');

    // Session should be saved
    expect(memory.saveSession).toHaveBeenCalledWith('test-user', [
      { role: 'user', content: 'Hi there' },
      { role: 'assistant', content: 'Hello, world!' },
    ]);

    expect(result.content).toBe('Hello, world!');
    expect(result.sessionId).toBe('session-123');
    expect(result.recalledItems).toBe(1);
  });

  it('should work without recalled context', async () => {
    const inference = mockInferenceClient('I can help!');
    const memory = mockMemoryProvider(''); // No context
    const agent = new AgentLoop(inference, memory, config);

    const result = await agent.run({
      message: 'What time is it?',
      userId: 'test-user',
    });

    // System message should NOT contain context markers
    const callArgs = (inference.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0];
    const messages = callArgs[0] as ChatMessage[];
    const systemMsg = messages.find(m => m.role === 'system');
    expect(systemMsg!.content).not.toContain('[Relevant context from memory]');

    expect(result.content).toBe('I can help!');
    expect(result.recalledItems).toBe(0);
  });

  it('should stream responses', async () => {
    const inference = mockInferenceClient('Hi!');
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config);

    const chunks: StreamDelta[] = [];
    for await (const delta of agent.runStream({
      message: 'Hello',
      userId: 'test-user',
    })) {
      chunks.push(delta);
    }

    // Should have received individual character deltas + done
    expect(chunks.length).toBeGreaterThan(0);
    const content = chunks.map(c => c.content).join('');
    expect(content).toBe('Hi!');

    // Session should be saved after stream completes
    expect(memory.saveSession).toHaveBeenCalled();
  });

  it('should include conversation history', async () => {
    const inference = mockInferenceClient('Sure!');
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config);

    await agent.run({
      message: 'Continue',
      userId: 'test-user',
      history: [
        { role: 'user', content: 'Start project' },
        { role: 'assistant', content: 'Started!' },
      ],
    });

    const callArgs = (inference.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0];
    const messages = callArgs[0] as ChatMessage[];

    // History should be between system and current user message
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toBe('Start project');
    expect(messages[2].role).toBe('assistant');
    expect(messages[2].content).toBe('Started!');
    expect(messages[3].role).toBe('user');
    expect(messages[3].content).toBe('Continue');
  });
});
