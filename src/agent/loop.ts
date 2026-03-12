import type { InferenceClient, ChatMessage, StreamDelta } from '../inference/client.js';
import type { MemoryProvider } from '../memory/provider.js';
import type { MicroExpertConfig } from '../config.js';

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

  constructor(
    inference: InferenceClient,
    memory: MemoryProvider,
    config: MicroExpertConfig,
  ) {
    this.inference = inference;
    this.memory = memory;
    this.config = config;
  }

  /**
   * Process a user message (non-streaming).
   */
  async run(request: AgentRequest): Promise<AgentResponse> {
    // 1. Recall context from memory
    const recall = this.memory.recall(request.message, request.userId);

    // 2. Build messages
    const messages = this.buildMessages(request, recall.formatted);

    // 3. Infer
    const response = await this.inference.chatCompletion(messages, {
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      topP: this.config.topP,
    });

    const content = response.choices[0]?.message?.content ?? '';

    // 4. Save session (fire and forget)
    const sessionId = this.memory.saveSession(request.userId, [
      { role: 'user', content: request.message },
      { role: 'assistant', content },
    ]);

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

    // 2. Build messages
    const messages = this.buildMessages(request, recall.formatted);

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
    this.memory.saveSession(request.userId, [
      { role: 'user', content: request.message },
      { role: 'assistant', content: fullContent },
    ]);
  }

  /**
   * Build the full message array for inference.
   */
  private buildMessages(request: AgentRequest, context: string): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // System prompt with CTT context
    let systemContent = 'You are MicroExpert, a helpful local AI assistant with persistent memory. Answer concisely and accurately.';

    if (context.trim()) {
      systemContent += `\n\n[Relevant context from memory]\n${context}\n[End of context]\n\nUse the above context to inform your response when relevant. If the context answers the user's question, use it directly.`;
    }

    messages.push({ role: 'system', content: systemContent });

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
