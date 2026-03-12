import type { MemoryProvider } from '../memory/provider.js';

export interface ToolInput {
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: ToolInput) => Promise<string>;
}

/**
 * Registry of tools available to the agent.
 * v0.1: tools are NOT called by the LLM — they're used by the fixed pipeline.
 * Future: LLM will generate tool_calls and this registry will execute them.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  async execute(name: string, args: ToolInput): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool.execute(args);
  }

  /**
   * Get tool schemas formatted for LLM system prompt injection.
   * Ready for when we add LLM-driven tool calling.
   */
  toSystemPrompt(): string {
    if (this.tools.size === 0) return '';

    const toolDescs = this.list().map(t =>
      `- ${t.name}: ${t.description}`
    ).join('\n');

    return `Available tools:\n${toolDescs}`;
  }
}

/**
 * Register the built-in memory tools.
 */
export function registerBuiltinTools(registry: ToolRegistry, memory: MemoryProvider): void {
  registry.register({
    name: 'recall',
    description: 'Retrieve relevant context from memory for a query',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        userId: { type: 'string', description: 'User ID' },
      },
      required: ['query', 'userId'],
    },
    execute: async (args) => {
      const result = memory.recall(args.query as string, args.userId as string);
      return result.formatted || 'No relevant context found.';
    },
  });

  registry.register({
    name: 'search_memories',
    description: 'Search specific memories by query',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        userId: { type: 'string', description: 'User ID' },
        limit: { type: 'number', description: 'Max results', default: 5 },
      },
      required: ['query', 'userId'],
    },
    execute: async (args) => {
      const results = memory.searchMemories(
        args.query as string,
        args.userId as string,
        (args.limit as number) ?? 5,
      );
      if (results.length === 0) return 'No memories found.';
      return results.map((r, i) =>
        `${i + 1}. [${r.category ?? 'general'}] (score: ${r.score.toFixed(2)}) ${r.content}`
      ).join('\n');
    },
  });

  registry.register({
    name: 'save_memory',
    description: 'Save an important fact or decision to memory',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'What to remember' },
        category: { type: 'string', description: 'Category: fact, decision, issue, task, correction' },
        userId: { type: 'string', description: 'User ID' },
      },
      required: ['content', 'category', 'userId'],
    },
    execute: async (args) => {
      memory.saveMemory(
        args.userId as string,
        args.content as string,
        args.category as string,
      );
      return 'Memory saved.';
    },
  });
}
