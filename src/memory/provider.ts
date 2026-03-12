import { mkdirSync } from 'node:fs';
import { RepoMemory } from '@rckflr/repomemory';
import type { MicroExpertConfig } from '../config.js';
import { MEMORY_DIR } from '../config.js';

export interface ChatMessage {
  role: string;
  content: string;
}

export interface RecallResult {
  formatted: string;
  totalItems: number;
  estimatedChars: number;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  preview: string;
}

/**
 * Thin wrapper over RepoMemory embedded instance.
 * All memory operations go through here — no HTTP, no separate server.
 */
export class MemoryProvider {
  private repo: RepoMemory;
  private readonly agentId: string;
  private readonly recallLimit: number;
  private readonly contextBudget: number;
  private readonly recallTemplate: string;

  constructor(config: MicroExpertConfig) {
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
    });
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

    return {
      formatted: result.formatted,
      totalItems: result.totalItems,
      estimatedChars: result.estimatedChars,
    };
  }

  /**
   * Save a conversation turn as a session.
   */
  saveSession(userId: string, messages: ChatMessage[]): string | null {
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
  getSession(sessionId: string): { id: string; content: string; messages?: ChatMessage[]; createdAt: string } | null {
    try {
      const session = this.repo.sessions.get(sessionId);
      if (!session) return null;
      return {
        id: session.id,
        content: session.content,
        messages: session.messages as ChatMessage[] | undefined,
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
   * Clean up resources.
   */
  dispose(): void {
    this.repo.dispose();
  }
}
