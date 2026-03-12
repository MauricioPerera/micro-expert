import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpClientManager } from '../src/mcp/client.js';
import type { McpToolInfo } from '../src/mcp/client.js';

// Mock the MCP SDK modules (stdio transport)
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

// Mock the HttpMcpClient (HTTP transport)
vi.mock('../src/mcp/http-transport.js', () => {
  return {
    HttpMcpClient: vi.fn().mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue({
        serverInfo: { name: 'mock-server', version: '0.1.0' },
        tools: [],
      }),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'mock result' }],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { HttpMcpClient } from '../src/mcp/http-transport.js';

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

  it('should connect to a stdio server and discover tools', async () => {
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

  it('should connect to an HTTP server and discover tools', async () => {
    (HttpMcpClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue({
        serverInfo: { name: 'n8n-server', version: '1.0.0' },
        tools: [
          { name: 'get_time', description: 'Get current time', inputSchema: { type: 'object' } },
        ],
      }),
      callTool: vi.fn(),
      close: vi.fn(),
    }));

    await manager.connect('n8n', { url: 'http://localhost:5678/mcp/test' });

    const tools = manager.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].qualifiedName).toBe('get_time');
    expect(tools[0].serverName).toBe('n8n');
    expect(HttpMcpClient).toHaveBeenCalledWith({
      url: 'http://localhost:5678/mcp/test',
      headers: undefined,
    });
  });

  it('should pass headers to HttpMcpClient', async () => {
    (HttpMcpClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue({
        serverInfo: { name: 'auth-server', version: '1.0.0' },
        tools: [],
      }),
      callTool: vi.fn(),
      close: vi.fn(),
    }));

    await manager.connect('auth', {
      url: 'http://localhost:5678/mcp/test',
      headers: { 'Authorization': 'Bearer token123' },
    });

    expect(HttpMcpClient).toHaveBeenCalledWith({
      url: 'http://localhost:5678/mcp/test',
      headers: { 'Authorization': 'Bearer token123' },
    });
  });

  it('should handle tool name collisions with prefix', async () => {
    const mockClient1 = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'list', description: 'List from server A', inputSchema: { type: 'object' } }],
      }),
      callTool: vi.fn(),
    };
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

  it('should call a stdio tool and return text result', async () => {
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

  it('should call an HTTP tool and return text result', async () => {
    const mockCallTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Hello from n8n!' }],
    });
    (HttpMcpClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue({
        serverInfo: { name: 'n8n', version: '1.0.0' },
        tools: [{ name: 'greet', description: 'Greet', inputSchema: { type: 'object' } }],
      }),
      callTool: mockCallTool,
      close: vi.fn(),
    }));

    await manager.connect('n8n', { url: 'http://localhost:5678/mcp/test' });
    const result = await manager.callTool('greet', { name: 'World' });

    expect(result).toBe('Hello from n8n!');
    expect(mockCallTool).toHaveBeenCalledWith('greet', { name: 'World' });
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

  it('should disconnect all servers (stdio + http)', async () => {
    // Add a stdio server
    const mockSdkClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'stdio_tool', description: 'Test', inputSchema: { type: 'object' } }],
      }),
      callTool: vi.fn(),
    };
    (Client as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockSdkClient);

    // Add an HTTP server
    const mockHttpClose = vi.fn();
    (HttpMcpClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue({
        serverInfo: { name: 'n8n', version: '1.0.0' },
        tools: [{ name: 'http_tool', description: 'Test', inputSchema: { type: 'object' } }],
      }),
      callTool: vi.fn(),
      close: mockHttpClose,
    }));

    await manager.connect('stdio', { command: 'node', args: ['test.js'] });
    await manager.connect('http', { url: 'http://localhost:5678/mcp/test' });
    expect(manager.listTools()).toHaveLength(2);

    await manager.disconnectAll();
    expect(manager.listTools()).toHaveLength(0);
    expect(mockSdkClient.close).toHaveBeenCalled();
    expect(mockHttpClose).toHaveBeenCalled();
  });

  it('should handle server connection failure gracefully in connectAll', async () => {
    (Client as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      connect: vi.fn().mockRejectedValue(new Error('Connection refused')),
      close: vi.fn(),
      listTools: vi.fn(),
      callTool: vi.fn(),
    }));

    await manager.connectAll({
      failing: { command: 'nonexistent', args: [] },
    });

    expect(manager.listTools()).toEqual([]);
  });

  it('should handle HTTP server connection failure gracefully', async () => {
    (HttpMcpClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      initialize: vi.fn().mockRejectedValue(new Error('Network error')),
      callTool: vi.fn(),
      close: vi.fn(),
    }));

    await manager.connectAll({
      failing: { url: 'http://localhost:9999/mcp/bad' },
    });

    expect(manager.listTools()).toEqual([]);
  });

  describe('transport selection', () => {
    it('should use StdioClientTransport when command is provided', async () => {
      const mockClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        callTool: vi.fn(),
      };
      (Client as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockClient);

      await manager.connect('stdio-server', { command: 'node', args: ['server.js'] });

      expect(StdioClientTransport).toHaveBeenCalledWith(expect.objectContaining({
        command: 'node',
        args: ['server.js'],
      }));
    });

    it('should use HttpMcpClient when url is provided', async () => {
      (HttpMcpClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        initialize: vi.fn().mockResolvedValue({
          serverInfo: { name: 'test-server', version: '0.1.0' },
          tools: [],
        }),
        callTool: vi.fn(),
        close: vi.fn(),
      }));

      await manager.connect('http-server', { url: 'http://localhost:5678/mcp/workflow1' });

      expect(HttpMcpClient).toHaveBeenCalledWith({
        url: 'http://localhost:5678/mcp/workflow1',
        headers: undefined,
      });
      // Should NOT create SDK Client/StdioTransport
      expect(Client).not.toHaveBeenCalled();
      expect(StdioClientTransport).not.toHaveBeenCalled();
    });

    it('should throw if neither command nor url is provided', async () => {
      await expect(
        manager.connect('bad', {}),
      ).rejects.toThrow("requires either 'url' or 'command'");
    });
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
