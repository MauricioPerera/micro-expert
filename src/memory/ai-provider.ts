import type { InferenceClient } from '../inference/client.js';
import type { AiProvider } from './provider.js';

/**
 * Adapts MicroExpert's InferenceClient to RepoMemory's AiProvider interface.
 * Enables automatic session mining using the local llama-server model.
 */
export class LlamaAiProvider implements AiProvider {
  private readonly client: InferenceClient;

  constructor(client: InferenceClient) {
    this.client = client;
  }

  async chat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<string> {
    const response = await this.client.chatCompletion(
      messages.map(m => ({ role: m.role, content: m.content })),
      {
        maxTokens: 1024,     // Mining needs more tokens for extraction
        temperature: 0.1,    // Low temp for consistent extraction
      },
    );

    return response.choices[0]?.message?.content ?? '';
  }
}
