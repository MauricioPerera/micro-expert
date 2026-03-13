/**
 * Lightweight MCP HTTP transport using node:http.
 * Works with servers that speak Streamable HTTP (SSE responses over POST).
 * The official SDK transports hang on Windows with SSE streams — this
 * transport reads the first SSE event and destroys the connection.
 */
import http from 'node:http';
import https from 'node:https';

const REQUEST_TIMEOUT_MS = 15_000;
const NO_DATA_TIMEOUT_MS = 5_000;

export interface HttpMcpTransportOptions {
  url: string;
  headers?: Record<string, string>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Minimal MCP client that speaks directly to HTTP-based MCP servers (like n8n).
 * Not a full MCP SDK Transport — instead manages the full JSON-RPC lifecycle.
 */
export class HttpMcpClient {
  private url: URL;
  private headers: Record<string, string>;
  private sessionId: string | undefined;
  private nextId = 1;

  constructor(opts: HttpMcpTransportOptions) {
    this.url = new URL(opts.url);
    this.headers = opts.headers ?? {};
  }

  /** Initialize the MCP session and return server info. */
  async initialize(): Promise<{ serverInfo: { name: string; version: string }; tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] }> {
    const initResult = await this.request({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'micro-expert', version: '0.1.0' },
      },
    }) as JsonRpcResponse;

    if (initResult.error) throw new Error(`MCP init error: ${initResult.error.message}`);

    const result = initResult.result as { serverInfo: { name: string; version: string } };

    // Send initialized notification (fire-and-forget)
    await this.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // Discover tools
    const toolsResult = await this.request({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/list',
      params: {},
    }) as JsonRpcResponse;

    const tools = (toolsResult.result as { tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> })?.tools ?? [];

    return { serverInfo: result.serverInfo, tools };
  }

  /** Call a tool and return the result content. */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string }> }> {
    const resp = await this.request({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    }) as JsonRpcResponse;

    if (resp.error) throw new Error(`MCP tool error: ${resp.error.message}`);
    return resp.result as { content: Array<{ type: string; text?: string }> };
  }

  /** Close the session. */
  async close(): Promise<void> {
    this.sessionId = undefined;
  }

  /** Send a JSON-RPC request and parse the SSE response. */
  private request(body: JsonRpcRequest): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const reqHeaders: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(payload),
        ...this.headers,
      };
      if (this.sessionId) reqHeaders['mcp-session-id'] = this.sessionId;

      const mod = this.url.protocol === 'https:' ? https : http;
      const req = mod.request(
        {
          hostname: this.url.hostname,
          port: Number(this.url.port) || (this.url.protocol === 'https:' ? 443 : 80),
          path: this.url.pathname,
          method: 'POST',
          headers: reqHeaders,
        },
        (res) => {
          // Capture session ID from first response
          const sid = res.headers['mcp-session-id'];
          if (sid && typeof sid === 'string') this.sessionId = sid;

          let data = '';
          let resolved = false;

          const done = () => {
            if (resolved) return;
            resolved = true;
            try {
              res.destroy();
            } catch { /* ignore */ }

            // Parse SSE or plain JSON
            const parsed = this.parseResponse(data, res.headers['content-type'] as string);
            resolve(parsed);
          };

          // Timeout if no data arrives
          const noDataTimer = setTimeout(() => {
            if (!resolved) done();
          }, NO_DATA_TIMEOUT_MS);

          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
            clearTimeout(noDataTimer);
            // SSE: complete event ends with double newline
            if (data.includes('\n\n')) done();
          });
          res.on('end', () => { clearTimeout(noDataTimer); done(); });
          res.on('error', (e: NodeJS.ErrnoException) => {
            clearTimeout(noDataTimer);
            if (e.code === 'ECONNRESET' && data) { done(); return; }
            if (!resolved) { resolved = true; reject(e); }
          });
        },
      );

      req.on('error', reject);
      req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(); reject(new Error('MCP request timeout')); });
      req.write(payload);
      req.end();
    });
  }

  /** Send a notification (no response expected). */
  private notify(body: JsonRpcRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const reqHeaders: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(payload),
        ...this.headers,
      };
      if (this.sessionId) reqHeaders['mcp-session-id'] = this.sessionId;

      const mod = this.url.protocol === 'https:' ? https : http;
      const req = mod.request(
        {
          hostname: this.url.hostname,
          port: Number(this.url.port) || (this.url.protocol === 'https:' ? 443 : 80),
          path: this.url.pathname,
          method: 'POST',
          headers: reqHeaders,
        },
        (res) => {
          // Just drain the response
          const killTimer = setTimeout(() => { try { res.destroy(); } catch {} resolve(); }, 2000);
          res.on('data', () => {});
          res.on('end', () => { clearTimeout(killTimer); resolve(); });
          res.on('error', () => { clearTimeout(killTimer); resolve(); });
        },
      );

      req.on('error', (e) => {
        // Non-critical: notification errors don't block
        console.error(`[micro-expert] MCP notify error: ${(e as Error).message}`);
        resolve();
      });
      req.write(payload);
      req.end();
    });
  }

  /** Parse SSE event stream or plain JSON response. */
  private parseResponse(raw: string, contentType?: string): JsonRpcResponse {
    // SSE format: "event: message\ndata: {...}\n\n"
    const dataMatch = raw.match(/^data: (.+)$/m);
    if (dataMatch) {
      return JSON.parse(dataMatch[1]) as JsonRpcResponse;
    }

    // Plain JSON
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      return JSON.parse(trimmed) as JsonRpcResponse;
    }

    throw new Error(`Unexpected MCP response: ${raw.slice(0, 200)}`);
  }
}
