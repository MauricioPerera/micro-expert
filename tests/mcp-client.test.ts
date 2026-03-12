import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpClientManager } from '../src/mcp/client.js';
import type { McpToolInfo } from '../src/mcp/client.js';

// Mock the MCP SDK modules
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      callTool: vi.fn().mockResolvedValue({ content: [] }),
    })),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn().mockImplementation(() => ({
      close: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';

describe('McpClientManager', () => {
  let manager: McpClientManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new McpClientManager();
  });

  it('should start with no tools', () => {
    expect(manager.listTools()).toEqual([]);
  });

  it('should connectAll with empty config', async () => {
    await manager.connectAll({});
    expect(manager.listTools()).toEqual([]);
  });

  it('should connect to a server and discover tools', async () => {
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            name: 'read_file',
            description: 'Read a file',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          },
          {
            name: 'write_file',
            description: 'Write a file',
            inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
          },
        ],
      }),
      callTool: vi.fn(),
    };
    (Client as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockClient);

    await manager.connect('filesystem', { command: 'node', args: ['server.js'] });

    const tools = manager.listTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].qualifiedName).toBe('read_file');
    expect(tools[0].serverName).toBe('filesystem');
    expect(tools[0].description).toBe('Read a file');
    expect(tools[1].qualifiedName).toBe('write_file');
  });

  it('should handle tool name collisions with prefix', async () => {
    // First server has 'list' tool
    const mockClient1 = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'list', description: 'List from server A', inputSchema: { type: 'object' } }],
      }),
      callTool: vi.fn(),
    };
    // Second server also has 'list' tool
    const mockClient2 = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'list', description: 'List from server B', inputSchema: { type: 'object' } }],
      }),
      callTool: vi.fn(),
    };

    let callCount = 0;
    (Client as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      return callCount === 1 ? mockClient1 : mockClient2;
    });

    await manager.connect('serverA', { command: 'node', args: ['a.js'] });
    await manager.connect('serverB', { command: 'node', args: ['b.js'] });

    const tools = manager.listTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].qualifiedName).toBe('list');
    expect(tools[0].serverName).toBe('serverA');
    expect(tools[1].qualifiedName).toBe('serverB__list');
    expect(tools[1].serverName).toBe('serverB');
  });

  it('should call a tool and return text result', async () => {
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object' } }],
      }),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Hello from MCP!' }],
      }),
    };
    (Client as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockClient);

    await manager.connect('test', { command: 'node', args: ['test.js'] });
    const result = await manager.callTool('echo', { message: 'Hello' });

    expect(result).toBe('Hello from MCP!');
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: 'echo',
      arguments: { message: 'Hello' },
    });
  });

  it('should serialize non-text content as JSON', async () => {
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'image', description: 'Get image', inputSchema: { type: 'object' } }],
      }),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
      }),
    };
    (Client as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockClient);

    await manager.connect('test', { command: 'node', args: ['test.js'] });
    const result = await manager.callTool('image', {});

    expect(result).toContain('"type":"image"');
    expect(result).toContain('"data":"base64data"');
  });

  it('should truncate long results', async () => {
    const longText = 'x'.repeat(3000);
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'big', description: 'Big result', inputSchema: { type: 'object' } }],
      }),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: longText }],
      }),
    };
    (Client as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockClient);

    await manager.connect('test', { command: 'node', args: ['test.js'] });
    const result = await manager.callTool('big', {});

    expect(result.length).toBeLessThan(3000);
    expect(result).toContain('... [truncated]');
  });

  it('should throw for unknown tool', async () => {
    await expect(manager.callTool('nonexistent', {})).rejects.toThrow('Unknown MCP tool');
  });

  it('should disconnect all servers', async () => {
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'tool1', description: 'Test', inputSchema: { type: 'object' } }],
      }),
      callTool: vi.fn(),
    };
    (Client as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockClient);

    await manager.connect('test', { command: 'node', args: ['test.js'] });
    expect(manager.listTools()).toHaveLength(1);

    await manager.disconnectAll();
    expect(manager.listTools()).toHaveLength(0);
    expect(mockClient.close).toHaveBeenCalled();
  });

  it('should handle server connection failure gracefully in connectAll', async () => {
    (Client as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      connect: vi.fn().mockRejectedValue(new Error('Connection refused')),
      close: vi.fn(),
      listTools: vi.fn(),
      callTool: vi.fn(),
    }));

    // Should not throw
    await manager.connectAll({
      failing: { command: 'nonexistent', args: [] },
    });

    expect(manager.listTools()).toEqual([]);
  });

  describe('toSystemPromptSection', () => {
    it('should return empty string when no tools', () => {
      expect(manager.toSystemPromptSection()).toBe('');
    });

    it('should format tools compactly with required params', async () => {
      const mockClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockResolvedValue({
          tools: [
            {
              name: 'read_file',
              description: 'Read a file from disk',
              inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
              },
            },
            {
              name: 'search',
              description: 'Search for text',
              inputSchema: {
                type: 'object',
                properties: { query: { type: 'string' }, limit: { type: 'number' } },
                required: ['query'],
              },
            },
          ],
        }),
        callTool: vi.fn(),
      };
      (Client as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockClient);

      await manager.connect('fs', { command: 'node', args: ['fs.js'] });

      const section = manager.toSystemPromptSection();

      expect(section).toContain('[MCP: tool_name {"param": "value"}]');
      expect(section).toContain('read_file: Read a file from disk. Params: path (string)');
      expect(section).toContain('search: Search for text. Params: query (string)');
    });

    it('should respect maxTools limit', async () => {
      const tools = Array.from({ length: 20 }, (_, i) => ({
        name: `tool_${i}`,
        description: `Tool number ${i}`,
        inputSchema: { type: 'object' },
      }));

      const mockClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockResolvedValue({ tools }),
        callTool: vi.fn(),
      };
      (Client as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockClient);

      await manager.connect('big', { command: 'node', args: ['big.js'] });

      const section = manager.toSystemPromptSection(5);
      const lines = section.split('\n').filter(l => l.startsWith('- '));
      expect(lines).toHaveLength(5);
    });
  });
});
