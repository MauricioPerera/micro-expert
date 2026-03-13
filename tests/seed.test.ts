import { describe, it, expect } from 'vitest';
import { generateSkillSeeds } from '../src/memory/seed.js';
import type { McpToolInfo } from '../src/mcp/client.js';

describe('Seed Generator', () => {
  const mockTools: McpToolInfo[] = [
    {
      serverName: 'n8n',
      qualifiedName: 'n8n_create_workflow',
      originalName: 'create_workflow',
      description: 'Create a new n8n workflow. Returns the workflow ID.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Workflow name' },
          nodes: { type: 'array', description: 'Array of node definitions', items: { type: 'object' } },
          active: { type: 'boolean', default: false },
        },
        required: ['name', 'nodes'],
      },
    },
    {
      serverName: 'filesystem',
      qualifiedName: 'read_file',
      originalName: 'read_file',
      description: 'Read a file from the filesystem.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read' },
        },
        required: ['path'],
      },
    },
    {
      serverName: 'simple',
      qualifiedName: 'ping',
      originalName: 'ping',
      description: 'Ping the server.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];

  it('should generate skill seeds for each tool', () => {
    const seeds = generateSkillSeeds(mockTools);
    expect(seeds.length).toBeGreaterThanOrEqual(mockTools.length);

    // Each tool gets at least one skill entry
    const skillEntries = seeds.filter(s => s.category === 'mcp-skill');
    expect(skillEntries.length).toBe(3);
  });

  it('should generate format reference for tools with required params', () => {
    const seeds = generateSkillSeeds(mockTools);
    const formatEntries = seeds.filter(s => s.category === 'mcp-tools');

    // n8n_create_workflow has required: ['name', 'nodes']
    // read_file has required: ['path']
    // ping has no required params
    expect(formatEntries.length).toBe(2);
  });

  it('should include [MCP: tool_name ...] tags in generated skills', () => {
    const seeds = generateSkillSeeds(mockTools);

    for (const seed of seeds) {
      expect(seed.content).toContain('[MCP:');
      expect(seed.content).toContain(']');
    }
  });

  it('should generate realistic example values based on property names', () => {
    const seeds = generateSkillSeeds(mockTools);
    const readFileSeed = seeds.find(s => s.content.includes('read_file'));
    expect(readFileSeed).toBeDefined();
    // path property should get a path-like value
    expect(readFileSeed!.content).toContain('/tmp/');
  });

  it('should include server name and keywords as tags', () => {
    const seeds = generateSkillSeeds(mockTools);
    const n8nSeed = seeds.find(s => s.content.includes('n8n_create_workflow') && s.category === 'mcp-skill');
    expect(n8nSeed).toBeDefined();
    expect(n8nSeed!.tags).toContain('n8n');
    expect(n8nSeed!.tags).toContain('mcp');
    expect(n8nSeed!.tags).toContain('create');
    expect(n8nSeed!.tags).toContain('workflow');
  });

  it('should include default values in example args', () => {
    const seeds = generateSkillSeeds(mockTools);
    const n8nSeed = seeds.find(s => s.content.includes('n8n_create_workflow') && s.category === 'mcp-skill');
    expect(n8nSeed).toBeDefined();
    // active has default: false, so it should be included
    expect(n8nSeed!.content).toContain('"active"');
  });

  it('should handle tools with no properties gracefully', () => {
    const seeds = generateSkillSeeds([{
      serverName: 'test',
      qualifiedName: 'noop',
      originalName: 'noop',
      description: 'Does nothing.',
      inputSchema: { type: 'object' },
    }]);

    expect(seeds.length).toBe(1);
    expect(seeds[0].content).toContain('[MCP: noop');
  });
});
