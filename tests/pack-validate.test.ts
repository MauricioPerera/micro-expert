import { describe, it, expect } from 'vitest';
import { validatePack } from '../src/pack/validate.js';

describe('Pack validator', () => {
  it('accepts a valid v1 pack', () => {
    const pack = {
      version: 1,
      memories: [
        { content: 'Project uses TypeScript ESM.', category: 'fact', tags: ['ts'] },
        { content: 'No default exports.', category: 'convention', tags: ['style'] },
      ],
    };
    const result = validatePack(pack);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a valid v2 pack with MCP/CALC/FETCH skills', () => {
    const pack = {
      version: 2,
      pack: { name: 'n8n MCP Skills', description: 'demo' },
      memories: [{ content: 'General note.', category: 'fact', tags: ['topic'] }],
      skills: [
        { content: 'List workflows: [MCP: n8n_list_workflows {}]', category: 'mcp-skill', tags: ['n8n'] },
        { content: 'Do math: [CALC: 15 * 3 + 7]', category: 'skill', tags: ['math'] },
        { content: 'Fetch: [FETCH: GET https://api.example.com/items]', category: 'skill', tags: ['http'] },
      ],
    };
    const result = validatePack(pack);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects v2 skill with broken MCP JSON, naming the index', () => {
    const pack = {
      version: 2,
      pack: { name: 'Broken Pack' },
      memories: [],
      skills: [
        { content: 'List workflows: [MCP: n8n_list_workflows {}]', category: 'mcp-skill', tags: ['n8n'] },
        { content: 'Bad: [MCP: x {bad json}]', category: 'mcp-skill', tags: ['n8n'] },
      ],
    };
    const result = validatePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('skills[1]'))).toBe(true);
    expect(result.errors.some((e) => e.includes('invalid JSON'))).toBe(true);
  });

  it('rejects FETCH with file:// URL', () => {
    const pack = {
      version: 2,
      pack: { name: 'File Fetch' },
      memories: [],
      skills: [
        { content: 'Read: [FETCH: GET file:///etc/passwd]', category: 'skill', tags: ['fs'] },
      ],
    };
    const result = validatePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('http(s)://'))).toBe(true);
  });

  it('accepts FETCH GET with https:// URL', () => {
    const pack = {
      version: 2,
      pack: { name: 'Ok Fetch' },
      memories: [],
      skills: [
        { content: 'Fetch: [FETCH: GET https://api.example.com/items]', category: 'skill', tags: ['http'] },
      ],
    };
    const result = validatePack(pack);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects empty content', () => {
    const pack = {
      version: 1,
      memories: [
        { content: '', category: 'fact', tags: [] },
      ],
    };
    const result = validatePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('memories[0]') && e.includes('content'))).toBe(true);
  });

  it('rejects unknown structure ({foo:1})', () => {
    const result = validatePack({ foo: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Unknown pack structure'))).toBe(true);
  });

  it('accepts MCP args with nested brackets (valid JSON)', () => {
    const pack = {
      version: 2,
      pack: { name: 'Nested Args' },
      memories: [],
      skills: [
        {
          content: 'Move: [MCP: robot_move {"position": [250, 300]}]',
          category: 'mcp-skill',
          tags: ['robot'],
        },
      ],
    };
    const result = validatePack(pack);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});