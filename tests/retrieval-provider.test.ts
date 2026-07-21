import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryProvider } from '../src/memory/provider.js';
import type { RecallResult } from '../src/memory/provider.js';

/**
 * Hermetic tests for the pluggable retrieval provider in MemoryProvider.recall.
 *
 * Style mirrors builtin-tools-gate.test.ts and relevance-threshold.test.ts:
 * literal config, no loadConfig(), no filesystem, no real RepoMemory. We build a
 * real MemoryProvider instance via Object.create (bypassing the constructor) and
 * wire only the private fields the `recall` path reads. The global `fetch` is
 * stubbed with vi.stubGlobal and restored in afterEach.
 *
 * Only the context-recall step is pluggable; these tests cover both the default
 * `repomemory` passthrough and the opt-in `rag-local` path (happy, no-hits, fetch
 * rejection, timeout, and expanded hits with `score: null`).
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

/** rag-local hit shape returned by POST /collections/<name>/query. */
interface RagLocalHit {
  id: string;
  score: number | null;
  description: string;
  expanded?: boolean;
  via?: string[];
}

/** Resolved rag-local config (the shape MemoryProvider stores after defaults). */
interface RagLocalResolved {
  url: string;
  collection: string;
  k: number;
  threshold: number;
  expandLinks: boolean;
  hops: number;
  timeoutMs: number;
}

const RAG_LOCAL_DEFAULTS: RagLocalResolved = {
  url: 'http://127.0.0.1:8937',
  collection: 'mycoll',
  k: 5,
  threshold: 0.35,
  expandLinks: true,
  hops: 2,
  timeoutMs: 10_000,
};

const EMPTY_RESULT: RecallResult = { formatted: '', totalItems: 0, estimatedChars: 0, fewShot: [] };

/** Build a real MemoryProvider WITHOUT the constructor, wired for repomemory. */
function makeRepoMemoryProvider(ctx: MockRecallContext): MemoryProvider {
  const provider = Object.create(MemoryProvider.prototype) as MemoryProvider;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = provider as any;
  internals.agentId = 'micro-expert';
  internals.recallLimit = 5;
  internals.contextBudget = 4096;
  internals.recallTemplate = 'default';
  internals.relevanceThreshold = 0; // gate disabled — pure passthrough
  internals.retrievalProvider = 'repomemory';
  internals.ragLocalConfig = undefined;
  internals.repo = { recall: vi.fn().mockReturnValue(ctx) };
  return provider;
}

/** Build a real MemoryProvider WITHOUT the constructor, wired for rag-local. */
function makeRagLocalProvider(ragLocal: Partial<RagLocalResolved> = {}): MemoryProvider {
  const provider = Object.create(MemoryProvider.prototype) as MemoryProvider;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = provider as any;
  internals.retrievalProvider = 'rag-local';
  internals.ragLocalConfig = { ...RAG_LOCAL_DEFAULTS, ...ragLocal };
  return provider;
}

/** A fetch Response mock returning `hits` from res.json() with a 200 status. */
function fetchOkResponse(hits: RagLocalHit[]) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => hits,
  };
}

/** A fetch Response mock with a non-2xx status. */
function fetchErrorResponse(status: number, statusText: string) {
  return { ok: false, status, statusText, json: async () => [] };
}

/** AbortError-shaped rejection (the name is what the provider checks). */
function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

/** Stub global fetch with an implementation; restored in afterEach. */
function stubFetch(impl: (url: string, init?: RequestInit) => unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl as never) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('retrieval provider — default repomemory (passthrough identical)', () => {
  it('returns the repo.recall() result byte-identical (no gate, no few-shot tags)', async () => {
    const ctx: MockRecallContext = {
      memories: [{ entity: { content: 'x' }, score: 0.9 }],
      skills: [],
      knowledge: [],
      profile: null,
      formatted: 'CTX-verbatim',
      totalItems: 7,
      estimatedChars: 12,
    };
    const provider = makeRepoMemoryProvider(ctx);
    const repo = (provider as unknown as { repo: { recall: ReturnType<typeof vi.fn> } }).repo;

    const result = await provider.recall('a query', 'a-user');

    // Same object shape and values as the repo returned — no transformation.
    expect(result.formatted).toBe('CTX-verbatim');
    expect(result.totalItems).toBe(7);
    expect(result.estimatedChars).toBe(12);
    // No tool tags in formatted → no few-shot examples extracted.
    expect(result.fewShot).toEqual([]);
    // repo.recall still receives the same options as before.
    expect(repo.recall).toHaveBeenCalledTimes(1);
    const [, userId, query, opts] = repo.recall.mock.calls[0];
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

describe('retrieval provider — rag-local', () => {
  it('happy path: builds formatted with links rendered to plain text and sends correct params', async () => {
    const hits: RagLocalHit[] = [
      { id: 'node:1', score: 0.91, description: 'Project uses [TypeScript](node:ts) for the CLI.' },
      { id: 'node:2', score: 0.72, description: 'Tests run with [vitest](node:vitest).' },
    ];
    const fetchFn = stubFetch(async () => fetchOkResponse(hits));
    const provider = makeRagLocalProvider();

    const result = await provider.recall('what stack does the project use?', 'local');

    // URL: <base>/collections/<collection>/query
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8937/collections/mycoll/query');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    // Body carries the resolved rag-local params.
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      text: 'what stack does the project use?',
      k: 5,
      threshold: 0.35,
      expand_links: true,
      hops: 2,
    });
    // Links rendered to plain text: [label](target) → label.
    expect(result.formatted).toBe(
      'Facts from memory:\n' +
      '- Project uses TypeScript for the CLI.\n' +
      '- Tests run with vitest.',
    );
    expect(result.totalItems).toBe(2);
    expect(result.estimatedChars).toBe(result.formatted.length);
    // fewShot is always empty under rag-local — skill packs live in RepoMemory.
    expect(result.fewShot).toEqual([]);
  });

  it('no hits → empty RecallResult', async () => {
    stubFetch(async () => fetchOkResponse([]));
    const provider = makeRagLocalProvider();

    const result = await provider.recall('an off-topic query', 'local');

    expect(result).toEqual(EMPTY_RESULT);
  });

  it('fetch rejects → warns and returns empty, never throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubFetch(async () => { throw new Error('ECONNREFUSED'); });
    const provider = makeRagLocalProvider();

    const result = await provider.recall('any query', 'local');

    expect(result).toEqual(EMPTY_RESULT);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('rag-local query failed');
  });

  it('timeout → warns and returns empty, never throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // fetch holds until the provider's AbortController fires, then rejects with
    // an AbortError — mirroring a real timed-out request.
    stubFetch((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error('no signal'));
      if (signal.aborted) return reject(abortError());
      signal.addEventListener('abort', () => reject(abortError()));
    }));
    const provider = makeRagLocalProvider({ timeoutMs: 50 });

    const result = await provider.recall('a slow query', 'local');

    expect(result).toEqual(EMPTY_RESULT);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('timed out after 50ms');
  });

  it('expanded hits (score null) are included in the formatted output', async () => {
    const hits: RagLocalHit[] = [
      { id: 'node:1', score: 0.88, description: 'Direct fact.' },
      { id: 'node:9', score: null, description: 'Expanded fact via [link](node:2).', expanded: true, via: ['node:1'] },
    ];
    stubFetch(async () => fetchOkResponse(hits));
    const provider = makeRagLocalProvider();

    const result = await provider.recall('show me related facts', 'local');

    expect(result.totalItems).toBe(2);
    expect(result.formatted).toContain('- Direct fact.');
    // The expanded hit is present with its link rendered to plain text.
    expect(result.formatted).toContain('- Expanded fact via link.');
    expect(result.formatted).not.toContain('[link]');
  });

  it('non-2xx response → warns and returns empty', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubFetch(async () => fetchErrorResponse(500, 'Internal Server Error'));
    const provider = makeRagLocalProvider();

    const result = await provider.recall('any query', 'local');

    expect(result).toEqual(EMPTY_RESULT);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('HTTP 500');
  });
});