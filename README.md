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
┌───────────────────────────────────────────────────────────┐
│                      MicroExpert                          │
│                                                           │
│  ┌─────────────┐  ┌────────────────────────────────────┐  │
│  │   Web UI     │  │              CLI                   │  │
│  │  (vanilla)   │  │  setup·serve·chat·ask·mcp-status   │  │
│  └──────┬───────┘  └──────────────┬─────────────────────┘  │
│         │                         │                        │
│         ▼                         ▼                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  Agent Loop                         │   │
│  │  recall → build prompt → infer → tool calls → save  │   │
│  │                                                     │   │
│  │  Tools: [CALC: expr]  [FETCH: METHOD url]           │   │
│  │         [MCP: tool_name {"args"}]                   │   │
│  └──────┬──────────────┬──────────────┬────────────────┘   │
│         │              │              │                     │
│  ┌──────▼──────┐ ┌─────▼──────┐ ┌────▼─────────────────┐  │
│  │ RepoMemory  │ │llama-server│ │    MCP Client         │  │
│  │ (embedded)  │ │(child_proc)│ │                       │  │
│  │             │ │            │ │ · stdio (SDK)         │  │
│  │ · SHA-256   │ │ · on-demand│ │ · HTTP/SSE (custom)   │  │
│  │ · hybrid    │ │ · idle     │ │ · auto-detect         │  │
│  │   recall    │ │   timeout  │ │   transport           │  │
│  │ · profiles  │ │ · GGUF     │ │                       │  │
│  │ · correction│ │ · retry    │ │  ┌─────┐ ┌─────────┐  │  │
│  │   boost     │ │            │ │  │ n8n │ │filesys  │  │  │
│  └─────────────┘ └────────────┘ │  └─────┘ └─────────┘  │  │
│                                 └────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
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

# Check MCP tool availability
node dist/bin/micro-expert.js mcp-status
```

After `npm install -g`, you can use `micro-expert` directly:

```bash
micro-expert serve
micro-expert chat
micro-expert ask "How does authentication work?"
micro-expert status
micro-expert mcp-status
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
| `micro-expert mcp-status` | Connect to all configured MCP servers, list available tools, disconnect |
| `micro-expert export-memories` | Export memories and skills to a JSON file (v1 or v2 pack format) |
| `micro-expert import-memories <file>` | Import memories from a JSON file |
| `micro-expert install <source>` | Install a memory pack from a URL or local file |
| `micro-expert mine` | Mine stored sessions to extract skills and memories using the local model |

### CLI Flags

| Flag | Description | Default |
|---|---|---|
| `--port <n>` | HTTP server port | `3333` |
| `--model <path>` | Path to GGUF model file | `~/.micro-expert/models/model.gguf` |
| `--light` | Use lightweight model (Gemma 3 270M) during setup | `false` |
| `--no-open` | Don't open browser on `serve` | `false` |

---

## Tool Calling

Sub-1B models can't do native function calling, so MicroExpert uses a **tag-based format**. The model emits tags in its response, the agent loop detects and executes them, and replaces each tag with the result before returning the final answer.

### Calculator — `[CALC: expr]`

Safe math evaluator using a recursive descent parser (no `eval()`). Supports arithmetic, parentheses, and common functions (`sqrt`, `sin`, `cos`, `abs`, `log`, `pow`, `round`, `ceil`, `floor`, `min`, `max`).

```
What's the square root of 144?
→ Model outputs: The answer is [CALC: sqrt(144)]
→ Agent replaces: The answer is 12
```

### HTTP Fetch — `[FETCH: METHOD url]`

Makes HTTP requests with security controls: blocked internal hosts, request timeout, response size limits (2048 chars).

```
What's the weather API response?
→ Model outputs: [FETCH: GET https://api.example.com/weather]
→ Agent replaces with the response body (truncated to 2048 chars)
```

### MCP Tools — `[MCP: tool_name {"args"}]`

Calls tools from external MCP servers. See the [MCP Integration](#mcp-integration) section below.

```
Run the code tool with input "hello"
→ Model outputs: [MCP: Code_Tool {"input": "hello"}]
→ Agent replaces with the tool's result
```

All three tag types can appear in the same response and are processed sequentially (CALC → FETCH → MCP).

#### Bracket-aware parsing

MCP tags use a bracket-counting parser instead of regex. This correctly handles JSON arguments with nested brackets — for example, `"position": [250, 300]` inside a workflow definition won't prematurely close the tag.

#### Code block unwrapping

Small models sometimes wrap tool tags in markdown code fences (` ```mcp ... ``` `). MicroExpert automatically detects and unwraps tool tags from code blocks before processing. Only blocks containing tool tags are unwrapped — regular code blocks are left intact.

### Vision — Image Input

The Web UI supports attaching images via the 📎 button. Images are sent as base64 data URLs in the `image` field of the chat completion request. The model receives them as `image_url` content parts (requires a vision-capable GGUF model).

> **Note**: Vision requires an `mmproj` (multimodal projector) GGUF file. Qwen3.5 models are vision-capable — download the `mmproj-F16.gguf` from the same HuggingFace repo and place it in `~/.micro-expert/models/`. MicroExpert auto-detects mmproj files in the same directory as the model. Text-only models (Qwen2.5, Gemma 3) will ignore image inputs.

---

## MCP Integration

MicroExpert acts as an **MCP client** — it connects to external MCP servers and exposes their tools to the model via `[MCP: ...]` tags.

### Supported Transports

| Transport | Config field | Use case |
|---|---|---|
| **stdio** | `command` + `args` | Local CLI-based MCP servers (e.g., `@modelcontextprotocol/server-filesystem`) |
| **HTTP/SSE** | `url` | Remote MCP servers that speak Streamable HTTP/SSE (e.g., n8n, custom servers) |

Transport is **auto-detected**: if the config has a `url` field → HTTP, if it has a `command` field → stdio.

> **Note**: The official SDK transports (`SSEClientTransport`, `StreamableHTTPClientTransport`) hang on Windows due to SSE stream handling. MicroExpert uses a custom `HttpMcpClient` built on `node:http` that reads the first SSE event and destroys the stream.

### Configuration

Add MCP servers to `~/.micro-expert/config.json`:

```json
{
  "mcpServers": {
    "n8n": {
      "url": "http://localhost:5678/mcp/YOUR-WORKFLOW-UUID",
      "headers": {
        "Authorization": "Bearer your-token"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    }
  },
  "mcpMaxTools": 10
}
```

| Field | Description |
|---|---|
| `url` | HTTP/SSE endpoint URL (triggers HTTP transport) |
| `command` | Executable to run (triggers stdio transport) |
| `args` | Arguments for the command |
| `env` | Environment variables for the subprocess |
| `headers` | Custom HTTP headers (e.g., `Authorization`) — HTTP transport only |

### How it works

1. On startup, `McpClientManager` connects to all configured servers
2. Each server's tools are discovered and registered
3. Tool descriptions are injected into the system prompt (compact format for sub-1B models)
4. When the model emits `[MCP: tool_name {"args"}]`, the agent calls the appropriate server
5. Results are serialized to text and replace the tag in the response

### Tool limit

Default `mcpMaxTools: 10` — limits the number of tool descriptions injected into the prompt. Sub-1B models have small context windows; too many tools degrade response quality.

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

Supports `"stream": true` for Server-Sent Events (SSE) streaming. Optional `"image"` field accepts a base64 data URL for vision models.

### `GET /health`

Returns memory status, inference status, and memory stats.

### `GET /v1/models`

Returns the currently loaded model.

### `GET /history?userId=local&limit=20`

List conversation sessions.

### `GET /history/:sessionId`

Get a specific conversation session with messages.

### `POST /memory/export`

Export memories as JSON. Accepts optional filters:

```bash
curl -X POST http://127.0.0.1:3333/memory/export \
  -H "Content-Type: application/json" \
  -d '{"userId": "local", "category": "general"}'
```

### `POST /memory/import`

Import memories from a previous export:

```bash
curl -X POST http://127.0.0.1:3333/memory/import \
  -H "Content-Type: application/json" \
  -d '{"memories": [...]}'
```

---

## How Memory Works

MicroExpert uses RepoMemory's CTT pipeline:

1. **Store** — Every conversation turn is persisted as a session with SHA-256 content-addressing. Identical content is automatically deduplicated.

2. **Recall** — When you ask a question, the hybrid retrieval engine runs TF-IDF keyword matching with composite scoring (relevance x decay x access frequency x correction boost). Results are injected into the system prompt *before* the model instruction for maximum attention from sub-1B models.

3. **Few-Shot from Memory** — Recalled memories containing tool patterns (`[MCP: ...]`, `[CALC: ...]`, `[FETCH: ...]`) are automatically converted into user/assistant conversation pairs and injected as few-shot examples before the user's message. This teaches the model tool-calling patterns *by example* rather than by instruction — critical for sub-1B models that respond poorly to abstract directions but reliably imitate demonstrated patterns. Up to 3 examples are injected per request to stay within context budget.

4. **Profile** — User profiles are always included in recall (`includeProfile: true`), providing a consistent baseline of user information regardless of query keyword match.

5. **Mine** — The local model analyzes stored sessions and automatically extracts structured memories, skills, and patterns. Mining happens in two modes:
   - **Auto-mining** — Every session is mined automatically after being saved (when `serve` or `chat` is running). The same llama-server that handles inference also powers the mining extraction.
   - **Manual mining** — `micro-expert mine` processes stored sessions on demand. Useful for mining historical sessions or after importing conversations.

   Mining is what makes skills **self-generating**: the model observes repeated tool-calling patterns in sessions and crystallizes them into skill memories. These skills are then recalled as few-shot examples in future interactions, creating a virtuous cycle.

6. **Correct** — The Correction Boost mechanism tracks corrections to the agent's output. Memories associated with improvements get boosted; those leading to errors get suppressed.

Over time, the agent builds a compressed, curated representation of your context that fits in a sub-1B model's context window. The memory is the model's experience.

### Teaching the Model New Skills

You can teach MicroExpert to use new tools by saving skill memories. When the model sees these skills recalled as few-shot examples, it imitates the pattern:

```bash
# Save a skill memory via the API
curl -X POST http://127.0.0.1:3333/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "/save_memory Para listar workflows de n8n: [MCP: n8n_list_workflows {}]"}]}'
```

Or programmatically:

```typescript
memory.saveMemory('local',
  'El usuario pide crear un workflow en n8n. Respuesta correcta: [MCP: n8n_create_workflow {"name": "My Workflow", "nodes": [...], "connections": {}, "settings": {}}]',
  'mcp-skill',
  ['n8n', 'mcp', 'create', 'workflow']
);
```

The next time a user asks to create a workflow, recall will find this memory, extract it as a few-shot example (user: "crear un workflow en n8n" → assistant: `[MCP: n8n_create_workflow {...}]`), and inject it into the conversation. The model then imitates the pattern with the user's specific parameters.

This mechanism is **model-agnostic** — the same skills work across different model sizes (tested with both 0.8B and 2B Qwen3.5).

### Memory Packs — Solving Cold Start

Memory Packs are distributable JSON files containing memories and skills that can be shared via GitHub, downloaded via URL, and installed with a single command. They solve the **cold-start problem** — a fresh MicroExpert instance can immediately use MCP tools, follow domain conventions, and recall learned patterns without any prior interaction.

#### Pack Format (v2)

```json
{
  "version": 2,
  "exportedAt": "2026-03-13T...",
  "userId": "local",
  "agentId": "micro-expert",
  "count": 5,
  "pack": {
    "name": "n8n MCP Skills",
    "description": "Tool-calling skills for n8n workflow automation",
    "author": "MicroExpert",
    "packVersion": "1.0.0",
    "models": ["qwen3.5-0.8b", "qwen3.5-2b"],
    "packTags": ["n8n", "mcp", "workflow"]
  },
  "memories": [
    { "content": "General knowledge...", "category": "fact", "tags": ["topic"] }
  ],
  "skills": [
    { "content": "To list workflows: [MCP: n8n_list_workflows {}]", "category": "mcp-skill", "tags": ["n8n"] }
  ]
}
```

Skills are memories that contain tool-calling patterns (`[MCP: ...]`, `[CALC: ...]`, `[FETCH: ...]`). On import, they're stored as regular memories but on recall, they're automatically extracted as few-shot conversation examples.

#### Creating a Pack

```bash
# Export with pack metadata (creates v2 format)
micro-expert export-memories \
  --pack-name "n8n MCP Skills" \
  --pack-desc "Tool-calling skills for n8n workflow automation" \
  --pack-author "YourName" \
  --pack-version "1.0.0" \
  --pack-models "qwen3.5-0.8b,qwen3.5-2b" \
  --pack-tags "n8n,mcp,automation" \
  --output n8n-skills.json

# Export without metadata (auto-detects v2 if skills exist, otherwise v1)
micro-expert export-memories --output my-memories.json
```

#### Installing a Pack

```bash
# From a local file
micro-expert install n8n-skills.json

# From a URL (GitHub raw, any HTTP endpoint)
micro-expert install https://raw.githubusercontent.com/user/repo/main/packs/n8n-skills.json

# Import to a specific user
micro-expert install n8n-skills.json --userId alice
```

#### API Endpoints

```bash
# Export (downloads as JSON file)
GET /v1/memories/export?userId=local

# Import (accepts v1 or v2 format)
POST /v1/memories/import?userId=local
Content-Type: application/json
Body: <MemoryExportFile>
```

#### Catalog Idea

Packs can be published as JSON files in a GitHub repository, organized by domain:

```
micro-expert-packs/
├── packs/
│   ├── n8n-mcp-skills.json       # n8n workflow automation
│   ├── github-mcp-skills.json    # GitHub API via MCP
│   ├── postgres-mcp-skills.json  # PostgreSQL queries via MCP
│   └── math-skills.json          # Advanced CALC patterns
└── README.md                     # Pack catalog with descriptions
```

Users install packs with a single command:
```bash
micro-expert install https://raw.githubusercontent.com/.../packs/n8n-mcp-skills.json
```

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
  "threads": 0,
  "mcpServers": {},
  "mcpMaxTools": 10,
  "mmprojPath": ""
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
| `MICRO_EXPERT_MMPROJ_PATH` | Path to mmproj GGUF for vision (empty = auto-detect, `none` = disabled) | `""` (auto) |

---

## Project Structure

```
micro-expert/
├── bin/
│   └── micro-expert.ts              # CLI entry point (commander)
├── src/
│   ├── index.ts                     # Public API exports
│   ├── config.ts                    # Config loading (defaults + env + file + CLI)
│   ├── agent/
│   │   ├── loop.ts                  # Core pipeline: recall → prompt → infer → tools → save
│   │   ├── tools.ts                 # Tool registry (recall, search, save_memory)
│   │   └── http-tool.ts            # FETCH tag: HTTP requests with security controls
│   ├── inference/
│   │   ├── manager.ts               # llama-server lifecycle (spawn, health, idle)
│   │   └── client.ts               # HTTP client for llama-server (+ SSE streaming)
│   ├── mcp/
│   │   ├── index.ts                 # MCP exports
│   │   ├── client.ts               # McpClientManager: stdio + HTTP dual transport
│   │   └── http-transport.ts       # Custom HttpMcpClient (bypasses SDK hang on Windows)
│   ├── memory/
│   │   └── provider.ts             # RepoMemory embedded wrapper
│   ├── server/
│   │   ├── http.ts                  # node:http server (API + UI serving)
│   │   └── routes.ts               # API route handlers
│   ├── setup/
│   │   └── wizard.ts               # Setup wizard (download model + llama-server)
│   └── ui/
│       └── index.html               # Web UI SPA (vanilla HTML/CSS/JS, ~15KB)
├── tests/
│   ├── config.test.ts               # Config loading (5 tests)
│   ├── memory-provider.test.ts      # Memory operations (6 tests)
│   ├── agent-loop.test.ts           # Agent pipeline + tool calls (24 tests)
│   ├── calculator.test.ts           # Safe math evaluator (24 tests)
│   ├── http-tool.test.ts            # FETCH tag parsing + security (32 tests)
│   ├── memory-export.test.ts        # Export/import round-trip, v2 packs (11 tests)
│   └── mcp-client.test.ts          # MCP client: stdio + HTTP (20 tests)
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── CLAUDE.md
└── README.md
```

---

## Development

```bash
git clone https://github.com/MauricioPerera/micro-expert.git
cd micro-expert
npm install
npm run build       # Compile TypeScript + copy UI assets
npm test            # Run all 122 tests (7 suites)
npm run dev         # TypeScript watch mode
npm start           # Start server (micro-expert serve)
```

### Running Tests

```bash
npm test              # Run once
npm run test:watch    # Watch mode
```

Tests use vitest with mocks for inference and real RepoMemory instances for memory tests. MCP tests mock both SDK transports and the custom HttpMcpClient.

---

## Key Paths

| Path | Purpose |
|---|---|
| `~/.micro-expert/` | All user data (created on first run) |
| `~/.micro-expert/memory/` | RepoMemory content-addressable store |
| `~/.micro-expert/config.json` | User configuration (including MCP servers) |
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
| **MCP** | `@modelcontextprotocol/sdk` (stdio) + custom `HttpMcpClient` (HTTP/SSE) |
| **CLI** | `commander` |
| **Tests** | `vitest` (122 tests across 7 suites) |
| **Frontend** | Vanilla HTML/CSS/JS (zero dependencies, ~15KB) |

---

## Default Models

| Model | Size | Use case |
|---|---|---|
| **Qwen2.5-0.5B-Instruct** (Q4_K_M) | ~469 MB | Default — good balance of quality and speed |
| **Qwen3.5-0.8B** (Q4_K_M) | ~508 MB | Upgrade — better reasoning, vision, supports thinking mode |
| **Qwen3.5-2B** (Q4_K_M) | ~1.2 GB | Best quality — more consistent tool calling, vision capable |
| **Gemma 3 270M** (Q4_K_M) | ~170 MB | `--light` — minimal footprint, faster inference |

### Thinking Mode (Qwen3.5)

Qwen3.5 supports a "thinking mode" where the model emits `<think>...</think>` blocks with internal reasoning before the actual response. This is **disabled by default** (`thinkingMode: false`) because:

- It significantly increases response time and token usage
- Sub-1B models produce low-quality reasoning that rarely helps
- Thinking tokens can interfere with tag-based tool calling (the model may solve the problem internally and emit pre-computed results instead of proper `[CALC: ...]` tags)

When disabled, MicroExpert injects `/no_think` into the system prompt (Qwen3.5-specific directive). As a safety net, thinking tokens are also stripped both server-side (non-streaming) and client-side (streaming UI), since the model may still emit them occasionally.

To enable: set `"thinkingMode": true` in config or `MICRO_EXPERT_THINKING=true`.

---

## Security

MicroExpert includes several safety measures for local operation:

- **Request body limit** — 10 MB max on all API requests (supports base64 image payloads)
- **SSE timeout** — 5-minute inactivity timeout on streaming connections
- **FETCH tool restrictions** — Blocked hosts (localhost, loopback, private IPs), blocked schemes (file://, ftp://, data:), 10s timeout, 32 KB response limit, 2048 char result truncation
- **Config validation** — Port (1-65535), temperature (0-2), threads (≥0), maxTokens (≥1), contextSize (≥128) validated on load with fallback to defaults
- **Safe math evaluator** — Recursive descent parser for `[CALC:]` tags — no `eval()`, no code execution
- **Memory import validation** — Payload structure validated before processing
- **Inference retry** — Detects transient errors (ECONNREFUSED, socket hang up, etc.) with automatic retry on llama-server restart races

---

## Roadmap

- [ ] `micro-expert index <path>` — ingest a codebase into memory
- [ ] MCP server mode — expose as a tool for Claude Code, Cursor, etc.
- [x] Auto-mining — automatically extract memories and skills from sessions using the local model
- [ ] Multi-model support — swap models per task type
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
