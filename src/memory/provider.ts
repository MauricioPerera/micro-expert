import { mkdirSync } from 'node:fs';
import { RepoMemory } from '@rckflr/repomemory';
import * as RepoMemoryNS from '@rckflr/repomemory';
import type { MicroExpertConfig } from '../config.js';
import { MEMORY_DIR } from '../config.js';
import type { RagLocalConfig } from '../config.js';
import { validateToolTagContent } from '../pack/validate.js';

/**
 * Feature-detection for optional A2E helpers exported by @rckflr/repomemory.
 *
 * `ingestA2EKnowledge` and `sanitizeSecrets` were introduced after the
 * currently-published 2.16.0 release; the code that consumes them was written
 * against an unreleased 2.19.0 API. To keep build green against 2.16.0 without
 * deleting the A2E logic, we resolve them dynamically off the module namespace
 * and degrade to a silent no-op (with a single debug log) when absent. When a
 * future @rckflr/repomemory version re-exports these functions, the existing
 * call sites light up automatically — no code change required.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RM_NS = RepoMemoryNS as any;
const A2E_INGEST: ((repo: RepoMemory, agentId: string) => void) | undefined =
  typeof RM_NS.ingestA2EKnowledge === 'function' ? RM_NS.ingestA2EKnowledge : undefined;
const A2E_SANITIZE: ((input: string, secrets: Record<string, string>) => string) | undefined =
  typeof RM_NS.sanitizeSecrets === 'function' ? RM_NS.sanitizeSecrets : undefined;

let a2eIngestNoopWarned = false;
let a2eSanitizeNoopWarned = false;

/** Simple text-only message (for memory storage — no vision/multimodal). */
export interface TextMessage {
  role: string;
  content: string;
}

export interface FewShotExample {
  user: string;
  assistant: string;
}

export interface RecallResult {
  formatted: string;
  totalItems: number;
  estimatedChars: number;
  /** Few-shot examples extracted from memories (e.g., skill demonstrations) */
  fewShot: FewShotExample[];
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  preview: string;
}

export interface MemoryExportEntry {
  content: string;
  category: string;
  tags: string[];
}

/**
 * Memory Pack metadata — describes a distributable collection of memories/skills.
 * Used in version 2 exports for catalog publishing and cold-start solving.
 */
export interface MemoryPackMeta {
  /** Human-readable pack name (e.g., "n8n MCP Skills") */
  name: string;
  /** Short description of what this pack teaches the agent */
  description: string;
  /** Pack author or publisher */
  author?: string;
  /** Semantic version (e.g., "1.0.0") */
  packVersion?: string;
  /** Model families this pack was tested with */
  models?: string[];
  /** URL to source repository or documentation */
  url?: string;
  /** Arbitrary tags for catalog search/filtering */
  packTags?: string[];
}

export interface MemoryExportFile {
  /** Format version: 1 = flat memories only, 2 = memories + skills + pack metadata */
  version: number;
  exportedAt: string;
  userId: string;
  agentId: string;
  count: number;
  /** Pack metadata (v2+) */
  pack?: MemoryPackMeta;
  /** Skill entries — few-shot examples for tool calling (v2+) */
  skills?: MemoryExportEntry[];
  memories: MemoryExportEntry[];
}

/**
 * Thin wrapper over RepoMemory embedded instance.
 * All memory operations go through here — no HTTP, no separate server.
 */
/**
 * AI provider interface matching RepoMemory's AiProvider.
 * Implement this to enable automatic mining of sessions.
 */
export interface AiProvider {
  chat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<string>;
}

export class MemoryProvider {
  private repo: RepoMemory;
  private readonly agentId: string;
  private readonly recallLimit: number;
  private readonly contextBudget: number;
  private readonly recallTemplate: string;
  private readonly relevanceThreshold: number;
  private readonly a2eSecrets: Record<string, string>;
  private miningEnabled = false;
  private readonly retrievalProvider: 'repomemory' | 'rag-local';
  private readonly ragLocalConfig: Readonly<RagLocalResolved> | undefined;

  constructor(config: MicroExpertConfig, ai?: AiProvider) {
    this.agentId = config.agentId;
    this.recallLimit = config.recallLimit;
    this.contextBudget = config.contextBudget;
    this.recallTemplate = config.recallTemplate;
    this.relevanceThreshold = config.relevanceThreshold;
    this.a2eSecrets = config.a2e?.secrets || {};
    this.retrievalProvider = config.retrieval?.provider ?? 'repomemory';
    this.ragLocalConfig = resolveRagLocalConfig(config);

    // Ensure memory directory exists
    mkdirSync(MEMORY_DIR, { recursive: true });

    this.repo = new RepoMemory({
      dir: MEMORY_DIR,
      compactPrompts: true,
      lockEnabled: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ai: ai as any,
      autoMine: !!ai,
    });

    this.miningEnabled = !!ai;

    // Ingest A2E protocol documentation as knowledge (idempotent via saveOrUpdate)
    if (config.a2e?.url) {
      if (A2E_INGEST) {
        A2E_INGEST(this.repo, this.agentId);
      } else if (!a2eIngestNoopWarned) {
        a2eIngestNoopWarned = true;
        console.log('[micro-expert] [debug] ingestA2EKnowledge not available in this @rckflr/repomemory version — A2E knowledge ingestion skipped (no-op)');
      }
    }

    if (ai) {
      // Listen for auto-mine events
      this.repo.events.on('session:mined', (payload) => {
        console.log(`[micro-expert] Auto-mined session ${payload.sessionId}`);

        // Mine A2E workflow patterns additionally (deterministic, no AI needed)
        try {
          const session = this.getSession(payload.sessionId);
          if (session?.content) {
            const a2eCount = this.mineA2ePatterns(session.content, config.defaultUserId);
            if (a2eCount > 0) {
              console.log(`[micro-expert] Extracted ${a2eCount} A2E workflow pattern(s)`);
            }
          }
        } catch (e) {
          console.error(`[micro-expert] A2E mining error: ${(e as Error).message}`);
        }
      });
      this.repo.events.on('session:automine:error', (payload) => {
        console.error(`[micro-expert] Auto-mine error for ${payload.sessionId}: ${payload.error}`);
      });
    }
  }

  get isMiningEnabled(): boolean {
    return this.miningEnabled;
  }

  /**
   * Recall relevant context for a query.
   *
   * This is the ONLY pluggable step in the memory pipeline: sessions, mining,
   * profiles, import/export and few-shot skill packs always stay on RepoMemory
   * (see saveSession/mine/saveProfile/exportMemories below) — switching the
   * retrieval provider redirects just this read path.
   *
   * With the default `repomemory` provider the returned {@link RecallResult} is
   * byte-identical to the original synchronous behavior (same formatted string,
   * same item count, same few-shot examples). With `rag-local` the formatted
   * context is built from the remote hits' descriptions and `fewShot` is always
   * empty; any fetch/timeout error degrades to an empty result — the user's
   * request is NEVER crashed by the external retrieval.
   */
  async recall(query: string, userId: string): Promise<RecallResult> {
    if (this.retrievalProvider === 'rag-local') {
      return this.recallRagLocal(query);
    }
    return this.recallRepoMemory(query, userId);
  }

  /**
   * RepoMemory-backed recall — the default path. Byte-identical to the original
   * synchronous behavior: same CTT query, same relevance gate, same few-shot
   * extraction, same returned object. `repo.recall` is itself synchronous, but
   * we await it uniformly so callers see one async contract regardless of
   * provider (awaiting a non-thenable value resolves immediately).
   */
  private async recallRepoMemory(query: string, userId: string): Promise<RecallResult> {
    const result = await this.repo.recall(this.agentId, userId, query, {
      maxItems: this.recallLimit,
      maxChars: this.contextBudget,
      template: this.recallTemplate,
      includeProfile: true,
      includeSharedSkills: true,
      includeSharedKnowledge: true,
    });

    // Relevance gate: when a positive threshold is configured, suppress context
    // injection entirely if the best recovered item is not relevant enough.
    // The score is RepoMemory's hybrid ranking score (non-normalized scale) —
    // see `relevanceThreshold` in config.ts. We take the MAX across all three
    // collections so a single on-topic item is enough to admit the context.
    // On gate, we return a fully empty RecallResult (no profile, no few-shot,
    // no formatted) — zero injection. When the max meets the threshold, the
    // formatted context is returned UNCHANGED (we do not filter individual
    // items); per-item filtering is an explicit follow-up, out of scope here.
    if (this.relevanceThreshold > 0) {
      const all = [...result.memories, ...result.skills, ...result.knowledge];
      const maxScore = all.length > 0 ? Math.max(...all.map(r => r.score)) : 0;
      if (maxScore < this.relevanceThreshold) {
        return { formatted: '', totalItems: 0, estimatedChars: 0, fewShot: [] };
      }
    }

    // Extract few-shot examples from recalled memories that contain tool patterns.
    // Memories with "[MCP: ...]", "[CALC: ...]", or "[FETCH: ...]" are converted to
    // user/assistant conversation pairs so the model learns by example, not by instruction.
    const fewShot = extractFewShotExamples(result.formatted);

    return {
      formatted: result.formatted,
      totalItems: result.totalItems,
      estimatedChars: result.estimatedChars,
      fewShot,
    };
  }

  /**
   * rag-local-backed recall — opt-in remote path.
   *
   * POSTs `{ text, k, threshold, expand_links, hops }` to
   * `<url>/collections/<collection>/query` and builds the formatted context
   * from the returned hits. fewShot is ALWAYS empty here: skill/tool-example
   * packs live in RepoMemory and are not exposed through rag-local. The
   * `relevanceThreshold` gate does NOT apply (it operates on RepoMemory's
   * non-normalized score scale); the rag-local `threshold` is enforced
   * server-side via the request body.
   *
   * On no hits, fetch failure, non-2xx response, or timeout, this returns an
   * empty RecallResult (after a `console.warn`) — never throws. Expanded hits
   * (which carry `score: null`) are included in the formatted output.
   */
  private async recallRagLocal(query: string): Promise<RecallResult> {
    const empty: RecallResult = { formatted: '', totalItems: 0, estimatedChars: 0, fewShot: [] };
    const cfg = this.ragLocalConfig;
    if (!cfg) {
      console.warn('[micro-expert] rag-local retrieval selected but no ragLocal config provided — returning empty context');
      return empty;
    }

    const url = `${cfg.url.replace(/\/+$/, '')}/collections/${encodeURIComponent(cfg.collection)}/query`;
    const body = {
      text: query,
      k: cfg.k,
      threshold: cfg.threshold,
      expand_links: cfg.expandLinks,
      hops: cfg.hops,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`[micro-expert] rag-local query failed: HTTP ${res.status} ${res.statusText} — returning empty context`);
        return empty;
      }
      const hits = await res.json() as RagLocalHit[];
      if (!Array.isArray(hits) || hits.length === 0) return empty;

      const lines = hits.map(h => `- ${renderMarkdownLinksToPlain(h.description ?? '')}`);
      const formatted = `Facts from memory:\n${lines.join('\n')}`;
      return { formatted, totalItems: hits.length, estimatedChars: formatted.length, fewShot: [] };
    } catch (e) {
      const err = e as Error;
      const reason = err.name === 'AbortError'
        ? `timed out after ${cfg.timeoutMs}ms`
        : `failed: ${err.message}`;
      console.warn(`[micro-expert] rag-local query ${reason} — returning empty context`);
      return empty;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Search specifically for A2E workflow skills that match a query.
   * Returns workflow patterns the agent has used successfully before.
   */
  recallWorkflows(query: string, userId: string, limit = 3): string[] {
    const results = this.searchMemories(query, userId, limit * 3);
    return results
      .filter(r => r.category === 'a2e-workflow' || r.category === 'a2e-skill')
      .slice(0, limit)
      .map(r => r.content);
  }

  /**
   * Save a conversation turn as a session.
   */
  saveSession(userId: string, messages: TextMessage[]): string | null {
    try {
      const [session] = this.repo.sessions.save(this.agentId, userId, {
        content: messages.map(m => `${m.role}: ${m.content}`).join('\n'),
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      });
      return session.id;
    } catch (e) {
      console.error('[micro-expert] session save failed:', (e as Error).message);
      return null;
    }
  }

  /**
   * Save a memory entity (fact, decision, correction, etc.)
   */
  saveMemory(userId: string, content: string, category: string, tags: string[] = []): void {
    try {
      this.repo.memories.saveOrUpdate(this.agentId, userId, {
        content,
        category,
        tags: ['micro-expert', ...tags],
      });
    } catch (e) {
      console.error('[micro-expert] memory save failed:', (e as Error).message);
    }
  }

  /**
   * Search memories by query.
   */
  searchMemories(query: string, userId: string, limit = 5): Array<{ content: string; score: number; category?: string }> {
    try {
      const results = this.repo.memories.search(this.agentId, userId, query, limit);
      return results.map(r => ({
        content: r.entity.content,
        score: r.score,
        category: r.entity.category,
      }));
    } catch (e) {
      console.error('[micro-expert] memory search failed:', (e as Error).message);
      return [];
    }
  }

  /**
   * Get conversation history (list of sessions).
   */
  getHistory(userId: string, limit = 20): SessionSummary[] {
    try {
      const sessions = this.repo.sessions.list(this.agentId, userId);
      return sessions
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, limit)
        .map(s => ({
          id: s.id,
          createdAt: s.createdAt,
          preview: s.content.slice(0, 100),
        }));
    } catch (e) {
      console.error('[micro-expert] history list failed:', (e as Error).message);
      return [];
    }
  }

  /**
   * Get a specific session by ID.
   */
  getSession(sessionId: string): { id: string; content: string; messages?: TextMessage[]; createdAt: string } | null {
    try {
      const session = this.repo.sessions.get(sessionId);
      if (!session) return null;
      return {
        id: session.id,
        content: session.content,
        messages: session.messages as TextMessage[] | undefined,
        createdAt: session.createdAt,
      };
    } catch {
      return null;
    }
  }

  /**
   * Mine a session for memories/skills (requires AI provider configured).
   */
  async mine(sessionId: string): Promise<{ memories: number; skills: number }> {
    try {
      const result = await this.repo.mine(sessionId);
      return {
        memories: result.memories.length,
        skills: result.skills.length,
      };
    } catch (e) {
      console.error('[micro-expert] mining failed:', (e as Error).message);
      return { memories: 0, skills: 0 };
    }
  }

  /**
   * Save or update a user profile.
   */
  saveProfile(userId: string, content: string, metadata?: Record<string, unknown>): void {
    try {
      this.repo.profiles.save(this.agentId, userId, { content, metadata });
    } catch (e) {
      console.error('[micro-expert] profile save failed:', (e as Error).message);
    }
  }

  /**
   * Get storage stats.
   */
  stats(): Record<string, unknown> {
    return this.repo.stats();
  }

  /**
   * Health check — verifies storage is accessible.
   */
  healthCheck(): boolean {
    try {
      this.repo.stats();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Export memories for a user as a portable JSON structure.
   * @param userId - User ID to export for
   * @param packMeta - Optional pack metadata for v2 format (catalog publishing)
   * @param filter - Optional filter: search query (TF-IDF relevance) and/or tags to match
   */
  exportMemories(
    userId: string,
    packMeta?: MemoryPackMeta,
    filter?: { query?: string; tags?: string[]; minScore?: number },
  ): MemoryExportFile {
    const memories: MemoryExportEntry[] = [];
    const skills: MemoryExportEntry[] = [];

    // Collect matching memories — either filtered by query/tags or all
    const allEntries = filter?.query
      ? this.searchAndCollect(userId, filter.query, filter.tags, filter.minScore ?? 0.1)
      : this.listAndCollect(userId, filter?.tags);

    for (const entry of allEntries) {
      if (isSkillEntry(entry)) {
        skills.push(entry);
      } else {
        memories.push(entry);
      }
    }

    // Use v2 format when pack metadata is provided or skills are found
    const useV2 = packMeta || skills.length > 0;

    const result: MemoryExportFile = {
      version: useV2 ? 2 : 1,
      exportedAt: new Date().toISOString(),
      userId,
      agentId: this.agentId,
      count: memories.length + skills.length,
      memories,
    };

    if (useV2) {
      result.skills = skills;
      if (packMeta) result.pack = packMeta;
    }

    return result;
  }

  /**
   * Import memories from a portable JSON structure (v1 or v2).
   * v2 format also imports skills (few-shot tool examples).
   * Returns counts of imported and failed entries.
   */
  importMemories(userId: string, data: MemoryExportFile): { imported: number; skipped: number; errors: number; skills: number } {
    if (data.version !== 1 && data.version !== 2) {
      throw new Error(`Unsupported export version: ${data.version}. Expected version 1 or 2.`);
    }

    if (!Array.isArray(data.memories)) {
      throw new Error('Invalid export file: "memories" must be an array.');
    }

    let imported = 0;
    let skipped = 0;
    let errors = 0;
    let skills = 0;

    // Import memories
    for (const entry of data.memories) {
      const result = this.importEntry(userId, entry);
      if (result === 'ok') imported++;
      else if (result === 'skip') { skipped++; errors++; }
      else errors++;
    }

    // Import skills (v2)
    if (data.version >= 2 && Array.isArray(data.skills)) {
      for (const entry of data.skills) {
        const result = this.importEntry(userId, entry);
        if (result === 'ok') { imported++; skills++; }
        else if (result === 'skip') { skipped++; errors++; }
        else errors++;
      }
    }

    // Log pack info if present
    if (data.pack?.name) {
      console.log(`[micro-expert] Installed pack: "${data.pack.name}"${data.pack.packVersion ? ` v${data.pack.packVersion}` : ''}`);
    }

    return { imported, skipped, errors, skills };
  }

  /**
   * Import a single memory entry. Returns 'ok', 'skip', or 'error'.
   */
  private importEntry(userId: string, entry: MemoryExportEntry): 'ok' | 'skip' | 'error' {
    if (!entry.content || typeof entry.content !== 'string') {
      return 'skip';
    }

    try {
      this.repo.memories.saveOrUpdate(this.agentId, userId, {
        content: entry.content,
        category: entry.category || 'fact',
        tags: ['micro-expert', ...(entry.tags || [])],
      });
      return 'ok';
    } catch (e) {
      console.error(`[micro-expert] import error: ${(e as Error).message}`);
      return 'error';
    }
  }

  /**
   * Extract A2E workflow patterns from a session's content.
   * This is deterministic (no AI needed) — parses [A2E: ...] tags
   * and their surrounding context to create structured workflow skills.
   */
  mineA2ePatterns(sessionContent: string, userId: string): number {
    let saved = 0;
    const lines = sessionContent.split('\n');

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      // Find lines containing [A2E: ...] tags
      const tagMatch = line.match(/\[A2E:\s*([\s\S]*?)\]/);
      if (!tagMatch) continue;

      const tagContent = tagMatch[1].trim();
      if (!tagContent) continue;

      // Skip error results
      if (line.includes('[error:')) continue;

      // Look backwards for a user: line to get the query
      let userQuery = '';
      for (let i = idx - 1; i >= 0; i--) {
        if (lines[i].startsWith('user:')) {
          userQuery = lines[i].replace(/^user:\s*/, '').trim();
          break;
        }
      }

      if (userQuery) {
        let sanitizedTag = tagContent;
        if (A2E_SANITIZE) {
          sanitizedTag = A2E_SANITIZE(tagContent, this.a2eSecrets);
        } else if (!a2eSanitizeNoopWarned) {
          a2eSanitizeNoopWarned = true;
          console.log('[micro-expert] [debug] sanitizeSecrets not available in this @rckflr/repomemory version — secrets left unsanitized (no-op)');
        }
        const content = `Para ${userQuery.slice(0, 100)}: [A2E: ${sanitizedTag}]`;

        // Deterministic gate: discard malformed patterns before they enter the
        // store and later get amplified via few-shot recall.
        const tagCheck = validateToolTagContent(content);
        if (!tagCheck.valid) {
          const preview = content.slice(0, 60);
          console.log(
            `[micro-expert] few-shot excluded (invalid tool tag): ${preview} — ${tagCheck.errors[0]}`,
          );
          continue;
        }

        this.saveMemory(userId, content, 'a2e-workflow', ['a2e', 'workflow', 'mined']);
        saved++;
      }
    }

    return saved;
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.repo.dispose();
  }

  /**
   * Search memories by query and collect as export entries.
   * Uses TF-IDF relevance scoring to find topic-specific memories.
   */
  private searchAndCollect(
    userId: string,
    query: string,
    filterTags?: string[],
    minScore = 0.1,
  ): MemoryExportEntry[] {
    const results = this.repo.memories.find(this.agentId, userId, query, 500);
    const entries: MemoryExportEntry[] = [];

    for (const r of results) {
      if (r.score < minScore) continue;

      const tags = r.entity.tags.filter(t => t !== 'micro-expert');

      // If tag filter is specified, entry must have at least one matching tag
      if (filterTags && filterTags.length > 0) {
        const hasMatch = filterTags.some(ft => tags.includes(ft));
        if (!hasMatch) continue;
      }

      entries.push({
        content: r.entity.content,
        category: r.entity.category,
        tags,
      });
    }

    return entries;
  }

  /**
   * List all memories and optionally filter by tags.
   */
  private listAndCollect(userId: string, filterTags?: string[]): MemoryExportEntry[] {
    const entries: MemoryExportEntry[] = [];
    const pageSize = 100;
    let offset = 0;

    while (true) {
      const page = this.repo.memories.listPaginated(this.agentId, userId, {
        limit: pageSize,
        offset,
      });

      for (const mem of page.items) {
        const tags = mem.tags.filter(t => t !== 'micro-expert');

        // If tag filter is specified, entry must have at least one matching tag
        if (filterTags && filterTags.length > 0) {
          const hasMatch = filterTags.some(ft => tags.includes(ft));
          if (!hasMatch) continue;
        }

        entries.push({
          content: mem.content,
          category: mem.category,
          tags,
        });
      }

      if (!page.hasMore) break;
      offset += pageSize;
    }

    return entries;
  }
}

/**
 * Extract few-shot examples from recalled memory text.
 *
 * Scans for memory entries containing tool patterns like [MCP: ...], [CALC: ...], [FETCH: ...].
 * When found, attempts to parse them into user/assistant pairs suitable for few-shot prompting.
 *
 * Recognized formats in memory content:
 *   - "El usuario pide X. Respuesta correcta: [MCP: ...]"
 *   - "Para X: [MCP: tool_name {args}]"
 *   - "Use [MCP: tool_name {args}] to X"
 *
 * Returns at most 3 examples to keep context short for small models.
 */
/**
 * Detect if a memory entry is a "skill" — contains tool-calling patterns
 * that should be exported separately for few-shot injection.
 */
function isSkillEntry(entry: MemoryExportEntry): boolean {
  return /\[(MCP|CALC|FETCH|A2E):/.test(entry.content) &&
    (entry.category === 'mcp-skill' || entry.category === 'mcp-tools' ||
     entry.category === 'skill' || entry.category === 'mcp-format' ||
     entry.category === 'a2e-skill' || entry.category === 'a2e-workflow' ||
     entry.category === 'a2e-error');
}

export function extractFewShotExamples(recalledText: string): FewShotExample[] {
  const examples: FewShotExample[] = [];
  if (!recalledText) return examples;

  // Split recalled text into individual memory entries (each starts with "- [")
  const entries = recalledText.split(/\n- \[/).slice(1); // skip header

  for (const entry of entries) {
    // Only process entries that contain tool tags
    if (!/\[(MCP|CALC|FETCH|A2E):/.test(entry)) continue;

    // Strip "[category] [tags] " prefix from recalled memory entry
    // Format: "category] [tag1, tag2, ...] actual content"
    const content = entry.replace(/^[^\]]*\]\s*(?:\[[^\]]*\]\s*)?/, '');

    // Deterministic gate: drop memories whose tool tags are malformed so the
    // model cannot imitate a broken pattern. The memory stays in the store
    // and in the normal recall context — only the few-shot example is excluded.
    const tagCheck = validateToolTagContent(content);
    if (!tagCheck.valid) {
      const preview = content.slice(0, 60);
      console.log(
        `[micro-expert] few-shot excluded (invalid tool tag): ${preview} — ${tagCheck.errors[0]}`,
      );
      continue;
    }

    // Try to extract a tool call tag from the content
    const toolMatch = content.match(/\[(MCP|CALC|FETCH|A2E):\s*[\s\S]*?\]/);
    if (!toolMatch) continue;

    // For MCP/A2E tags, use bracket-aware extraction to get the full tag
    let toolTag: string;
    if (toolMatch[1] === 'MCP' || toolMatch[1] === 'A2E') {
      const tagPrefix = `[${toolMatch[1]}:`;
      const mcpStart = content.indexOf(tagPrefix);
      if (mcpStart === -1) continue;
      // Count brackets to find the correct end
      let depth = 0;
      let end = mcpStart;
      for (let i = mcpStart; i < content.length; i++) {
        if (content[i] === '[') depth++;
        else if (content[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      toolTag = content.slice(mcpStart, end);
    } else {
      toolTag = toolMatch[0];
    }

    // Try to derive a user question from surrounding text
    let userQ = '';

    // Pattern: "El usuario pide X" or "Para X:" or "To X:" or "Use ... to X"
    const preText = content.slice(0, content.indexOf(toolTag[0] === '[' ? toolTag : `[${toolTag}`)).trim();
    if (preText.length > 5) {
      // Clean up connecting words
      userQ = preText
        .replace(/^(Ejemplo[^:]*:|Para |To |Use .*? to )/i, '')
        .replace(/\.?\s*(Respuesta correcta:.*|→|:)\s*$/i, '')
        .replace(/El usuario pide\s*/i, '')
        .replace(/\.\s*$/, '')
        .trim();
    }

    // Fallback: derive from tool name
    if (!userQ && toolMatch[1] === 'MCP') {
      const nameMatch = toolTag.match(/\[MCP:\s*(\S+)/);
      if (nameMatch) {
        const name = nameMatch[1].replace(/_/g, ' ');
        userQ = name; // e.g., "n8n list workflows"
      }
    }

    if (userQ && toolTag) {
      examples.push({ user: userQ, assistant: toolTag });
    }

    if (examples.length >= 3) break; // Keep it short for small models
  }

  return examples;
}

/** A hit returned by a rag-local `POST /collections/<name>/query` request. */
interface RagLocalHit {
  id: string;
  /** Cosine similarity in [0,1]; `null` for expanded (link-followed) hits. */
  score: number | null;
  /** Hit text — may contain markdown links like `[label](node-id)`. */
  description: string;
  /** True when this hit was reached via graph-link expansion. */
  expanded?: boolean;
  /** Node IDs the hit was reached through (when expanded). */
  via?: string[];
}

/** rag-local config with all defaults resolved (used by the recall path). */
interface RagLocalResolved {
  url: string;
  collection: string;
  k: number;
  threshold: number;
  expandLinks: boolean;
  hops: number;
  timeoutMs: number;
}

const RAG_LOCAL_DEFAULTS: Omit<RagLocalResolved, 'collection'> = {
  url: 'http://127.0.0.1:8937',
  k: 5,
  threshold: 0.35,
  expandLinks: true,
  hops: 2,
  timeoutMs: 10_000,
};

/**
 * Resolve the optional {@link RagLocalConfig} from the user's config into a
 * fully-populated object with defaults applied. Returns `undefined` when no
 * rag-local config is present (the repomemory path is used instead).
 */
function resolveRagLocalConfig(config: MicroExpertConfig): Readonly<RagLocalResolved> | undefined {
  const raw = config.retrieval?.ragLocal;
  if (!raw) return undefined;
  return {
    url: raw.url ?? RAG_LOCAL_DEFAULTS.url,
    collection: raw.collection,
    k: raw.k ?? RAG_LOCAL_DEFAULTS.k,
    threshold: raw.threshold ?? RAG_LOCAL_DEFAULTS.threshold,
    expandLinks: raw.expandLinks ?? RAG_LOCAL_DEFAULTS.expandLinks,
    hops: raw.hops ?? RAG_LOCAL_DEFAULTS.hops,
    timeoutMs: raw.timeoutMs ?? RAG_LOCAL_DEFAULTS.timeoutMs,
  };
}

/**
 * Render markdown links to plain text: `[label](target)` → `label`.
 * rag-local descriptions may embed links like `[repo name](node:abc)`; we keep
 * only the label so the injected context reads as plain facts.
 */
function renderMarkdownLinksToPlain(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1');
}
