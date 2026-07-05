import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runValidate } from '../bin/micro-expert.js';

/**
 * Unit tests for the `validate` command handler (runValidate).
 *
 * Decision: the handler was extracted into an exported function in
 * bin/micro-expert.ts (and program.parse() guarded to only run when the
 * bin is the entry point) so the validation logic can be tested without
 * spawning a fragile subprocess. No memory is touched by runValidate.
 */
describe('cli validate (runValidate)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'me-validate-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('validates a valid v2 pack and reports counts', async () => {
    const file = join(dir, 'pack.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        pack: { name: 'Test Pack' },
        memories: [{ content: 'a fact', category: 'fact', tags: ['t'] }],
        skills: [{ content: 'call [MCP: foo {}]', category: 'mcp-skill', tags: ['x'] }],
      }),
    );

    const r = await runValidate(file);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('pack');
    expect(r.counts.memories).toBe(1);
    expect(r.counts.skills).toBe(1);
    expect(r.errors).toHaveLength(0);
  });

  it('rejects a pack with broken MCP JSON args', async () => {
    const file = join(dir, 'bad.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        pack: { name: 'Bad' },
        memories: [],
        skills: [{ content: 'call [MCP: x {json roto}]', category: 'mcp-skill' }],
      }),
    );

    const r = await runValidate(file);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('pack');
    expect(r.errors.join('\n')).toMatch(/invalid JSON args/);
  });

  it('validates a valid OKF bundle and counts non-reserved nodes', async () => {
    const bundle = join(dir, 'bundle');
    mkdirSync(bundle);
    writeFileSync(join(bundle, 'a.md'), '---\ntype: Memory\n---\nbody');
    writeFileSync(join(bundle, 'index.md'), '---\ntitle: idx\n---\nreserved index');

    const r = await runValidate(bundle);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('okf');
    expect(r.counts.nodes).toBe(1); // index.md is reserved → not counted
    expect(r.errors).toHaveLength(0);
  });

  it('rejects an OKF bundle with a .md missing the type field', async () => {
    const bundle = join(dir, 'bundle2');
    mkdirSync(bundle);
    writeFileSync(join(bundle, 'a.md'), '---\ntitle: no type here\n---\nbody');

    const r = await runValidate(bundle);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('okf');
    expect(r.errors.join('\n')).toMatch(/no "type"/);
  });

  it('throws on a non-existent local source', async () => {
    await expect(runValidate(join(dir, 'nope.json'))).rejects.toThrow();
  });
});