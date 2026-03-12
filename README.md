# MicroExpert

**Local AI agent powered by sub-1B models and RepoMemory CTT.**

MicroExpert proves a simple thesis: a tiny model with the right memory beats a giant model with none. It combines a sub-1B parameter LLM with [RepoMemory](https://github.com/rckflr/repomemory) — a Git-inspired, content-addressable memory system — to create a local AI agent that learns from every interaction and adapts to your context over time.

No cloud. No API keys. No fine-tuning. Just context.

---

## Why

Large models are expensive, slow, and require an internet connection. Small models are fast and free but lack the knowledge to be useful beyond trivial tasks.

MicroExpert bridges this gap with **Context-Time Training (CTT)** — the idea that intelligently curated context injected at inference time can substitute for billions of parameters. A 0.5B model with CTT outperforms much larger models without memory on personalized task completion.

### How it compares to ICRL

[In-Context Reinforcement Learning](https://www.icrl.dev/) (Sarukkai et al., NeurIPS 2025) validates the same core premise: in-context examples function as an implicit fine-tune. MicroExpert goes further:

| | MicroExpert / CTT | ICRL |
|---|---|---|
| **Memory model** | Content-addressable (SHA-256), Git-inspired | Flat trajectory database |
| **Retrieval** | Hybrid TF-IDF + Matryoshka neural pyramid, MMR reranking | Single embedding cosine similarity |
| **Signal** | Correction Boost — learns from *what was fixed*, not just success/failure | Binary task outcome (pass/fail) |
| **Scope** | Any accumulated knowledge — docs, patterns, conventions, corrections | Episodic task trajectories only |
| **Memory evolution** | Deduplication, versioning, temporal decay | Append-only with periodic pruning |
| **Target model** | Sub-1B local models (designed for constrained environments) | Frontier models (GPT-4o, Claude) |

Both approaches prove that context-as-training works. MicroExpert is designed for the edge — where you want a private, local agent that compounds knowledge without sending data anywhere.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│                 MicroExpert                   │
│                                               │
│  ┌─────────────┐  ┌────────────────────────┐ │
│  │   Web UI     │  │         CLI            │ │
│  │  (vanilla)   │  │  setup·serve·chat·ask  │ │
│  └──────┬───────┘  └───────────┬────────────┘ │
│         │                      │              │
│         ▼                      ▼              │
│  ┌────────────────────────────────────────┐   │
│  │            Agent Loop                  │   │
│  │  recall → build prompt → infer → save  │   │
│  └──────────┬──────────────┬──────────────┘   │
│             │              │                  │
│  ┌──────────▼───────┐  ┌──▼───────────────┐  │
│  │   RepoMemory     │  │  llama-server    │  │
│  │   (embedded)     │  │  (child_process) │  │
│  │                  │  │                  │  │
│  │  · SHA-256 store │  │  · on-demand     │  │
│  │  · hybrid recall │  │  · idle timeout  │  │
│  │  · profiles      │  │  · GGUF models   │  │
│  │  · correction    │  │  · auto-retry    │  │
│  │    boost         │  │                  │  │
│  └──────────────────┘  └──────────────────┘  │
│                                               │
└──────────────────────────────────────────────┘
         Single Node.js process
```

Everything runs in a **single Node.js process**. RepoMemory is embedded — no separate server, no database to manage. `llama-server` is spawned on demand as a child process and auto-stops after an idle timeout (default 300s) to free RAM.

---

## Quick Start

### Prerequisites

- Node.js 20+
- ~1 GB disk space (for model + llama-server + memory store)

### Install & Setup

```bash
git clone https://github.com/MauricioPerera/micro-expert.git
cd micro-expert
npm install
npm run build

# Download model + llama-server (interactive wizard)
node dist/bin/micro-expert.js setup
```

### Run

```bash
# Start the web UI + API server (default: http://127.0.0.1:3333)
node dist/bin/micro-expert.js serve

# Or chat directly in terminal
node dist/bin/micro-expert.js chat

# One-shot question
node dist/bin/micro-expert.js ask "What is my name?"

# Check status
node dist/bin/micro-expert.js status
```

After `npm install -g`, you can use `micro-expert` directly:

```bash
micro-expert serve
micro-expert chat
micro-expert ask "How does authentication work?"
micro-expert status
```

---

## Commands

| Command | Description |
|---|---|
| `micro-expert setup` | Download model + llama-server, create `~/.micro-expert/`, initialize config |
| `micro-expert serve` | Start HTTP server with Web UI on `http://127.0.0.1:3333` |
| `micro-expert chat` | Interactive terminal chat with streaming output |
| `micro-expert ask <query>` | One-shot question, prints answer and exits |
| `micro-expert status` | Show model info, memory stats, config summary |

### CLI Flags

| Flag | Description | Default |
|---|---|---|
| `--port <n>` | HTTP server port | `3333` |
| `--model <path>` | Path to GGUF model file | `~/.micro-expert/models/model.gguf` |
| `--light` | Use lightweight model (Gemma 3 270M) during setup | `false` |
| `--no-open` | Don't open browser on `serve` | `false` |

---

## API

MicroExpert exposes an OpenAI-compatible API:

### `POST /v1/chat/completions`

```bash
curl -X POST http://127.0.0.1:3333/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "What is my name?"}],
    "stream": false
  }'
```

Supports `"stream": true` for Server-Sent Events (SSE) streaming.

### `GET /health`

Returns memory status, inference status, and memory stats.

### `GET /v1/models`

Returns the currently loaded model.

### `GET /history?userId=local&limit=20`

List conversation sessions.

### `GET /history/:sessionId`

Get a specific conversation session with messages.

---

## How Memory Works

MicroExpert uses RepoMemory's CTT pipeline:

1. **Store** — Every conversation turn is persisted as a session with SHA-256 content-addressing. Identical content is automatically deduplicated.

2. **Recall** — When you ask a question, the hybrid retrieval engine runs TF-IDF keyword matching with composite scoring (relevance x decay x access frequency x correction boost). Results are injected into the system prompt *before* the model instruction for maximum attention from sub-1B models.

3. **Profile** — User profiles are always included in recall (`includeProfile: true`), providing a consistent baseline of user information regardless of query keyword match.

4. **Mine** — A background process can analyze stored sessions to extract memories, patterns, and implicit knowledge using the local model.

5. **Correct** — The Correction Boost mechanism tracks corrections to the agent's output. Memories associated with improvements get boosted; those leading to errors get suppressed.

Over time, the agent builds a compressed, curated representation of your context that fits in a sub-1B model's context window. The memory is the model's experience.

---

## Configuration

Config priority: **CLI args > env vars > config file > defaults**

### Config file (`~/.micro-expert/config.json`)

```json
{
  "modelPath": "~/.micro-expert/models/model.gguf",
  "port": 3333,
  "host": "127.0.0.1",
  "idleTimeout": 300,
  "maxTokens": 512,
  "temperature": 0.7,
  "contextSize": 4096,
  "recallLimit": 5,
  "contextBudget": 4096,
  "thinkingMode": false,
  "recallTemplate": "default",
  "threads": 0
}
```

### Environment variables

All use the `MICRO_EXPERT_` prefix:

| Variable | Description | Default |
|---|---|---|
| `MICRO_EXPERT_PORT` | HTTP server port | `3333` |
| `MICRO_EXPERT_HOST` | HTTP server host | `127.0.0.1` |
| `MICRO_EXPERT_MODEL_PATH` | Path to GGUF model file | `~/.micro-expert/models/model.gguf` |
| `MICRO_EXPERT_MAX_TOKENS` | Max generation tokens | `512` |
| `MICRO_EXPERT_TEMPERATURE` | Sampling temperature | `0.7` |
| `MICRO_EXPERT_IDLE_TIMEOUT` | Seconds before llama-server auto-stops | `300` |
| `MICRO_EXPERT_CONTEXT_SIZE` | Context window size | `4096` |
| `MICRO_EXPERT_THREADS` | CPU threads for inference (0 = auto) | `0` |
| `MICRO_EXPERT_THINKING` | Enable thinking mode (`true`/`false`) | `false` |
| `MICRO_EXPERT_RECALL_LIMIT` | Max items to recall from memory | `5` |
| `MICRO_EXPERT_CONTEXT_BUDGET` | Max chars for CTT context injection | `4096` |
| `MICRO_EXPERT_RECALL_TEMPLATE` | Recall template: `default`, `technical`, `support`, `rag_focused` | `default` |

---

## Project Structure

```
micro-expert/
├── bin/
│   └── micro-expert.ts          # CLI entry point (commander)
├── src/
│   ├── index.ts                 # Public API exports
│   ├── config.ts                # Config loading (defaults + env + file + CLI)
│   ├── agent/
│   │   ├── loop.ts              # Core pipeline: recall → prompt → infer → save
│   │   └── tools.ts             # Tool registry (recall, search, save_memory)
│   ├── inference/
│   │   ├── manager.ts           # llama-server lifecycle (spawn, health, idle)
│   │   └── client.ts            # HTTP client for llama-server (+ SSE streaming)
│   ├── memory/
│   │   └── provider.ts          # RepoMemory embedded wrapper
│   ├── server/
│   │   ├── http.ts              # node:http server (API + UI serving)
│   │   └── routes.ts            # API route handlers
│   ├── setup/
│   │   └── wizard.ts            # Setup wizard (download model + llama-server)
│   └── ui/
│       └── index.html           # Web UI SPA (vanilla HTML/CSS/JS, ~15KB)
├── tests/
│   ├── config.test.ts           # Config loading tests (5 tests)
│   ├── memory-provider.test.ts  # Memory operations tests (6 tests)
│   └── agent-loop.test.ts       # Agent pipeline tests (4 tests)
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── CLAUDE.md                    # Instructions for Claude Code
└── README.md
```

---

## Development

```bash
git clone https://github.com/MauricioPerera/micro-expert.git
cd micro-expert
npm install
npm run build       # Compile TypeScript + copy UI assets
npm test            # Run all 15 tests
npm run dev         # TypeScript watch mode
npm start           # Start server (micro-expert serve)
```

### Running Tests

```bash
npm test              # Run once
npm run test:watch    # Watch mode
```

Tests use vitest with mocks for inference and real RepoMemory instances for memory tests.

---

## Key Paths

| Path | Purpose |
|---|---|
| `~/.micro-expert/` | All user data (created on first run) |
| `~/.micro-expert/memory/` | RepoMemory content-addressable store |
| `~/.micro-expert/config.json` | User configuration |
| `~/.micro-expert/bin/llama-server` | Downloaded llama-server binary |
| `~/.micro-expert/models/model.gguf` | Default GGUF model file |

---

## Stack

| Component | Technology |
|---|---|
| **Runtime** | Node.js 20+ (ESM) |
| **Language** | TypeScript (strict mode) |
| **HTTP** | `node:http` (no Express) |
| **Memory** | `@rckflr/repomemory` (embedded, no separate server) |
| **Inference** | `llama-server` from llama.cpp (spawned on-demand) |
| **CLI** | `commander` |
| **Tests** | `vitest` (15 tests across 3 suites) |
| **Frontend** | Vanilla HTML/CSS/JS (zero dependencies, ~15KB) |

---

## Default Models

| Model | Size | Use case |
|---|---|---|
| **Qwen2.5-0.5B-Instruct** (Q4_K_M) | ~469 MB | Default — good balance of quality and speed |
| **Gemma 3 270M** (Q4_K_M) | ~170 MB | `--light` — minimal footprint, faster inference |

---

## Roadmap

- [ ] `micro-expert index <path>` — ingest a codebase into memory
- [ ] MCP server mode — expose as a tool for Claude Code, Cursor, etc.
- [ ] Auto-mining — automatically extract memories from sessions during idle time
- [ ] Multi-model support — swap models per task type
- [ ] Memory export/import — share curated memory across machines
- [ ] Metrics dashboard — visualize memory growth, recall accuracy, correction rate

---

## Research

MicroExpert is the reference implementation for Context-Time Training (CTT):

> **"Context Is All You Need: Evolutive Agentic Intelligence through Context-Time Training"**

Related work:
- Sarukkai et al. *"Self-Generated In-Context Examples Improve LLM Agents"* (NeurIPS 2025) — validates that in-context examples function as implicit fine-tuning
- Moeini et al. (2025) — comprehensive survey of ICRL methods and benchmarks

---

## License

MIT

---

Built by [Automators.work](https://automators.work) / [@rckflr](https://github.com/rckflr)
