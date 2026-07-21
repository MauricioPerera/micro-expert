import { describe, it, expect, vi } from 'vitest';
import { MemoryProvider } from '../src/memory/provider.js';
import type { RecallResult } from '../src/memory/provider.js';

/**
 * Hermetic tests for the relevanceThreshold gate in MemoryProvider.recall.
 *
 * These tests exercise the REAL `recall` method on the prototype, but bypass
 * the constructor (Object.create) so no real RepoMemory is instantiated, no
 * ~/.micro-expert directory is touched, and no config file/env is read. The
 * `repo` dependency is a hand-rolled mock whose `recall()` returns a
 * RecallContext with controlled `score` values — the only thing the gate
 * inspects. This mirrors the hermetic style of builtin-tools-gate.test.ts:
 * literal, self-contained, no loadConfig(), no filesystem.
 *
 * The mock repo only implements `recall` — that is the sole method the gate
 * path touches. SearchResult items carry just an `entity` placeholder and the
 * `score` under test.
 */

/** A recovered item as RepoMemory's SearchResult<T> surfaces it to recall(). */
interface MockItem {
  entity: { content: string };
  score: number;
}

/** Shape of the RecallContext object repo.recall() returns. */
interface MockRecallContext {
  memories: MockItem[];
  skills: MockItem[];
  knowledge: MockItem[];
  profile: unknown;
  formatted: string;
  totalItems: number;
  estimatedChars: number;
}

/** Build a mock repo whose recall() returns the given RecallContext. */
function mockRepo(ctx: MockRecallContext) {
  return {
    recall: vi.fn().mockReturnValue(ctx),
  };
}

/** Empty RecallContext — represents a store with no recovered items. */
function emptyContext(): MockRecallContext {
  return {
    memories: [], skills: [], knowledge: [], profile: null,
    formatted: '', totalItems: 0, estimatedChars: 0,
  };
}

/**
 * Build a real MemoryProvider instance WITHOUT running the constructor.
 * We wire only the private fields `recall()` reads (agentId, recallLimit,
 * contextBudget, recallTemplate, relevanceThreshold) and the `repo` mock.
 * No mkdirSync, no RepoMemory, no disk — fully hermetic.
 */
function makeProvider(threshold: number, ctx: MockRecallContext): MemoryProvider {
  const provider = Object.create(MemoryProvider.prototype) as MemoryProvider;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = provider as any;
  internals.agentId = 'micro-expert';
  internals.recallLimit = 5;
  internals.contextBudget = 4096;
  internals.recallTemplate = 'default';
  internals.relevanceThreshold = threshold;
  internals.repo = mockRepo(ctx);
  return provider;
}

/** A formatted context string with a tool pattern (so few-shot extraction has work to do). */
const FORMATTED_WITH_TOOL =
  '- [fact] [tech] Use [MCP: greet {"name": "World"}] to say hi.\n' +
  '- [fact] [geo] The capital of France is Paris.';

describe('relevanceThreshold gate', () => {
  it('default 0 — passthrough exact even when scores are tiny', async () => {
    const ctx: MockRecallContext = {
      memories: [{ entity: { content: 'x' }, score: 0.01 }],
      skills: [{ entity: { content: 'y' }, score: 0.02 }],
      knowledge: [],
      profile: null,
      formatted: 'CTX-low-score',
      totalItems: 2,
      estimatedChars: 13,
    };
    const provider = makeProvider(0, ctx); // threshold disabled

    const result = await provider.recall('What is the capital of France?', 'local');

    // No gating at all — formatted returned verbatim, counts intact.
    expect(result.formatted).toBe('CTX-low-score');
    expect(result.totalItems).toBe(2);
    expect(result.estimatedChars).toBe(13);
  });

  it('threshold active + all scores below → empty RecallResult', async () => {
    const ctx: MockRecallContext = {
      memories: [{ entity: { content: 'x' }, score: 0.1 }],
      skills: [{ entity: { content: 'y' }, score: 0.2 }],
      knowledge: [{ entity: { content: 'z' }, score: 0.15 }],
      profile: null,
      formatted: 'CTX-irrelevant',
      totalItems: 3,
      estimatedChars: 14,
    };
    const provider = makeProvider(0.5, ctx); // max score 0.2 < 0.5

    const result = await provider.recall('What is the capital of France?', 'local');

    expect(result.formatted).toBe('');
    expect(result.totalItems).toBe(0);
    expect(result.estimatedChars).toBe(0);
    expect(result.fewShot).toEqual([]);
  });

  it('threshold active + at least one score above → passthrough intact (formatted identical to mock)', async () => {
    const ctx: MockRecallContext = {
      memories: [{ entity: { content: 'x' }, score: 0.1 }],
      skills: [{ entity: { content: 'y' }, score: 0.9 }], // meets the 0.5 threshold
      knowledge: [],
      profile: null,
      formatted: 'CTX-exact-formatted-string',
      totalItems: 2,
      estimatedChars: 25,
    };
    const provider = makeProvider(0.5, ctx);

    const result = await provider.recall('how do I greet?', 'local');

    // The formatted string is returned byte-for-byte (NOT reconstructed/filtered).
    expect(result.formatted).toBe('CTX-exact-formatted-string');
    expect(result.totalItems).toBe(2);
    expect(result.estimatedChars).toBe(25);
  });

  it('threshold active + empty store (no items) → empty result, no crash', async () => {
    const provider = makeProvider(0.5, emptyContext());

    const result = await provider.recall('What is the capital of France?', 'local');

    expect(result.formatted).toBe('');
    expect(result.totalItems).toBe(0);
    expect(result.estimatedChars).toBe(0);
    expect(result.fewShot).toEqual([]);
  });

  it('fewShot is also empty when the gate triggers (even with tool patterns in formatted)', async () => {
    // formatted contains a valid [MCP: ...] tag that WOULD yield a few-shot
    // example on passthrough — but the gate fires first, so fewShot stays [].
    const ctx: MockRecallContext = {
      memories: [{ entity: { content: 'x' }, score: 0.1 }],
      skills: [],
      knowledge: [],
      profile: null,
      formatted: FORMATTED_WITH_TOOL,
      totalItems: 2,
      estimatedChars: FORMATTED_WITH_TOOL.length,
    };
    const provider = makeProvider(0.5, ctx); // max score 0.1 < 0.5 → gated

    const result = await provider.recall('greet', 'local');

    expect(result.formatted).toBe('');
    expect(result.fewShot).toEqual([]);
  });

  it('boundary: max score exactly equal to threshold → passthrough (not gated)', async () => {
    // "menor al umbral" gates; equal is NOT below, so context is admitted.
    const ctx: MockRecallContext = {
      memories: [{ entity: { content: 'x' }, score: 0.5 }],
      skills: [],
      knowledge: [],
      profile: null,
      formatted: 'CTX-boundary',
      totalItems: 1,
      estimatedChars: 12,
    };
    const provider = makeProvider(0.5, ctx);

    const result = await provider.recall('q', 'local');

    expect(result.formatted).toBe('CTX-boundary');
    expect(result.totalItems).toBe(1);
  });

  it('passes recall options through to repo.recall unchanged', () => {
    const ctx = emptyContext();
    const provider = makeProvider(0, ctx); // disabled → still calls repo.recall
    const repo = (provider as unknown as { repo: { recall: ReturnType<typeof vi.fn> } }).repo;

    provider.recall('a query', 'a-user');

    expect(repo.recall).toHaveBeenCalledTimes(1);
    const [agentId, userId, query, opts] = repo.recall.mock.calls[0];
    expect(agentId).toBe('micro-expert');
    expect(userId).toBe('a-user');
    expect(query).toBe('a query');
    expect(opts).toMatchObject({
      maxItems: 5,
      maxChars: 4096,
      template: 'default',
      includeProfile: true,
      includeSharedSkills: true,
      includeSharedKnowledge: true,
    });
  });
});