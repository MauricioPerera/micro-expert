import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exportOkfBundle,
  importOkfBundle,
  validateOkfBundle,
  type OkfEntry,
} from '../src/pack/okf.js';

describe('OKF bundles', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'okf-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trip export→import preserves content/category/tags of memories and skills', () => {
    const memories: OkfEntry[] = [
      { content: 'TypeScript is the main language.', category: 'fact', tags: ['tech', 'ts'] },
      { content: 'Port 3333 is the default.', category: 'config', tags: [] },
    ];
    const skills: OkfEntry[] = [
      {
        content: 'To list workflows: [MCP: n8n_list_workflows {}]',
        category: 'mcp-skill',
        tags: ['n8n', 'mcp'],
      },
      { content: 'Do math: [CALC: 15 * 3 + 7]', category: 'skill', tags: ['math'] },
    ];

    exportOkfBundle(memories, skills, dir, { name: 'Test Pack', description: 'round-trip' });

    const validation = validateOkfBundle(dir);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);

    const imported = importOkfBundle(dir);
    expect(imported.errors).toEqual([]);

    expect(imported.memories.length).toBe(2);
    const memContents = imported.memories.map((m) => m.content);
    expect(memContents).toContain('TypeScript is the main language.');
    expect(memContents).toContain('Port 3333 is the default.');

    const tsMem = imported.memories.find((m) => m.content.startsWith('TypeScript'))!;
    expect(tsMem.category).toBe('fact');
    expect(tsMem.tags).toEqual(['tech', 'ts']);

    const portMem = imported.memories.find((m) => m.content.startsWith('Port 3333'))!;
    expect(portMem.category).toBe('config');
    expect(portMem.tags).toEqual([]);

    expect(imported.skills.length).toBe(2);
    const n8nSkill = imported.skills.find((s) => s.content.includes('n8n_list_workflows'))!;
    expect(n8nSkill.category).toBe('mcp-skill');
    expect(n8nSkill.tags).toEqual(['n8n', 'mcp']);

    const mathSkill = imported.skills.find((s) => s.content.includes('[CALC:'))!;
    expect(mathSkill.category).toBe('skill');
    expect(mathSkill.tags).toEqual(['math']);
  });

  it('rejects a bundle with a .md without frontmatter, naming the file', () => {
    exportOkfBundle(
      [{ content: 'Has frontmatter.', category: 'fact', tags: ['x'] }],
      [],
      dir,
    );
    writeFileSync(join(dir, 'no-frontmatter.md'), 'Just some prose, no frontmatter.\n');

    const result = validateOkfBundle(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('no-frontmatter.md') && e.includes('frontmatter'))).toBe(true);

    const imported = importOkfBundle(dir);
    expect(imported.errors.some((e) => e.includes('no-frontmatter.md'))).toBe(true);
  });

  it('rejects a .md whose frontmatter has no `type`', () => {
    exportOkfBundle(
      [{ content: 'Has type.', category: 'fact', tags: ['x'] }],
      [],
      dir,
    );
    writeFileSync(
      join(dir, 'no-type.md'),
      '---\ntitle: "Missing Type"\ndescription: "no type here"\n---\n\nBody content.\n',
    );

    const result = validateOkfBundle(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('no-type.md') && e.includes('type'))).toBe(true);
  });

  it('accepts an unknown `type` value as valid and imports it as a memory', () => {
    writeFileSync(
      join(dir, 'weird.md'),
      '---\ntitle: "Whatever"\ntype: Whatever\ncategory: note\ntags: [misc]\n---\n\nSome content.\n',
    );

    expect(validateOkfBundle(dir).valid).toBe(true);

    const imported = importOkfBundle(dir);
    expect(imported.errors).toEqual([]);
    expect(imported.memories.length).toBe(1);
    expect(imported.memories[0].content).toContain('Some content.');
    expect(imported.skills.length).toBe(0);
  });

  it('ignores index.md and log.md as concepts', () => {
    exportOkfBundle(
      [{ content: 'A real concept.', category: 'fact', tags: ['x'] }],
      [],
      dir,
    );
    // index.md already written by export; add a log.md without frontmatter.
    writeFileSync(join(dir, 'log.md'), '## Log\n- entry one\n- entry two\n');

    // Neither reserved file should be flagged, even though log.md has no frontmatter.
    const result = validateOkfBundle(dir);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);

    const imported = importOkfBundle(dir);
    expect(imported.errors).toEqual([]);
    // Only the single real concept becomes a memory; index.md and log.md are not concepts.
    expect(imported.memories.length).toBe(1);
    expect(imported.memories[0].content).toContain('A real concept.');
  });

  it('stays valid when a .md contains a broken link', () => {
    writeFileSync(
      join(dir, 'broken-link.md'),
      '---\ntitle: "Broken"\ntype: Memory\ncategory: fact\ntags: [x]\n---\n\nSee [missing](does-not-exist.md) for details.\n',
    );

    expect(validateOkfBundle(dir).valid).toBe(true);

    const imported = importOkfBundle(dir);
    expect(imported.errors).toEqual([]);
    expect(imported.memories.length).toBe(1);
  });

  it('stays valid with an unknown extra frontmatter field and preserves content', () => {
    const content = 'Body content with a tool: [MCP: do_thing {}].';
    writeFileSync(
      join(dir, 'extra-field.md'),
      `---\ntitle: "Extra"\ntype: Skill\ncategory: mcp-skill\ntags: [x]\ncustom_field: "hello"\n---\n\n${content}\n`,
    );

    expect(validateOkfBundle(dir).valid).toBe(true);

    const imported = importOkfBundle(dir);
    expect(imported.errors).toEqual([]);
    expect(imported.skills.length).toBe(1);
    expect(imported.skills[0].content).toBe(content);
  });
});