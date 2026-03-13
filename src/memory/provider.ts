import { mkdirSync } from 'node:fs';
import { RepoMemory } from '@rckflr/repomemory';
import type { MicroExpertConfig } from '../config.js';
import { MEMORY_DIR } from '../config.js';

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
  private miningEnabled = false;

  constructor(config: MicroExpertConfig, ai?: AiProvider) {
    this.agentId = config.agentId;
    this.recallLimit = config.recallLimit;
    this.contextBudget = config.contextBudget;
    this.recallTemplate = config.recallTemplate;

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

    if (ai) {
      // Listen for auto-mine events
      this.repo.events.on('session:mined', (payload) => {
        console.log(`[micro-expert] Auto-mined session ${payload.sessionId}`);
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
   * Recall relevant context for a query using CTT scoring.
   * Returns formatted context string ready for system prompt injection.
   */
  recall(query: string, userId: string): RecallResult {
    const result = this.repo.recall(this.agentId, userId, query, {
      maxItems: this.recallLimit,
      maxChars: this.contextBudget,
      template: this.recallTemplate,
      includeProfile: true,
      includeSharedSkills: true,
      includeSharedKnowledge: true,
    });

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
  return /\[(MCP|CALC|FETCH):/.test(entry.content) &&
    (entry.category === 'mcp-skill' || entry.category === 'mcp-tools' ||
     entry.category === 'skill' || entry.category === 'mcp-format');
}

function extractFewShotExamples(recalledText: string): FewShotExample[] {
  const examples: FewShotExample[] = [];
  if (!recalledText) return examples;

  // Split recalled text into individual memory entries (each starts with "- [")
  const entries = recalledText.split(/\n- \[/).slice(1); // skip header

  for (const entry of entries) {
    // Only process entries that contain tool tags
    if (!/\[(MCP|CALC|FETCH):/.test(entry)) continue;

    // Strip "[category] [tags] " prefix from recalled memory entry
    // Format: "category] [tag1, tag2, ...] actual content"
    const content = entry.replace(/^[^\]]*\]\s*(?:\[[^\]]*\]\s*)?/, '');

    // Try to extract a tool call tag from the content
    const toolMatch = content.match(/\[(MCP|CALC|FETCH):\s*[\s\S]*?\]/);
    if (!toolMatch) continue;

    // For MCP tags, use bracket-aware extraction to get the full tag
    let toolTag: string;
    if (toolMatch[1] === 'MCP') {
      const mcpStart = content.indexOf('[MCP:');
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
