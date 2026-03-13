import type { McpToolInfo } from '../mcp/client.js';
import type { MemoryExportEntry } from './provider.js';

/**
 * Generate skill memories from MCP tool metadata.
 *
 * This is "artificial experience" — creating few-shot examples from tool
 * schemas so a small model can use tools without prior interaction.
 * A larger model or human can review/edit the generated seeds before importing.
 *
 * For each tool, generates:
 *   1. A skill memory with a concrete [MCP: tool_name {example_args}] example
 *   2. If the tool has complex args, an additional memory with format reference
 */
export function generateSkillSeeds(tools: McpToolInfo[]): MemoryExportEntry[] {
  const entries: MemoryExportEntry[] = [];

  for (const tool of tools) {
    const exampleArgs = generateExampleArgs(tool.inputSchema);
    const argsJson = JSON.stringify(exampleArgs);
    const toolDesc = tool.description?.split('.')[0] ?? tool.qualifiedName;

    // Primary skill: user request → MCP tag
    entries.push({
      content: `Para ${toolDesc.toLowerCase()}: [MCP: ${tool.qualifiedName} ${argsJson}]`,
      category: 'mcp-skill',
      tags: [tool.serverName, 'mcp', ...extractKeywords(tool.qualifiedName)],
    });

    // If tool has required properties, generate a format reference
    const schema = tool.inputSchema as JsonSchema;
    const required = schema.required;
    if (required && Array.isArray(required) && required.length > 0) {
      const paramDesc = required.map((p: string) => {
        const prop = schema.properties?.[p] as JsonSchema | undefined;
        const type = prop?.type ?? 'string';
        const desc = prop?.description?.split('.')[0] ?? '';
        return `${p} (${type}${desc ? ': ' + desc : ''})`;
      }).join(', ');

      entries.push({
        content: `${tool.qualifiedName} requiere: ${paramDesc}. Ejemplo: [MCP: ${tool.qualifiedName} ${argsJson}]`,
        category: 'mcp-tools',
        tags: [tool.serverName, 'mcp', ...extractKeywords(tool.qualifiedName)],
      });
    }
  }

  return entries;
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  example?: unknown;
}

/**
 * Generate example argument values from a JSON Schema.
 * Produces realistic-looking example data based on types, descriptions, and defaults.
 */
function generateExampleArgs(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const s = schema as JsonSchema;
  const props = s.properties;
  if (!props) return result;

  // Only include required properties + a few optional ones with defaults
  const required = new Set(Array.isArray(s.required) ? s.required : []);

  for (const [key, propSchema] of Object.entries(props)) {
    const prop = propSchema as JsonSchema;

    // Include required props and those with defaults/examples
    if (!required.has(key) && prop.default === undefined && prop.example === undefined) {
      continue;
    }

    result[key] = generateValue(key, prop);
  }

  return result;
}

/**
 * Generate a single example value from a property schema.
 */
function generateValue(key: string, prop: JsonSchema): unknown {
  // Use example or default if available
  if (prop.example !== undefined) return prop.example;
  if (prop.default !== undefined) return prop.default;

  // Use first enum value
  if (prop.enum && prop.enum.length > 0) return prop.enum[0];

  // Generate by type
  switch (prop.type) {
    case 'string':
      return guessStringValue(key, prop.description);
    case 'number':
    case 'integer':
      return guessNumberValue(key);
    case 'boolean':
      return true;
    case 'array':
      if (prop.items) {
        return [generateValue(key + '_item', prop.items)];
      }
      return [];
    case 'object':
      if (prop.properties) {
        return generateExampleArgs(prop as Record<string, unknown>);
      }
      return {};
    default:
      return '';
  }
}

/**
 * Guess a realistic string value based on the property name and description.
 */
function guessStringValue(key: string, description?: string): string {
  const k = key.toLowerCase();
  const d = (description ?? '').toLowerCase();

  if (k.includes('id') || k.includes('Id')) return 'abc123';
  if (k.includes('name')) return 'Example';
  if (k.includes('url') || k.includes('endpoint')) return 'https://api.example.com';
  if (k.includes('email')) return 'user@example.com';
  if (k.includes('path') || k.includes('file')) return '/tmp/example.txt';
  if (k.includes('query') || k.includes('search') || k.includes('keyword')) return 'example';
  if (k.includes('type') || k.includes('mode') || k.includes('method')) return 'default';
  if (d.includes('json')) return '{}';

  return 'value';
}

function guessNumberValue(key: string): number {
  const k = key.toLowerCase();
  if (k.includes('limit') || k.includes('count') || k.includes('max')) return 10;
  if (k.includes('port')) return 8080;
  if (k.includes('timeout')) return 30;
  if (k.includes('page') || k.includes('offset')) return 0;
  return 1;
}

/**
 * Extract searchable keywords from a tool name like "n8n_create_workflow".
 */
function extractKeywords(name: string): string[] {
  return name
    .split(/[_\-.]/)
    .filter(w => w.length > 2)
    .map(w => w.toLowerCase());
}
