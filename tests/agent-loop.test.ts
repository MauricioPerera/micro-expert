import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../src/agent/loop.js';
import type { InferenceClient, ChatMessage, StreamDelta, ChatCompletionOptions } from '../src/inference/client.js';
import type { MemoryProvider, RecallResult } from '../src/memory/provider.js';
import type { McpClientManager } from '../src/mcp/index.js';
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

    // System message should NOT contain recalled context
    const callArgs = (inference.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0];
    const messages = callArgs[0] as ChatMessage[];
    const systemMsg = messages.find(m => m.role === 'system');
    expect(systemMsg!.content).not.toContain('Relevant Memories');

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

  it('should include current date/time in system prompt', async () => {
    const inference = mockInferenceClient('Today is nice!');
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config);

    await agent.run({
      message: 'What day is it?',
      userId: 'test-user',
    });

    const callArgs = (inference.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0];
    const messages = callArgs[0] as ChatMessage[];
    const systemMsg = messages.find(m => m.role === 'system');

    expect(systemMsg!.content).toContain('Current date:');
    expect(systemMsg!.content).toContain('Current time:');
  });

  it('should include calculator instruction in system prompt', async () => {
    const inference = mockInferenceClient('Sure!');
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config);

    await agent.run({
      message: 'Hello',
      userId: 'test-user',
    });

    const callArgs = (inference.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0];
    const messages = callArgs[0] as ChatMessage[];
    const systemMsg = messages.find(m => m.role === 'system');

    expect(systemMsg!.content).toContain('[CALC:');
    expect(systemMsg!.content).toContain('calculations');
  });

  it('should process [CALC: ...] tags in model response', async () => {
    const inference = mockInferenceClient('The result is [CALC: 5 + 3] items.');
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config);

    const result = await agent.run({
      message: 'What is 5 + 3?',
      userId: 'test-user',
    });

    expect(result.content).toBe('The result is 8 items.');
    expect(result.content).not.toContain('[CALC:');
  });

  it('should handle multiple [CALC] tags in one response', async () => {
    const inference = mockInferenceClient('Sum: [CALC: 10 + 20], Product: [CALC: 3 * 7]');
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config);

    const result = await agent.run({
      message: 'Calculate both',
      userId: 'test-user',
    });

    expect(result.content).toBe('Sum: 30, Product: 21');
  });

  it('should handle invalid [CALC] expressions gracefully', async () => {
    const inference = mockInferenceClient('Result: [CALC: 2 & 3]');
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config);

    const result = await agent.run({
      message: 'Calculate something',
      userId: 'test-user',
    });

    expect(result.content).toContain('[error:');
    expect(result.content).not.toContain('[CALC:');
  });

  it('should leave response unchanged when no [CALC] tags present', async () => {
    const inference = mockInferenceClient('No math here, just text.');
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config);

    const result = await agent.run({
      message: 'Tell me a story',
      userId: 'test-user',
    });

    expect(result.content).toBe('No math here, just text.');
  });

  it('should include FETCH instruction in system prompt', async () => {
    const inference = mockInferenceClient('Sure!');
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config);

    await agent.run({
      message: 'Hello',
      userId: 'test-user',
    });

    const callArgs = (inference.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0];
    const messages = callArgs[0] as ChatMessage[];
    const systemMsg = messages.find(m => m.role === 'system');

    expect(systemMsg!.content).toContain('[FETCH:');
    expect(systemMsg!.content).toContain('fetch data');
  });

  it('should process [FETCH: ...] tags in model response', async () => {
    // Mock global fetch for this test
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"result": "success"}'));
        controller.close();
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      body: stream,
    } as unknown as Response);

    try {
      const inference = mockInferenceClient('The API says: [FETCH: GET https://api.example.com/data]');
      const memory = mockMemoryProvider();
      const agent = new AgentLoop(inference, memory, config);

      const result = await agent.run({
        message: 'Check the API',
        userId: 'test-user',
      });

      expect(result.content).toContain('HTTP 200');
      expect(result.content).toContain('{"result": "success"}');
      expect(result.content).not.toContain('[FETCH:');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should handle FETCH errors gracefully', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    try {
      const inference = mockInferenceClient('Result: [FETCH: GET https://api.example.com/fail]');
      const memory = mockMemoryProvider();
      const agent = new AgentLoop(inference, memory, config);

      const result = await agent.run({
        message: 'Try this',
        userId: 'test-user',
      });

      expect(result.content).toContain('[error:');
      expect(result.content).not.toContain('[FETCH:');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should process mixed CALC and FETCH tags', async () => {
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('42'));
        controller.close();
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      body: stream,
    } as unknown as Response);

    try {
      const inference = mockInferenceClient('Math: [CALC: 2 + 2], API: [FETCH: GET https://api.example.com/num]');
      const memory = mockMemoryProvider();
      const agent = new AgentLoop(inference, memory, config);

      const result = await agent.run({
        message: 'Both',
        userId: 'test-user',
      });

      expect(result.content).toContain('Math: 4');
      expect(result.content).toContain('HTTP 200');
      expect(result.content).not.toContain('[CALC:');
      expect(result.content).not.toContain('[FETCH:');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --- MCP tool call tests ---

  it('should process [MCP: tool_name {"arg": "val"}] tags', async () => {
    const mockMcp = {
      listTools: vi.fn().mockReturnValue([
        { qualifiedName: 'read_file', serverName: 'fs', originalName: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
      ]),
      toSystemPromptSection: vi.fn().mockReturnValue('To use external tools, write [MCP: tool_name {"param": "value"}].\nMCP tools:\n- read_file: Read a file'),
      callTool: vi.fn().mockResolvedValue('file contents here'),
    } as unknown as McpClientManager;

    const inference = mockInferenceClient('Contents: [MCP: read_file {"path": "/tmp/test.txt"}]');
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config, mockMcp);

    const result = await agent.run({
      message: 'Read the file',
      userId: 'test-user',
    });

    expect(result.content).toBe('Contents: file contents here');
    expect(result.content).not.toContain('[MCP:');
    expect(mockMcp.callTool).toHaveBeenCalledWith('read_file', { path: '/tmp/test.txt' });
  });

  it('should include MCP tool instructions in system prompt', async () => {
    const mockMcp = {
      listTools: vi.fn().mockReturnValue([
        { qualifiedName: 'test_tool', serverName: 'test', originalName: 'test_tool', description: 'A test tool', inputSchema: { type: 'object' } },
      ]),
      toSystemPromptSection: vi.fn().mockReturnValue('To use external tools, write [MCP: tool_name {"param": "value"}].\nMCP tools:\n- test_tool: A test tool'),
      callTool: vi.fn(),
    } as unknown as McpClientManager;

    const inference = mockInferenceClient('Sure!');
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config, mockMcp);

    await agent.run({ message: 'Hello', userId: 'test-user' });

    const callArgs = (inference.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0];
    const messages = callArgs[0] as ChatMessage[];
    const systemMsg = messages.find(m => m.role === 'system');

    expect(systemMsg!.content).toContain('[MCP: tool_name');
    expect(systemMsg!.content).toContain('test_tool');
  });

  it('should handle invalid JSON args in MCP tag', async () => {
    const mockMcp = {
      listTools: vi.fn().mockReturnValue([
        { qualifiedName: 'tool1', serverName: 'test', originalName: 'tool1', description: 'A tool', inputSchema: { type: 'object' } },
      ]),
      toSystemPromptSection: vi.fn().mockReturnValue(''),
      callTool: vi.fn(),
    } as unknown as McpClientManager;

    const inference = mockInferenceClient('Result: [MCP: tool1 {invalid json}]');
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config, mockMcp);

    const result = await agent.run({ message: 'Test', userId: 'test-user' });

    expect(result.content).toContain('[error:');
    expect(result.content).not.toContain('[MCP:');
    expect(mockMcp.callTool).not.toHaveBeenCalled();
  });

  it('should handle MCP tool execution error', async () => {
    const mockMcp = {
      listTools: vi.fn().mockReturnValue([
        { qualifiedName: 'failing', serverName: 'test', originalName: 'failing', description: 'Fails', inputSchema: { type: 'object' } },
      ]),
      toSystemPromptSection: vi.fn().mockReturnValue(''),
      callTool: vi.fn().mockRejectedValue(new Error('Tool execution failed')),
    } as unknown as McpClientManager;

    const inference = mockInferenceClient('Result: [MCP: failing {}]');
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config, mockMcp);

    const result = await agent.run({ message: 'Test', userId: 'test-user' });

    expect(result.content).toContain('[error: Tool execution failed]');
    expect(result.content).not.toContain('[MCP:');
  });

  it('should process [MCP:] tags with nested brackets in JSON args', async () => {
    const mockMcp = {
      listTools: vi.fn().mockReturnValue([]),
      toSystemPromptSection: vi.fn().mockReturnValue(''),
      callTool: vi.fn().mockResolvedValue('workflow-created'),
    } as unknown as McpClientManager;

    // JSON args contain arrays like "position": [250, 300] — old regex would break on the inner ]
    const complexJson = '{"name": "Test", "nodes": [{"id": "t1", "type": "n8n-nodes-base.httpRequest", "position": [250, 300], "parameters": {}}], "connections": {}}';
    const inference = mockInferenceClient(`Creating: [MCP: n8n_create_workflow ${complexJson}]`);
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config, mockMcp);

    const result = await agent.run({ message: 'Create workflow', userId: 'test-user' });

    expect(result.content).toBe('Creating: workflow-created');
    expect(mockMcp.callTool).toHaveBeenCalledWith('n8n_create_workflow', JSON.parse(complexJson));
  });

  it('should unwrap MCP tags from markdown code blocks', async () => {
    const mockMcp = {
      listTools: vi.fn().mockReturnValue([]),
      toSystemPromptSection: vi.fn().mockReturnValue(''),
      callTool: vi.fn().mockResolvedValue('done'),
    } as unknown as McpClientManager;

    // Model wraps MCP tag in ```mcp code fence
    const inference = mockInferenceClient('Here is the result:\n\n```mcp\n[MCP: n8n_list_workflows {}]\n```\n\nDone.');
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config, mockMcp);

    const result = await agent.run({ message: 'List workflows', userId: 'test-user' });

    expect(result.content).toContain('done');
    expect(result.content).not.toContain('[MCP:');
    expect(result.content).not.toContain('```');
    expect(mockMcp.callTool).toHaveBeenCalledWith('n8n_list_workflows', {});
  });

  it('should unwrap CALC tags from markdown code blocks', async () => {
    const inference = mockInferenceClient('Result:\n```\n[CALC: 5 * 10]\n```');
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config);

    const result = await agent.run({ message: 'Calculate', userId: 'test-user' });

    expect(result.content).toBe('Result:\n50');
    expect(result.content).not.toContain('[CALC:');
  });

  it('should NOT unwrap code blocks without tool tags', async () => {
    const inference = mockInferenceClient('Example:\n```json\n{"key": "value"}\n```');
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config);

    const result = await agent.run({ message: 'Show JSON', userId: 'test-user' });

    expect(result.content).toContain('```json');
    expect(result.content).toContain('{"key": "value"}');
  });

  it('should process mixed CALC, FETCH, and MCP tags', async () => {
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('api-data'));
        controller.close();
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      body: stream,
    } as unknown as Response);

    const mockMcp = {
      listTools: vi.fn().mockReturnValue([
        { qualifiedName: 'greet', serverName: 'test', originalName: 'greet', description: 'Greet', inputSchema: { type: 'object' } },
      ]),
      toSystemPromptSection: vi.fn().mockReturnValue(''),
      callTool: vi.fn().mockResolvedValue('Hi there!'),
    } as unknown as McpClientManager;

    try {
      const inference = mockInferenceClient('Math: [CALC: 3 * 3], API: [FETCH: GET https://api.example.com/x], MCP: [MCP: greet {"name": "World"}]');
      const memory = mockMemoryProvider();
      const agent = new AgentLoop(inference, memory, config, mockMcp);

      const result = await agent.run({ message: 'All three', userId: 'test-user' });

      expect(result.content).toContain('Math: 9');
      expect(result.content).toContain('HTTP 200');
      expect(result.content).toContain('MCP: Hi there!');
      expect(result.content).not.toContain('[CALC:');
      expect(result.content).not.toContain('[FETCH:');
      expect(result.content).not.toContain('[MCP:');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should work without MCP manager (backwards compatibility)', async () => {
    const inference = mockInferenceClient('No MCP here');
    const memory = mockMemoryProvider();
    const agent = new AgentLoop(inference, memory, config); // no mcp param

    const result = await agent.run({ message: 'Hello', userId: 'test-user' });

    expect(result.content).toBe('No MCP here');
  });
});
