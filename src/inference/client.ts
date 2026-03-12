import type { InferenceManager } from './manager.js';

export interface ChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

export interface ChatCompletionOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream?: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamDelta {
  content: string;
  done: boolean;
  finishReason?: string;
}

/**
 * HTTP client for llama-server's OpenAI-compatible API.
 * Handles both streaming (SSE) and non-streaming requests.
 */
export class InferenceClient {
  private readonly manager: InferenceManager;

  constructor(manager: InferenceManager) {
    this.manager = manager;
  }

  /**
   * Non-streaming chat completion.
   */
  async chatCompletion(
    messages: ChatMessage[],
    options: ChatCompletionOptions = {},
  ): Promise<ChatCompletionResponse> {
    const port = await this.manager.ensureRunning();
    this.manager.touch();

    const body = {
      messages,
      max_tokens: options.maxTokens ?? 512,
      temperature: options.temperature ?? 0.7,
      top_p: options.topP ?? 0.9,
      stop: options.stop,
      stream: false,
    };

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Inference failed (${res.status}): ${text}`);
    }

    return await res.json() as ChatCompletionResponse;
  }

  /**
   * Streaming chat completion via SSE.
   * Yields content deltas as they arrive.
   */
  async *chatCompletionStream(
    messages: ChatMessage[],
    options: ChatCompletionOptions = {},
  ): AsyncGenerator<StreamDelta> {
    const port = await this.manager.ensureRunning();
    this.manager.touch();

    const body = {
      messages,
      max_tokens: options.maxTokens ?? 512,
      temperature: options.temperature ?? 0.7,
      top_p: options.topP ?? 0.9,
      stop: options.stop,
      stream: true,
    };

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Inference failed (${res.status}): ${text}`);
    }

    if (!res.body) {
      throw new Error('No response body for streaming');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            yield { content: '', done: true };
            return;
          }

          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta?.content ?? '';
            const finishReason = chunk.choices?.[0]?.finish_reason;

            if (delta || finishReason) {
              yield {
                content: delta,
                done: !!finishReason,
                finishReason: finishReason ?? undefined,
              };
            }
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
