# MicroExpert

**Local AI agent powered by sub-1B models and RepoMemory CTT.**

MicroExpert proves a simple thesis: a tiny model with the right memory beats a giant model with none. It combines a sub-1B parameter LLM with [RepoMemory](https://github.com/rckflr/repomemory) — a Git-inspired, content-addressable memory system — to create a local AI agent that learns from every interaction and adapts to your context over time.

No cloud. No API keys. No fine-tuning. Just context.

---

## Why

Large models are expensive, slow, and require an internet connection. Small models are fast and free but lack the knowledge to be useful beyond trivial tasks.

MicroExpert bridges this gap with **Context-Time Training (CTT)** — the idea that intelligently curated context injected at inference time can substitute for billions of parameters. A 0.5B model with CTT outperforms much larger models without memory on personalized task completion.

### Key Advantages

#### Complete Privacy

Your data never leaves your machine. There are no API calls to external servers, no telemetry, no cloud storage. Every conversation, memory, skill, and user profile lives in `~/.micro-expert/memory/` — a local directory you fully control. This makes MicroExpert suitable for environments where data sovereignty is non-negotiable: medical records, legal documents, proprietary codebases, financial data, personal journals, or any context where sending information to a third party is unacceptable.

#### Fully Offline

MicroExpert works without an internet connection after initial setup. The model runs locally via llama-server, memory is embedded, and the entire inference pipeline operates in a single Node.js process. Deploy it on an air-gapped workstation, a field laptop, a submarine, or anywhere you need AI without connectivity.

#### Runs on Low-Resource Hardware

Designed for the edge. A quantized 0.8B model uses ~500 MB of disk and runs comfortably on 2 GB of RAM with no GPU required. The lightweight option (Gemma 3 270M) needs just ~170 MB. This means MicroExpert works on:

- Old laptops and refurbished hardware
- Raspberry Pi and single-board computers
- Virtual machines with minimal allocation
- CI/CD runners and build agents
- Embedded systems and IoT gateways

llama-server is spawned on demand and auto-stops after an idle timeout (default 300s), so RAM is freed when not in use.

#### No Fine-Tuning Required

Traditional approaches to specializing a model require fine-tuning: collecting datasets, running GPU-intensive training, managing model versions, and risking catastrophic forgetting. MicroExpert replaces all of that with memory. Skills are just JSON entries that get recalled at inference time as few-shot examples. To teach the model something new, you save a memory. To forget something, you delete it. There is no training step, no GPU, no waiting — changes take effect on the next request.

#### Knowledge as Portable Data

Memory is just files. You can:

- **Back up** your agent's knowledge with `cp` or `git`
- **Export** specific topics with `micro-expert export-memories --filter "n8n" --tags "mcp"`
- **Share** knowledge as Memory Packs — versioned JSON files publishable on GitHub
- **Restore** from backup by copying the memory directory back
- **Diff** what the agent knows between two points in time
- **Version-control** memory alongside your project

Unlike fine-tuning (where knowledge is baked into weights and inseparable from the model), MicroExpert's knowledge is transparent, editable, and portable.

#### Model-Agnostic Memory

The same memory works across different models. You can:

- **Swap models per task**: use a 270M model for fast lookups, a 0.8B for general chat, and a 2B for complex tool calling — all sharing the same memory store
- **Upgrade models** without losing knowledge: switch from Qwen2.5-0.5B to Qwen3.5-0.8B and everything the agent learned transfers instantly
- **Downgrade for resource constraints**: move to a smaller model on weaker hardware and the memory compensates for the lost parameters
- **Test different architectures**: try Qwen vs Gemma vs any GGUF-compatible model, same memory, different inference

This is fundamentally different from fine-tuning, where knowledge is locked inside a specific model's weights and cannot be transferred.

#### Self-Improving Through Use

Every conversation is persisted as a session. The mining pipeline (auto or manual) extracts patterns, skills, and knowledge from those sessions. Corrections boost the right memories and suppress wrong ones. The agent gets better at your specific tasks the more you use it — without any explicit training step. This is the CTT cycle:

```
interact → save session → mine patterns → recall as context → better responses → repeat
```

### How It Compares to ICRL

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

## Use Cases

### Team Knowledge Sharing

Export your agent's accumulated knowledge about a project and share it with teammates. When someone joins the team, they install the memory pack and their local agent immediately knows the project conventions, common patterns, and tool usage — without reading pages of documentation or pair-programming sessions.

```bash
# Senior developer exports project knowledge
micro-expert export-memories \
  --filter "authentication" \
  --pack-name "Auth Service Knowledge" \
  --pack-author "Alice" \
  --output auth-knowledge.json

# New team member installs it
micro-expert install auth-knowledge.json
```

### Onboarding Acceleration

Create memory packs that encode onboarding knowledge: project architecture, coding conventions, common commands, API patterns, deployment procedures. New hires install the pack and have an AI assistant that already knows how things work — reducing the ramp-up time from weeks to minutes.

```bash
# Create an onboarding pack with project-specific knowledge
micro-expert export-memories \
  --pack-name "Acme Corp Onboarding" \
  --pack-desc "Project conventions, architecture decisions, deployment procedures" \
  --pack-tags "onboarding,conventions,deploy" \
  --output onboarding-pack.json
```

### Documentation as Memory

Instead of hoping the model read your documentation, inject it directly into memory. Technical docs, API references, runbooks, and architecture decision records become recallable context that the agent uses to answer questions accurately.

```bash
# Import a documentation pack
micro-expert install https://example.com/packs/api-reference.json

# The agent now answers questions using your actual docs, not hallucinations
micro-expert ask "How do I authenticate with the payment API?"
```

### Offline Field Work

Deploy MicroExpert on laptops used in environments without internet: research stations, manufacturing floors, remote offices, field inspections. The agent works fully offline with all its accumulated knowledge, and sessions can be synced later when connectivity is available.

### Privacy-Sensitive Domains

Use MicroExpert for domains where data cannot leave the local machine: patient records in healthcare, case files in legal, proprietary code in enterprise, classified material in government. The entire pipeline — model, memory, inference — runs locally with zero external communication.

### Multi-Model Workflows

Use different models for different tasks, all backed by the same memory:

```bash
# Fast lookups with a tiny model
MICRO_EXPERT_MODEL_PATH=~/.micro-expert/models/gemma-270m.gguf \
  micro-expert ask "What's the deploy command?"

# Complex tool calling with a larger model
MICRO_EXPERT_MODEL_PATH=~/.micro-expert/models/qwen3.5-2b.gguf \
  micro-expert ask "Create an n8n workflow that sends a Slack notification on new GitHub issues"
```

The memory store is shared — skills learned with the 2B model are available when running the 270M model, and vice versa.

### Knowledge Backup and Recovery

Memory is portable data. Back it up, version it, restore it:

```bash
# Backup
cp -r ~/.micro-expert/memory/ ~/backups/micro-expert-memory-$(date +%F)/

# Or export as a structured pack
micro-expert export-memories --output full-backup.json

# Restore on a new machine
micro-expert install full-backup.json
```

Unlike fine-tuning (where you'd need to retrain the model from scratch), restoring from a memory backup takes seconds.

### Skill Distribution

Create and publish skill packs for specific tool ecosystems. The community can build a catalog of packs that solve cold-start for common integrations:

```bash
# Generate skills from MCP tool metadata
micro-expert seed --output n8n-skills.json --pack-name "n8n MCP Skills"

# Publish to GitHub, share via URL
micro-expert install https://raw.githubusercontent.com/.../packs/n8n-skills.json
```

---

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                      MicroExpert                          │
│                                                           │
│  ┌─────────────┐  ┌────────────────────────────────────┐  │
│  │   Web UI     │  │              CLI                   │  │
│  │  (vanilla)   │  │  serve·chat·ask·telegram·mine·seed  │  │
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

#### Option A: npm (recommended)

```bash
npm install -g micro-expert

# Download model + llama-server (interactive wizard)
micro-expert setup
```

#### Option B: From source

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
| `micro-expert seed` | Generate skill memories from MCP tool metadata (artificial experience) |
| `micro-expert telegram` | Start the Telegram bot for chat-based interaction |

### CLI Flags

| Flag | Description | Default |
|---|---|---|
| `--port <n>` | HTTP server port | `3333` |
| `--model <path>` | Path to GGUF model file | `~/.micro-expert/models/model.gguf` |
| `--light` | Use lightweight model (Gemma 3 270M) during setup | `false` |
| `--no-open` | Don't open browser on `serve` | `false` |
| `--token <token>` | Telegram bot token (for `telegram` command) | config value |

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

The Web UI supports attaching images via the button. Images are sent as base64 data URLs in the `image` field of the chat completion request. The model receives them as `image_url` content parts (requires a vision-capable GGUF model).

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

## Telegram Bot

MicroExpert can run as a Telegram bot, allowing you to interact with your local agent from any Telegram client — mobile, desktop, or web.

### Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram and get the bot token
2. Add the token to `~/.micro-expert/config.json`:

```json
{
  "telegram": {
    "botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
    "allowedUsers": [123456789]
  }
}
```

3. Start the bot:

```bash
micro-expert telegram

# Or pass the token directly
micro-expert telegram --token "123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
```

### Features

- **Long polling** — no webhooks, no public URL needed, works behind NAT/firewall
- **Photo support** — send images and the bot processes them with vision-capable models
- **Per-user history** — each Telegram user gets their own conversation context (last 10 turns)
- **User allowlist** — restrict access to specific Telegram user IDs (empty = allow all)
- **Message splitting** — long responses are automatically split at newline boundaries (Telegram's 4096 char limit)
- **Zero dependencies** — uses `node:https` directly, no Telegram SDK

### Configuration

| Field | Description | Default |
|---|---|---|
| `telegram.botToken` | Bot token from @BotFather | (required) |
| `telegram.allowedUsers` | Array of allowed Telegram user IDs | `[]` (allow all) |

To find your Telegram user ID, send a message to [@userinfobot](https://t.me/userinfobot).

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

### Memory vs Fine-Tuning

| | Memory (CTT) | Fine-Tuning |
|---|---|---|
| **Hardware** | CPU-only, no GPU needed | Requires GPU (often expensive cloud instances) |
| **Speed** | Instant — save a memory, done | Hours to days of training |
| **Portability** | JSON files — copy, share, version-control | Baked into model weights — model-specific |
| **Reversibility** | Delete a memory to forget | Retrain the entire model |
| **Transparency** | Read exactly what the model knows | Opaque weights, no inspection |
| **Multi-model** | Same memory works across any GGUF model | One model, one fine-tune |
| **Risk** | Zero risk of catastrophic forgetting | Can degrade base capabilities |
| **Cost** | Free (local CPU) | $$$ (GPU compute, dataset curation) |

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

# Export only memories about a specific topic
micro-expert export-memories --filter "authentication" --output auth-knowledge.json

# Export only memories with specific tags
micro-expert export-memories --tags "n8n,mcp" --output n8n-only.json
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

### Artificial Experience — Seeding from Tool Metadata

The `seed` command auto-generates skill memories from MCP tool schemas, creating "artificial experience" that bootstraps a small model's ability to use tools without any prior interaction. This is how a larger model's knowledge (embedded in tool descriptions and schemas) can be transferred to optimize a smaller model.

```bash
# Preview what seeds would be generated (no changes)
micro-expert seed --dry-run

# Save seeds directly to memory
micro-expert seed

# Export as a distributable pack file
micro-expert seed --output n8n-seeds.json --pack-name "n8n MCP Skills"

# Then install the pack on another instance
micro-expert install n8n-seeds.json
```

For each MCP tool, `seed` generates:
1. A **skill memory** with a concrete `[MCP: tool_name {example_args}]` example
2. A **format reference** (for tools with required parameters) documenting parameter types and providing an example

Example generated seed for `n8n_create_workflow`:
```
Para create workflow: [MCP: n8n_create_workflow {"name":"Example","nodes":[{}],"connections":{}}]
```

The generated seeds are recalled as few-shot examples, teaching the model the exact tag format for each tool. Combined with Memory Packs, this enables a workflow where:
1. A developer with access to a larger model generates and curates seed packs
2. End users install those packs on resource-constrained devices
3. Sub-1B models can immediately call MCP tools correctly on their first interaction

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
  "mmprojPath": "",
  "telegram": {
    "botToken": "",
    "allowedUsers": []
  }
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
| `MICRO_EXPERT_TELEGRAM_TOKEN` | Telegram bot token (same as `telegram.botToken` in config) | (none) |
| `MICRO_EXPERT_TELEGRAM_USERS` | Comma-separated allowed user IDs (e.g., `123,456`) | (none) |

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
│   │   ├── tools.ts                 # Tool registry + safe math evaluator
│   │   └── http-tool.ts            # FETCH tag: HTTP requests with security controls
│   ├── inference/
│   │   ├── manager.ts               # llama-server lifecycle (spawn, health, idle)
│   │   └── client.ts               # HTTP client for llama-server (+ SSE streaming)
│   ├── mcp/
│   │   ├── index.ts                 # MCP exports
│   │   ├── client.ts               # McpClientManager: stdio + HTTP dual transport
│   │   └── http-transport.ts       # Custom HttpMcpClient (bypasses SDK hang on Windows)
│   ├── memory/
│   │   ├── provider.ts             # RepoMemory embedded wrapper
│   │   ├── ai-provider.ts          # LlamaAiProvider adapter for auto-mining
│   │   └── seed.ts                 # Skill seed generator from MCP tool metadata
│   ├── server/
│   │   ├── http.ts                  # node:http server (API + UI serving)
│   │   └── routes.ts               # API route handlers
│   ├── setup/
│   │   └── wizard.ts               # Setup wizard (download model + llama-server)
│   ├── telegram/
│   │   └── bot.ts                  # Telegram bot (long polling, no external deps)
│   └── ui/
│       └── index.html               # Web UI SPA (vanilla HTML/CSS/JS, ~15KB)
├── tests/
│   ├── config.test.ts               # Config loading (5 tests)
│   ├── memory-provider.test.ts      # Memory operations (6 tests)
│   ├── agent-loop.test.ts           # Agent pipeline + tool calls (24 tests)
│   ├── calculator.test.ts           # Safe math evaluator (24 tests)
│   ├── http-tool.test.ts            # FETCH tag parsing + security (32 tests)
│   ├── memory-export.test.ts        # Export/import round-trip, v2 packs (11 tests)
│   ├── mcp-client.test.ts          # MCP client: stdio + HTTP (20 tests)
│   ├── seed.test.ts                # Seed generator (7 tests)
│   ├── telegram-bot.test.ts        # Telegram bot (20 tests)
│   └── routes.test.ts              # API routes (19 tests)
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
npm test            # Run all 168 tests (10 suites)
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
| **Tests** | `vitest` (168 tests across 10 suites) |
| **Frontend** | Vanilla HTML/CSS/JS (zero dependencies, ~15KB) |

---

## Default Models

| Model | Size | Use case |
|---|---|---|
| **Qwen2.5-0.5B-Instruct** (Q4_K_M) | ~469 MB | Default — good balance of quality and speed |
| **Qwen3.5-0.8B** (Q4_K_M) | ~508 MB | Upgrade — better reasoning, vision, supports thinking mode |
| **Qwen3.5-2B** (Q4_K_M) | ~1.2 GB | Best quality — more consistent tool calling, vision capable |
| **Gemma 3 270M** (Q4_K_M) | ~170 MB | `--light` — minimal footprint, faster inference |

All models share the same memory store. You can switch between them freely — skills learned with one model are available to all others.

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
- **Config validation** — Port (1-65535), temperature (0-2), threads (>=0), maxTokens (>=1), contextSize (>=128) validated on load with fallback to defaults
- **Safe math evaluator** — Recursive descent parser for `[CALC:]` tags — no `eval()`, no code execution
- **Memory import validation** — Payload structure validated before processing
- **Message validation** — Each message in API requests must have a valid `role` string and non-null `content`
- **Inference retry** — Detects transient errors (ECONNREFUSED, socket hang up, etc.) with automatic retry on llama-server restart races

---

## Roadmap

- [ ] `micro-expert index <path>` — ingest a codebase into memory
- [ ] MCP server mode — expose as a tool for Claude Code, Cursor, etc.
- [x] Auto-mining — automatically extract memories and skills from sessions using the local model
- [x] Telegram bot — interact with MicroExpert via Telegram chat
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
