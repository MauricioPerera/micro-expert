import type { InferenceClient, ChatMessage, StreamDelta } from '../inference/client.js';
import type { MemoryProvider, FewShotExample } from '../memory/provider.js';
import type { MicroExpertConfig } from '../config.js';
import type { ToolRegistry } from './tools.js';
import type { McpClientManager } from '../mcp/index.js';
import { safeEvaluate } from './tools.js';
import { parseFetchTag, executeFetch } from './http-tool.js';

export interface AgentRequest {
  /** User's message */
  message: string;
  /** User ID for memory scoping */
  userId: string;
  /** Conversation history (previous turns) */
  history?: ChatMessage[];
  /** Image data as base64 data URL (optional, for vision) */
  image?: string;
}

export interface AgentResponse {
  /** Full response text (non-streaming) */
  content: string;
  /** Session ID if saved */
  sessionId: string | null;
  /** Number of recalled context items */
  recalledItems: number;
}

/**
 * Core agent loop: recall → build prompt → infer → save.
 *
 * v0.1 uses a fixed pipeline (no LLM-driven tool calling).
 * The CTT cycle happens passively:
 *   1. recall() injects relevant context
 *   2. Inference uses that context
 *   3. saveSession() persists the turn
 *   4. Future: mine() extracts structured entities
 */
export class AgentLoop {
  private readonly inference: InferenceClient;
  private readonly memory: MemoryProvider;
  private readonly config: MicroExpertConfig;
  private readonly tools?: ToolRegistry;
  private readonly mcp?: McpClientManager;

  constructor(
    inference: InferenceClient,
    memory: MemoryProvider,
    config: MicroExpertConfig,
    tools?: ToolRegistry,
    mcp?: McpClientManager,
  ) {
    this.inference = inference;
    this.memory = memory;
    this.config = config;
    this.tools = tools;
    this.mcp = mcp;
  }

  /**
   * Process a user message (non-streaming).
   */
  async run(request: AgentRequest): Promise<AgentResponse> {
    // 1. Recall context from memory
    const recall = this.memory.recall(request.message, request.userId);

    // 2. Build messages (with few-shot examples from memory)
    const messages = this.buildMessages(request, recall.formatted, recall.fewShot);

    // 3. Infer
    const response = await this.inference.chatCompletion(messages, {
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      topP: this.config.topP,
    });

    let content = response.choices[0]?.message?.content ?? '';

    // Strip thinking tokens (Qwen3.5 may emit <think>...</think> even with /no_think)
    content = stripThinkingTokens(content);

    // 3.5. Process tool calls (e.g., [CALC: 2+3] → 5, [FETCH: GET url] → response)
    content = await this.processToolCalls(content);

    // 4. Save session
    const sessionId = this.memory.saveSession(request.userId, [
      { role: 'user', content: request.message },
      { role: 'assistant', content },
    ]);

    if (!sessionId) {
      console.warn('[micro-expert] Failed to save session — response was still returned to user');
    }

    return {
      content,
      sessionId,
      recalledItems: recall.totalItems,
    };
  }

  /**
   * Process a user message with streaming.
   * Yields content deltas, saves session after completion.
   */
  async *runStream(request: AgentRequest): AsyncGenerator<StreamDelta> {
    // 1. Recall context from memory
    const recall = this.memory.recall(request.message, request.userId);

    // 2. Build messages (with few-shot examples from memory)
    const messages = this.buildMessages(request, recall.formatted, recall.fewShot);

    // 3. Stream inference
    let fullContent = '';

    for await (const delta of this.inference.chatCompletionStream(messages, {
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      topP: this.config.topP,
    })) {
      fullContent += delta.content;
      yield delta;
    }

    // 4. Save session after stream completes
    const streamSessionId = this.memory.saveSession(request.userId, [
      { role: 'user', content: request.message },
      { role: 'assistant', content: fullContent },
    ]);

    if (!streamSessionId) {
      console.warn('[micro-expert] Failed to save streaming session');
    }
  }

  /**
   * Detect and execute inline tool calls in the model's response.
   * Patterns:
   *   [CALC: expression] → numeric result
   *   [FETCH: METHOD url ...] → HTTP response body
   *   [MCP: tool_name {"arg": "val"}] → MCP tool result
   * If execution fails, replaced with [error: message].
   */
  private async processToolCalls(content: string): Promise<string> {
    // 0. Unwrap tool tags from markdown code blocks (small models often wrap them)
    //    Handles ```mcp, ```json, ```text, or bare ``` fences containing tool tags.
    content = unwrapCodeBlocks(content);

    // 1. Process CALC tags (synchronous)
    content = content.replace(/\[CALC:\s*(.+?)\]/g, (_match, expr: string) => {
      try {
        const result = safeEvaluate(expr.trim());
        return String(result);
      } catch (e) {
        return `[error: ${(e as Error).message}]`;
      }
    });

    // 2. Process FETCH tags (async — must handle sequentially)
    const fetchRegex = /\[FETCH:\s*([\s\S]*?)\]/g;
    const fetchMatches = [...content.matchAll(fetchRegex)];

    if (fetchMatches.length > 0) {
      // Process from last to first to preserve indices
      for (let i = fetchMatches.length - 1; i >= 0; i--) {
        const match = fetchMatches[i];
        const raw = match[1];
        const start = match.index!;
        const end = start + match[0].length;

        let replacement: string;
        try {
          const request = parseFetchTag(raw);
          replacement = await executeFetch(request);
        } catch (e) {
          replacement = `[error: ${(e as Error).message}]`;
        }

        content = content.slice(0, start) + replacement + content.slice(end);
      }
    }

    // 3. Process MCP tags (async — external tool calls via MCP protocol)
    //    Uses bracket-aware parsing instead of regex because JSON args
    //    can contain nested brackets (e.g., "position": [250, 300]).
    if (this.mcp) {
      const mcpTags = parseMcpTags(content);

      if (mcpTags.length > 0) {
        // Process from last to first to preserve indices
        for (let i = mcpTags.length - 1; i >= 0; i--) {
          const tag = mcpTags[i];

          let replacement: string;
          try {
            const args = tag.argsRaw ? JSON.parse(tag.argsRaw) : {};
            replacement = await this.mcp.callTool(tag.toolName, args);
          } catch (e) {
            replacement = `[error: ${(e as Error).message}]`;
          }

          content = content.slice(0, tag.start) + replacement + content.slice(tag.end);
        }
      }
    }

    return content;
  }

  /**
   * Build the full message array for inference.
   */
  private buildMessages(request: AgentRequest, context: string, fewShot: FewShotExample[] = []): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // System prompt with CTT context
    // NOTE: Sub-1B models need very direct, explicit instructions.
    // Keep the system prompt short and put context FIRST for maximum attention.
    let systemContent: string;

    // Current date/time context — the model has no sense of time without this
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const dateContext = `Current date: ${dateStr}. Current time: ${timeStr}.`;

    const calcInstruction = 'To perform calculations, write [CALC: expression]. Example: [CALC: 15 * 3 + 7]';
    const fetchInstruction = 'To fetch data from the web, write [FETCH: GET url]. For POST: [FETCH:\\nPOST url\\nBody: {"key":"value"}]';

    // MCP tool instructions (only if MCP tools are available)
    const mcpInstruction = this.mcp ? this.mcp.toSystemPromptSection(this.config.mcpMaxTools) : '';

    // Disable thinking mode for Qwen3.5 when not explicitly enabled
    const noThink = !this.config.thinkingMode ? '\n/no_think' : '';

    if (context.trim()) {
      // Put context BEFORE the role instruction — small models pay more attention to early tokens
      systemContent = `${context}\n\n${dateContext}\n\nYou are MicroExpert, a helpful AI assistant.\n${calcInstruction}\n${fetchInstruction}`;
      if (mcpInstruction) systemContent += `\n${mcpInstruction}`;
      systemContent += '\nIMPORTANT: Use the information above to answer the user. If the user asks about themselves, use the facts from memory above.\nWhen memory shows [MCP: ...] examples, you MUST use exactly that format. Copy the [MCP: tool_name {args}] pattern from memory, replacing values as needed. Do NOT explain how to use tools — just write the [MCP: ...] tag directly.';
      systemContent += noThink;
    } else {
      systemContent = `You are MicroExpert, a helpful AI assistant. ${dateContext}\n${calcInstruction}\n${fetchInstruction}`;
      if (mcpInstruction) systemContent += `\n${mcpInstruction}`;
      systemContent += '\nAnswer concisely and accurately.';
      systemContent += noThink;
    }

    messages.push({ role: 'system', content: systemContent });

    // Few-shot examples from CTT memory — injected as user/assistant turns
    // so the model learns tool-calling patterns by example, not by instruction.
    for (const ex of fewShot) {
      messages.push({ role: 'user', content: ex.user });
      messages.push({ role: 'assistant', content: ex.assistant });
    }

    // Previous conversation history
    if (request.history && request.history.length > 0) {
      messages.push(...request.history);
    }

    // Current user message (with optional image for vision)
    if (request.image) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: request.message },
          { type: 'image_url', image_url: { url: request.image } },
        ],
      });
    } else {
      messages.push({ role: 'user', content: request.message });
    }

    return messages;
  }
}

/**
 * Strip Qwen3.5 thinking tokens from output.
 * Removes <think>...</think> blocks and any leftover tags.
 */
function stripThinkingTokens(content: string): string {
  // Remove complete <think>...</think> blocks (including multiline)
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '');
  // Remove orphaned opening/closing tags
  content = content.replace(/<\/?think>/g, '');
  return content.trim();
}

/**
 * Unwrap tool tags that the model wrapped in markdown code fences.
 * E.g., ```mcp\n[MCP: tool {args}]\n``` → [MCP: tool {args}]
 * Only unwraps blocks whose content contains tool tags ([CALC:, [FETCH:, [MCP:).
 */
function unwrapCodeBlocks(content: string): string {
  return content.replace(/```(?:\w*)\n([\s\S]*?)```/g, (_match, inner: string) => {
    const trimmed = inner.trim();
    if (/\[(CALC|FETCH|MCP):/.test(trimmed)) {
      return trimmed;
    }
    return _match; // Not a tool block — leave it alone
  });
}

interface McpTagMatch {
  toolName: string;
  argsRaw: string;
  start: number;
  end: number;
}

/**
 * Parse [MCP: tool_name {json_args}] tags using bracket-aware matching.
 * Unlike a simple regex, this correctly handles nested brackets in JSON
 * (e.g., arrays like "position": [250, 300] won't prematurely close the tag).
 */
function parseMcpTags(content: string): McpTagMatch[] {
  const results: McpTagMatch[] = [];
  const marker = '[MCP:';
  let searchFrom = 0;

  while (searchFrom < content.length) {
    const tagStart = content.indexOf(marker, searchFrom);
    if (tagStart === -1) break;

    // Find the tool name (first non-whitespace token after [MCP:)
    let i = tagStart + marker.length;
    // Skip whitespace
    while (i < content.length && /\s/.test(content[i])) i++;
    // Read tool name
    const nameStart = i;
    while (i < content.length && /\S/.test(content[i])) i++;
    const toolName = content.slice(nameStart, i);

    if (!toolName) {
      searchFrom = tagStart + marker.length;
      continue;
    }

    // Skip whitespace before args
    while (i < content.length && /\s/.test(content[i])) i++;

    // Now find the closing ] that matches the opening [ of [MCP:
    // We start with depth=1 (the opening [ of [MCP:)
    let depth = 1;
    const argsStart = i;
    while (i < content.length && depth > 0) {
      if (content[i] === '[') depth++;
      else if (content[i] === ']') depth--;

      // Don't skip past the closing bracket
      if (depth > 0) i++;
    }

    if (depth !== 0) {
      // Unclosed tag — skip it
      searchFrom = tagStart + marker.length;
      continue;
    }

    const argsRaw = content.slice(argsStart, i).trim();
    const tagEnd = i + 1; // include the closing ]

    results.push({ toolName, argsRaw, start: tagStart, end: tagEnd });
    searchFrom = tagEnd;
  }

  return results;
}
