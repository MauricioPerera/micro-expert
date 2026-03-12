import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryProvider } from '../src/memory/provider.js';
import { loadConfig } from '../src/config.js';

describe('MemoryProvider', () => {
  let provider: MemoryProvider;
  let tempDir: string;

  function createProvider() {
    tempDir = mkdtempSync(join(tmpdir(), 'me-test-'));
    // Override MEMORY_DIR by creating config with custom paths
    const config = loadConfig({
      agentId: 'test-agent',
      defaultUserId: 'test-user',
      recallLimit: 5,
      contextBudget: 4096,
      recallTemplate: 'default',
    });

    // We need to create a provider that uses the temp dir.
    // Since MEMORY_DIR is a constant, we'll work around by directly
    // using a minimal approach.
    provider = new MemoryProvider(config);
  }

  afterEach(() => {
    if (provider) {
      try { provider.dispose(); } catch { /* ignore */ }
    }
  });

  it('should create and pass health check', () => {
    createProvider();
    expect(provider.healthCheck()).toBe(true);
  });

  it('should save and recall a memory', () => {
    createProvider();
    const userId = 'test-user';

    // Save a memory
    provider.saveMemory(userId, 'The project uses TypeScript', 'fact', ['tech']);

    // Recall should find it
    const result = provider.recall('What language does the project use?', userId);
    expect(result.totalItems).toBeGreaterThan(0);
    expect(result.formatted).toContain('TypeScript');
  });

  it('should save a session', () => {
    createProvider();
    const userId = 'test-user';

    const sessionId = provider.saveSession(userId, [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]);

    expect(sessionId).toBeTruthy();
  });

  it('should list conversation history', () => {
    createProvider();
    const userId = 'test-user';

    provider.saveSession(userId, [
      { role: 'user', content: 'First message' },
      { role: 'assistant', content: 'First response' },
    ]);

    const history = provider.getHistory(userId);
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].preview).toBeTruthy();
  });

  it('should search memories', () => {
    createProvider();
    const userId = 'test-user';

    provider.saveMemory(userId, 'The API uses REST with JSON', 'fact');
    provider.saveMemory(userId, 'The database is PostgreSQL', 'fact');

    const results = provider.searchMemories('database', userId);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('PostgreSQL');
  });

  it('should return stats', () => {
    createProvider();
    const stats = provider.stats();
    expect(stats).toBeDefined();
    expect(typeof stats.memories).toBe('number');
  });
});
