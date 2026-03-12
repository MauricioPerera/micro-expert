# MicroExpert

Local AI agent: sub-1B models + RepoMemory CTT.

## Architecture

Single Node.js process with:
- **RepoMemory embedded** — memory, recall, sessions, profiles, mining (no separate server)
- **llama-server on-demand** — spawned as child_process, auto-stops after idle timeout (300s default)
- **Web UI** — vanilla HTML served on `GET /`, zero frontend deps
- **CLI** — commander-based: `setup`, `serve`, `chat`, `ask`, `status`

## Stack

- TypeScript (ESM, Node 20+)
- `node:http` (no express)
- `@rckflr/repomemory` (embedded)
- `commander` (CLI)
- `vitest` (tests)

## Commands

```bash
npm run build       # Compile TypeScript + copy UI assets to dist/
npm test            # Run tests (15 tests, 3 suites)
npm start           # Start server (micro-expert serve)
npm run dev         # TypeScript watch mode
```

## Agent Pipeline (v0.1 — fixed, no LLM tool calling)

1. `memory.recall(query, userId)` — retrieve CTT context + profile
2. `buildMessages()` — context FIRST in system prompt (sub-1B attention optimization)
3. `inference.chatCompletion(messages)` — send to llama-server
4. `memory.saveSession(userId, [user, assistant])` — persist the turn

Key design decisions:
- Context is placed BEFORE the role instruction in system prompt — sub-1B models pay more attention to early tokens
- User profiles (`includeProfile: true`) always included in recall for baseline context
- Inference client has retry logic for idle timeout race conditions

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
- `agent-loop.test.ts` — pipeline with mocks, streaming, history (4 tests)

Memory tests use real RepoMemory in tmpdir. Agent tests mock InferenceClient.
