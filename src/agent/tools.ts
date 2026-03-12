import type { MemoryProvider } from '../memory/provider.js';

export interface ToolInput {
  [key: string]: unknown;
}

// ─── Safe Math Evaluator ───────────────────────────────────────
// Recursive descent parser for arithmetic expressions.
// No eval(), no Function() — completely safe.

/**
 * Safely evaluate a math expression string.
 * Supports: +, -, *, /, %, parentheses, decimals, negation.
 * Functions: sqrt, pow, abs, round, ceil, floor, min, max.
 */
export function safeEvaluate(expr: string): number {
  const tokens = tokenize(expr);
  const parser = new Parser(tokens);
  const result = parser.parseExpression();
  if (parser.pos < tokens.length) {
    throw new Error(`Unexpected token: ${tokens[parser.pos]}`);
  }
  if (!isFinite(result)) {
    throw new Error('Result is not finite (division by zero?)');
  }
  return result;
}

type Token = string;

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = expr.replace(/\s+/g, '');

  while (i < s.length) {
    const ch = s[i];

    // Number (including decimals)
    if (ch >= '0' && ch <= '9' || ch === '.') {
      let num = '';
      while (i < s.length && (s[i] >= '0' && s[i] <= '9' || s[i] === '.')) {
        num += s[i++];
      }
      tokens.push(num);
      continue;
    }

    // Operators and parens
    if ('+-*/%(),'.includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }

    // Function names (alpha chars)
    if (ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z') {
      let name = '';
      while (i < s.length && (s[i] >= 'a' && s[i] <= 'z' || s[i] >= 'A' && s[i] <= 'Z')) {
        name += s[i++];
      }
      tokens.push(name);
      continue;
    }

    throw new Error(`Invalid character: '${ch}'`);
  }

  return tokens;
}

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: (x) => Math.sqrt(x),
  pow: (base, exp) => Math.pow(base, exp),
  abs: (x) => Math.abs(x),
  round: (x) => Math.round(x),
  ceil: (x) => Math.ceil(x),
  floor: (x) => Math.floor(x),
  min: (...args) => Math.min(...args),
  max: (...args) => Math.max(...args),
};

class Parser {
  pos = 0;
  constructor(private tokens: Token[]) {}

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  consume(): Token {
    return this.tokens[this.pos++];
  }

  expect(token: Token): void {
    if (this.consume() !== token) {
      throw new Error(`Expected '${token}'`);
    }
  }

  // expression = term (('+' | '-') term)*
  parseExpression(): number {
    let left = this.parseTerm();
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.consume();
      const right = this.parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  // term = factor (('*' | '/' | '%') factor)*
  parseTerm(): number {
    let left = this.parseFactor();
    while (this.peek() === '*' || this.peek() === '/' || this.peek() === '%') {
      const op = this.consume();
      const right = this.parseFactor();
      if (op === '*') left *= right;
      else if (op === '/') left /= right;
      else left %= right;
    }
    return left;
  }

  // factor = unary | number | '(' expression ')' | function '(' args ')'
  parseFactor(): number {
    const token = this.peek();

    // Unary minus
    if (token === '-') {
      this.consume();
      return -this.parseFactor();
    }

    // Unary plus
    if (token === '+') {
      this.consume();
      return this.parseFactor();
    }

    // Parenthesized expression
    if (token === '(') {
      this.consume();
      const val = this.parseExpression();
      this.expect(')');
      return val;
    }

    // Number
    if (token && /^[\d.]+$/.test(token)) {
      this.consume();
      const num = parseFloat(token);
      if (isNaN(num)) throw new Error(`Invalid number: ${token}`);
      return num;
    }

    // Function call
    if (token && /^[a-zA-Z]+$/.test(token)) {
      const name = this.consume().toLowerCase();
      const fn = FUNCTIONS[name];
      if (!fn) throw new Error(`Unknown function: ${name}`);
      this.expect('(');
      const args: number[] = [this.parseExpression()];
      while (this.peek() === ',') {
        this.consume();
        args.push(this.parseExpression());
      }
      this.expect(')');
      return fn(...args);
    }

    throw new Error(`Unexpected token: ${token ?? 'end of expression'}`);
  }
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

  registry.register({
    name: 'calculate',
    description: 'Evaluate a math expression safely (no eval). Supports +, -, *, /, %, parentheses, sqrt, pow, abs, round, ceil, floor, min, max.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Math expression to evaluate' },
      },
      required: ['expression'],
    },
    execute: async (args) => {
      try {
        const result = safeEvaluate(args.expression as string);
        return String(result);
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    },
  });
}
