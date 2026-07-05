import { describe, it, expect, vi } from 'vitest';
import { validateToolTagContent, validatePack } from '../src/pack/validate.js';
import { extractFewShotExamples } from '../src/memory/provider.js';

/**
 * Deterministic gate at the few-shot amplification point.
 *
 * These cases are FROZEN: they pin the contract that (a) a malformed skill
 * memory is dropped from the few-shot set, (b) valid examples around it
 * survive, (c) memories without tool tags are unaffected, and (d) the gate
 * never throws or empties the recall.
 */

describe('validateToolTagContent (single-content gate)', () => {
  it('accepts a valid MCP tag with JSON args', () => {
    const result = validateToolTagContent('List workflows: [MCP: tool {"a":1}]');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects an MCP tag with broken JSON', () => {
    const result = validateToolTagContent('Bad: [MCP: tool {json roto]');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('invalid JSON');
  });

  it('accepts content without any tool tag', () => {
    const result = validateToolTagContent('Just a plain fact about the project.');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a FETCH tag with a file:// URL', () => {
    const result = validateToolTagContent('Read: [FETCH: GET file:///x]');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('http(s)://'))).toBe(true);
  });

  it('accepts a valid FETCH tag with an https:// URL', () => {
    const result = validateToolTagContent('Fetch: [FETCH: GET https://api.example.com/items]');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a non-empty CALC expression', () => {
    const result = validateToolTagContent('Do math: [CALC: 15 * 3 + 7]');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('never throws and treats empty/non-string input as valid', () => {
    expect(() => validateToolTagContent('')).not.toThrow();
    expect(validateToolTagContent('').valid).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(validateToolTagContent(undefined as any).valid).toBe(true);
  });
});

describe('extractFewShotExamples (few-shot gate)', () => {
  it('includes a valid MCP example and excludes a broken one, keeping the rest', () => {
    const recalledText = [
      'Context:',
      '- [mcp-skill] [n8n] List workflows: [MCP: n8n_list_workflows {"a":1}]',
      '- [mcp-skill] [n8n] Bad: [MCP: x {broken json]',
      '- [fact] [topic] No tags here, just a plain fact about the project.',
      '- [skill] [http] Fetch: [FETCH: GET file:///x]',
      '- [skill] [math] Do math: [CALC: 15 * 3 + 7]',
    ].join('\n');

    const examples = extractFewShotExamples(recalledText);

    // Does not throw, does not empty the recall.
    expect(examples.length).toBe(2);

    // Valid MCP example survives.
    expect(examples.some((e) => e.assistant.includes('[MCP: n8n_list_workflows {"a":1}]'))).toBe(true);
    // Valid CALC example survives (the rest of the valid examples make it through).
    expect(examples.some((e) => e.assistant.includes('[CALC: 15 * 3 + 7]'))).toBe(true);

    // Broken MCP tag is excluded.
    expect(examples.some((e) => e.assistant.includes('{broken json'))).toBe(false);
    // FETCH with file:// is excluded.
    expect(examples.some((e) => e.assistant.includes('file:///x'))).toBe(false);
    // Plain-fact memory (no tags) is not turned into a few-shot example.
    expect(examples.some((e) => e.user.includes('plain fact'))).toBe(false);
  });

  it('logs a single line per excluded memory', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const recalledText = [
        'Context:',
        '- [mcp-skill] [n8n] Good: [MCP: ok {"a":1}]',
        '- [mcp-skill] [n8n] Bad1: [MCP: x {broken json]',
        '- [skill] [http] Bad2: [FETCH: GET file:///x]',
      ].join('\n');

      const examples = extractFewShotExamples(recalledText);

      expect(examples.length).toBe(1);
      expect(examples[0].assistant).toContain('[MCP: ok {"a":1}]');

      const gateLines = logSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.startsWith('[micro-expert] few-shot excluded (invalid tool tag):'));
      // One log line per excluded memory (Bad1 + Bad2 = 2).
      expect(gateLines.length).toBe(2);
      expect(gateLines.some((l) => l.includes('broken json'))).toBe(true);
      expect(gateLines.some((l) => l.includes('file:///x'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does not throw or empty recall when every candidate is invalid', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const recalledText = [
        'Context:',
        '- [mcp-skill] [n8n] Bad: [MCP: x {broken json]',
        '- [skill] [http] Bad fetch: [FETCH: GET file:///x]',
      ].join('\n');

      const examples = extractFewShotExamples(recalledText);

      // No exceptions, empty (but not undefined) result.
      expect(Array.isArray(examples)).toBe(true);
      expect(examples.length).toBe(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('content without tool tags is unaffected (returns no examples, no logs)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const recalledText = [
        'Context:',
        '- [fact] [topic] Just a fact.',
        '- [convention] [style] No default exports.',
      ].join('\n');

      const examples = extractFewShotExamples(recalledText);

      expect(examples.length).toBe(0);
      const gateLines = logSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.startsWith('[micro-expert] few-shot excluded'));
      expect(gateLines.length).toBe(0);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('validatePack still uses the shared tag rules (regression)', () => {
  it('rejects a v2 skill with broken MCP JSON via the shared validator', () => {
    const pack = {
      version: 2,
      pack: { name: 'Broken' },
      memories: [],
      skills: [{ content: 'Bad: [MCP: x {broken json]', category: 'mcp-skill', tags: ['n8n'] }],
    };
    const result = validatePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('skills[0]') && e.includes('invalid JSON'))).toBe(true);
  });
});