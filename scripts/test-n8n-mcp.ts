import http from 'node:http';

const MCP_URL = 'http://localhost:5678/mcp/3e96ad75-9d95-43ae-af0a-00150392bd8d';

function mcpPost(path: string, body: object, sessionId?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path);
    const payload = JSON.stringify(body);
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const req = http.request(
      { hostname: u.hostname, port: Number(u.port), path: u.pathname, method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          // SSE streams don't close — grab first event and destroy
          if (res.headers['content-type']?.includes('text/event-stream') && data.includes('\n\n')) {
            res.destroy();
          }
        });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, data }));
        res.on('error', (e: NodeJS.ErrnoException) => {
          if (e.code === 'ECONNRESET') resolve({ status: res.statusCode!, headers: res.headers, data });
          else reject(e);
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

function parseSSE(raw: string): unknown {
  const m = raw.match(/^data: (.+)$/m);
  if (!m) throw new Error('No SSE data line in: ' + raw);
  return JSON.parse(m[1]);
}

// 1. Initialize
console.log('=== Initialize ===');
const init = await mcpPost(MCP_URL, {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'micro-expert', version: '0.1.0' } },
});
const sessionId = init.headers['mcp-session-id'] as string;
console.log('Session:', sessionId);
const initResult = parseSSE(init.data) as any;
console.log('Server:', initResult.result.serverInfo.name, initResult.result.serverInfo.version);

// 2. Initialized notification
console.log('\n=== Initialized ===');
const notif = await mcpPost(MCP_URL, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
console.log('Status:', notif.status);

// 3. List tools
console.log('\n=== Tools ===');
const toolsResp = await mcpPost(MCP_URL, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId);
const toolsData = parseSSE(toolsResp.data) as any;
const tools = toolsData.result?.tools ?? [];
console.log(`Found ${tools.length} tools:`);
for (const t of tools) {
  console.log(`  - ${t.name}: ${t.description ?? '(no description)'}`);
  if (t.inputSchema) console.log(`    schema: ${JSON.stringify(t.inputSchema)}`);
}

// 4. Call a tool if available
if (tools.length > 0) {
  const toolName = tools[0].name;
  console.log(`\n=== Call tool: ${toolName} ===`);
  const callResp = await mcpPost(MCP_URL, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: toolName, arguments: {} },
  }, sessionId);
  const callData = parseSSE(callResp.data) as any;
  console.log('Result:', JSON.stringify(callData.result, null, 2));
}

process.exit(0);
