import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Max characters returned from a tool call result */
const MAX_RESULT_CHARS = 2048;

export interface McpServerConfig {
  /** The executable to run to start the MCP server */
  command: string;
  /** Command line arguments for the server */
  args?: string[];
  /** Environment variables for the server process */
  env?: Record<string, string>;
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
 */
export class McpClientManager {
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, StdioClientTransport> = new Map();
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
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env ? { ...process.env as Record<string, string>, ...config.env } : undefined,
      stderr: 'pipe',
    });

    const client = new Client(
      { name: `micro-expert-${name}`, version: '0.1.0' },
    );

    await client.connect(transport);

    // Discover tools from this server
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        // Handle name collisions: prefix with serverName__ if already taken
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

    this.clients.set(name, client);
    this.transports.set(name, transport);
  }

  /**
   * Disconnect a single MCP server.
   */
  async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      try {
        await client.close();
      } catch { /* ignore close errors */ }
      this.clients.delete(name);
    }

    const transport = this.transports.get(name);
    if (transport) {
      try {
        await transport.close();
      } catch { /* ignore close errors */ }
      this.transports.delete(name);
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
    const names = [...this.clients.keys()];
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

    const client = this.clients.get(info.serverName);
    if (!client) {
      throw new Error(`MCP server '${info.serverName}' not connected`);
    }

    const result = await client.callTool({
      name: info.originalName,
      arguments: args,
    });

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
