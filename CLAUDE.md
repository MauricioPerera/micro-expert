# MicroExpert

Local AI agent: sub-1B models + RepoMemory CTT.

## Architecture

Single Node.js process with:
- **RepoMemory embedded** — memory, recall, sessions, profiles, mining (no separate server)
- **llama-server on-demand** — spawned as child_process, auto-stops after idle timeout (300s default)
- **Web UI** — vanilla HTML served on `GET /`, zero frontend deps
- **CLI** — commander-based: `setup`, `serve`, `chat`, `ask`, `status`, `mcp-status`
- **MCP client** — connects to external MCP servers (stdio + HTTP), exposes their tools via `[MCP: ...]` tags

## Stack

- TypeScript (ESM, Node 20+)
- `node:http` (no express)
- `@rckflr/repomemory` (embedded)
- `@modelcontextprotocol/sdk` (MCP client — stdio transport)
- `commander` (CLI)
- `vitest` (tests)

## Commands

```bash
npm run build       # Compile TypeScript + copy UI assets to dist/
npm test            # Run tests (115 tests, 7 suites)
npm start           # Start server (micro-expert serve)
npm run dev         # TypeScript watch mode
```

## Agent Pipeline

1. `memory.recall(query, userId)` — retrieve CTT context + profile
2. `buildMessages()` — context FIRST in system prompt (sub-1B attention optimization), date/time context, tool instructions
3. `inference.chatCompletion(messages)` — send to llama-server
4. `processToolCalls(content)` — detect `[CALC: expr]`, `[FETCH: METHOD url]`, and `[MCP: tool args]` tags, execute, replace with results
5. `memory.saveSession(userId, [user, assistant])` — persist the turn (with resolved tool results)

Key design decisions:
- Context is placed BEFORE the role instruction in system prompt — sub-1B models pay more attention to early tokens
- User profiles (`includeProfile: true`) always included in recall for baseline context
- Inference client has retry logic for idle timeout race conditions
- Date/time context injected so the model knows current date and time
- Tool calling via tag-based format — sub-1B models can't do native function calling
- `[CALC: expr]` — safe math evaluator (recursive descent parser, no `eval()`)
- `[FETCH: METHOD url]` — HTTP requests with security (blocked hosts, timeout, size limits)
- `[MCP: tool_name {"arg": "val"}]` — call tools from external MCP servers
- MCP client supports two transport modes:
  - **stdio** — subprocess-based via MCP SDK `StdioClientTransport` (for local CLI servers)
  - **HTTP** — custom `HttpMcpClient` using `node:http` (for remote servers like n8n that speak Streamable HTTP/SSE)
- Transport auto-detected: `url` field → HTTP, `command` field → stdio
- Custom `headers` field for HTTP-based transports (e.g., `Authorization: Bearer ...`)
- SDK SSE/StreamableHTTP transports hang on Windows — `HttpMcpClient` reads first SSE event and destroys stream
- MCP servers configured in `~/.micro-expert/config.json` under `mcpServers` (same format as claude_desktop_config.json)
- Memory import/export via API endpoints and CLI commands

## Conventions

- All source in `src/`, CLI entry in `bin/`
- No default exports — always named exports
- Errors: throw typed errors, never swallow silently
- Logging: `console.log` with `[micro-expert]` prefix for now
- Config priority: CLI args > env vars > config file > defaults
- Keep dependencies minimal — use Node built-ins when possible

## Key Paths

- User data: `~/.micro-expert/` (memory store, config, downloaded binaries)
- Memory store: `~/.micro-expert/memory/`
- Config file: `~/.micro-expert/config.json`
- llama-server binary: `~/.micro-expert/bin/llama-server`
- Models: `~/.micro-expert/models/model.gguf`

## Config Defaults

- Port: 3333
- Host: 127.0.0.1
- Agent ID: `micro-expert`
- Default User ID: `local`
- Idle timeout: 300s
- Max tokens: 512
- Temperature: 0.7
- Context size: 4096
- Recall limit: 5 items
- Recall template: `default`
- Thinking mode: off
- MCP servers: none (configure in config.json)
- MCP max tools: 10 (limit for sub-1B prompt size)

## MCP Config Example

```json
{
  "mcpServers": {
    "n8n": {
      "url": "http://localhost:5678/mcp/WORKFLOW_UUID"
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}
```

## RepoMemory API Notes

- `recall(agentId, userId, query, options)` — 4 params, agentId first
- `memories.saveOrUpdate(agentId, userId, { content, category, tags })`
- `sessions.save(agentId, userId, { content, messages })`
- `profiles.save(agentId, userId, { content, metadata })`
- Entities scoped by `type + agentId + userId` — different agentIds = isolated memory spaces

## Testing

Tests in `tests/`:
- `config.test.ts` — defaults, CLI overrides, env vars, priority (5 tests)
- `memory-provider.test.ts` — recall, sessions, search, stats (6 tests)
- `agent-loop.test.ts` — pipeline, streaming, history, date/time, CALC/FETCH/MCP tool calls (20 tests)
- `calculator.test.ts` — safe math evaluator: arithmetic, precedence, functions, errors (24 tests)
- `http-tool.test.ts` — FETCH tag parsing, URL validation, security, execution (32 tests)
- `memory-export.test.ts` — export/import round-trip, validation, error handling (8 tests)
- `mcp-client.test.ts` — MCP client: stdio connect, HTTP connect, tool discovery, calling, disconnect, prompt generation, transport selection, error handling (20 tests)

Memory tests use real RepoMemory in MEMORY_DIR. Agent tests mock InferenceClient. HTTP tests mock global fetch. MCP tests mock SDK Client/Transport + HttpMcpClient.
