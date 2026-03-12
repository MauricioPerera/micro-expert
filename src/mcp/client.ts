import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { HttpMcpClient } from './http-transport.js';

/** Max characters returned from a tool call result */
const MAX_RESULT_CHARS = 2048;

export interface McpServerConfig {
  /** The executable to run to start the MCP server (stdio transport) */
  command?: string;
  /** Command line arguments for the server (stdio transport) */
  args?: string[];
  /** Environment variables for the server process (stdio transport) */
  env?: Record<string, string>;
  /** URL for HTTP-based MCP servers (e.g., http://localhost:5678/mcp/xxx) */
  url?: string;
  /** Custom headers for HTTP-based transports (e.g., Authorization) */
  headers?: Record<string, string>;
}

export interface McpToolInfo {
  /** Which MCP server provides this tool */
  serverName: string;
  /** Tool name (may be prefixed with serverName__ if collision) */
  qualifiedName: string;
  /** Original tool name from the MCP server */
  originalName: string;
  /** Tool description from the MCP server */
  description: string;
  /** JSON Schema for input arguments */
  inputSchema: Record<string, unknown>;
}

/**
 * Manages connections to multiple MCP servers and exposes their tools
 * for use in the agent pipeline via [MCP: tool_name {"arg": "val"}] tags.
 *
 * Supports two transport modes:
 * - **stdio**: subprocess-based via MCP SDK (for local CLI servers)
 * - **http**: direct HTTP/SSE via HttpMcpClient (for remote servers like n8n)
 */
export class McpClientManager {
  private sdkClients: Map<string, Client> = new Map();
  private stdioTransports: Map<string, StdioClientTransport> = new Map();
  private httpClients: Map<string, HttpMcpClient> = new Map();
  private tools: Map<string, McpToolInfo> = new Map();

  /**
   * Connect to all configured MCP servers.
   * Errors on individual servers are logged but don't block others.
   */
  async connectAll(servers: Record<string, McpServerConfig>): Promise<void> {
    const entries = Object.entries(servers);
    for (const [name, config] of entries) {
      try {
        await this.connect(name, config);
      } catch (e) {
        console.error(`[micro-expert] MCP: failed to connect to '${name}': ${(e as Error).message}`);
      }
    }
  }

  /**
   * Connect to a single MCP server and discover its tools.
   */
  async connect(name: string, config: McpServerConfig): Promise<void> {
    if (config.url) {
      await this.connectHttp(name, config);
    } else if (config.command) {
      await this.connectStdio(name, config);
    } else {
      throw new Error(`MCP server '${name}' requires either 'url' or 'command'`);
    }
  }

  /**
   * Connect via HTTP (for servers like n8n that expose MCP over HTTP/SSE).
   */
  private async connectHttp(name: string, config: McpServerConfig): Promise<void> {
    const client = new HttpMcpClient({ url: config.url!, headers: config.headers });
    const { serverInfo, tools } = await client.initialize();

    console.log(`[micro-expert] MCP: connected to '${name}' (${serverInfo.name} v${serverInfo.version}) via HTTP`);

    for (const tool of tools) {
      const qualifiedName = this.tools.has(tool.name)
        ? `${name}__${tool.name}`
        : tool.name;

      this.tools.set(qualifiedName, {
        serverName: name,
        qualifiedName,
        originalName: tool.name,
        description: tool.description ?? 'No description',
        inputSchema: tool.inputSchema as Record<string, unknown>,
      });
    }

    this.httpClients.set(name, client);
  }

  /**
   * Connect via stdio (for local subprocess MCP servers).
   */
  private async connectStdio(name: string, config: McpServerConfig): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command!,
      args: config.args ?? [],
      env: config.env ? { ...process.env as Record<string, string>, ...config.env } : undefined,
      stderr: 'pipe',
    });

    const client = new Client(
      { name: `micro-expert-${name}`, version: '0.1.0' },
    );

    await client.connect(transport);

    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        const qualifiedName = this.tools.has(tool.name)
          ? `${name}__${tool.name}`
          : tool.name;

        this.tools.set(qualifiedName, {
          serverName: name,
          qualifiedName,
          originalName: tool.name,
          description: tool.description ?? 'No description',
          inputSchema: tool.inputSchema as Record<string, unknown>,
        });
      }
    } catch (e) {
      console.error(`[micro-expert] MCP: failed to list tools from '${name}': ${(e as Error).message}`);
    }

    this.sdkClients.set(name, client);
    this.stdioTransports.set(name, transport);
  }

  /**
   * Disconnect a single MCP server.
   */
  async disconnect(name: string): Promise<void> {
    // Disconnect SDK client (stdio)
    const sdkClient = this.sdkClients.get(name);
    if (sdkClient) {
      try { await sdkClient.close(); } catch { /* ignore */ }
      this.sdkClients.delete(name);
    }

    const transport = this.stdioTransports.get(name);
    if (transport) {
      try { await transport.close(); } catch { /* ignore */ }
      this.stdioTransports.delete(name);
    }

    // Disconnect HTTP client
    const httpClient = this.httpClients.get(name);
    if (httpClient) {
      try { await httpClient.close(); } catch { /* ignore */ }
      this.httpClients.delete(name);
    }

    // Remove tools belonging to this server
    for (const [key, info] of this.tools) {
      if (info.serverName === name) {
        this.tools.delete(key);
      }
    }
  }

  /**
   * Disconnect all MCP servers.
   */
  async disconnectAll(): Promise<void> {
    const names = new Set([...this.sdkClients.keys(), ...this.httpClients.keys()]);
    for (const name of names) {
      await this.disconnect(name);
    }
  }

  /**
   * Call an MCP tool by its qualified name.
   * Returns the result as a string, truncated to MAX_RESULT_CHARS.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const info = this.tools.get(toolName);
    if (!info) {
      throw new Error(`Unknown MCP tool: ${toolName}`);
    }

    let result: { content?: unknown };

    // Route to the appropriate client
    const httpClient = this.httpClients.get(info.serverName);
    const sdkClient = this.sdkClients.get(info.serverName);

    if (httpClient) {
      result = await httpClient.callTool(info.originalName, args);
    } else if (sdkClient) {
      const sdkResult = await sdkClient.callTool({
        name: info.originalName,
        arguments: args,
      });
      result = { content: sdkResult.content };
    } else {
      throw new Error(`MCP server '${info.serverName}' not connected`);
    }

    // Serialize result content to string
    let text: string;
    if (Array.isArray(result.content)) {
      text = result.content
        .map((c: Record<string, unknown>) => {
          if (c.type === 'text') return c.text as string;
          return JSON.stringify(c);
        })
        .join('\n');
    } else {
      text = String(result.content ?? '');
    }

    // Truncate to avoid blowing up model context
    if (text.length > MAX_RESULT_CHARS) {
      text = text.slice(0, MAX_RESULT_CHARS) + '... [truncated]';
    }

    return text;
  }

  /**
   * Get all discovered tools.
   */
  listTools(): McpToolInfo[] {
    return [...this.tools.values()];
  }

  /**
   * Generate a compact system prompt section describing available MCP tools.
   * Limited to maxTools to avoid bloating the context for sub-1B models.
   */
  toSystemPromptSection(maxTools = 10): string {
    const tools = this.listTools().slice(0, maxTools);
    if (tools.length === 0) return '';

    const lines = tools.map(t => {
      // Extract required params for concise description
      const schema = t.inputSchema as {
        properties?: Record<string, { type?: string }>;
        required?: string[];
      };

      const params = schema?.required?.map(p => {
        const type = schema.properties?.[p]?.type ?? 'string';
        return `${p} (${type})`;
      }).join(', ') ?? '';

      const paramStr = params ? `. Params: ${params}` : '';
      return `- ${t.qualifiedName}: ${t.description}${paramStr}`;
    });

    return `To use external tools, write [MCP: tool_name {"param": "value"}].\nMCP tools:\n${lines.join('\n')}`;
  }
}
