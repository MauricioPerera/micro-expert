# Contributing to MicroExpert

## Setup

```bash
git clone https://github.com/MauricioPerera/micro-expert.git
cd micro-expert
npm install
npm run build
npm test
```

## Development Workflow

1. Make changes in `src/` or `bin/`
2. Run `npm run build` to compile TypeScript and copy UI assets
3. Run `npm test` to verify all 15 tests pass
4. Test manually with `node dist/bin/micro-expert.js serve --no-open`

### Watch Mode

```bash
npm run dev         # TypeScript watch (recompiles on save)
npm run test:watch  # Vitest watch (reruns tests on save)
```

## Code Style

- **TypeScript** with strict mode enabled
- **ESM** (`"type": "module"` in package.json)
- **Named exports only** — no default exports
- **Node built-ins preferred** — avoid adding dependencies when `node:*` modules suffice
- **Error handling** — throw typed errors, never swallow silently
- **Logging** — use `console.log('[micro-expert] ...')` prefix

## Project Layout

```
src/
├── config.ts          # Config system (CLI > env > file > defaults)
├── index.ts           # Public API re-exports
├── agent/             # Core agent logic
│   ├── loop.ts        # Pipeline: recall → prompt → infer → save
│   └── tools.ts       # Tool definitions for future LLM tool calling
├── inference/         # llama-server integration
│   ├── manager.ts     # Process lifecycle, health checks, idle timeout
│   └── client.ts      # HTTP client with retry logic, SSE streaming
├── memory/            # RepoMemory wrapper
│   └── provider.ts    # Thin wrapper: recall, save, search, profiles
├── server/            # HTTP server
│   ├── http.ts        # node:http server, CORS, static file serving
│   └── routes.ts      # API route handlers (OpenAI-compatible)
├── setup/             # First-run wizard
│   └── wizard.ts      # Downloads model + llama-server binary
└── ui/                # Frontend
    └── index.html     # SPA: chat, history, image upload (~15KB)
```

## Testing

```bash
npm test    # Run all tests once
```

### Test Structure

- **`tests/config.test.ts`** — Config loading, merging, env vars (5 tests)
- **`tests/memory-provider.test.ts`** — Real RepoMemory in tmpdir (6 tests)
- **`tests/agent-loop.test.ts`** — Mocked inference, pipeline verification (4 tests)

### Writing Tests

- Use `vitest` (`describe`, `it`, `expect`, `vi.fn()`)
- For memory tests: create a temp directory, use real RepoMemory, clean up in `afterEach`
- For agent/inference tests: mock the client with `vi.fn().mockResolvedValue()`

## Architecture Notes

### Why context goes FIRST in system prompt

Sub-1B models have limited attention. Placing recalled CTT context at the start of the system message (before the role instruction) ensures the model processes it with full attention weight.

### Why profiles matter

Keyword-based recall may miss queries that don't overlap with stored memory terms (e.g., "Where am I from?" won't match "Costa Rica"). User profiles are always included via `includeProfile: true`, providing a consistent baseline.

### Inference retry logic

The InferenceClient retries once on `fetch failed` errors. This handles the race condition where the idle timeout kills llama-server while a request is in-flight. The retry triggers `ensureRunning()` which restarts the server.

## Adding a New API Route

1. Add the handler function in `src/server/routes.ts`
2. Add the path match in `handleRoute()`
3. Use `sendJson()` / `sendError()` helpers for responses
4. Build and test manually with `curl`

## Adding a New CLI Command

1. Add the command in `bin/micro-expert.ts` using commander's `.command()` API
2. Import and call the relevant modules from `src/`
3. Follow the pattern of existing commands (init components, run, cleanup)
