# MicroExpert

Local AI agent: sub-1B models + RepoMemory CTT.

## Architecture

Single Node.js process with:
- **RepoMemory embedded** — memory, recall, sessions, mining (no separate server)
- **llama-server on-demand** — spawned as child_process, auto-stops after idle timeout
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
npm run build       # Compile TypeScript
npm test            # Run tests
npm start           # Start server (micro-expert serve)
```

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
- Models: `~/.micro-expert/models/`
