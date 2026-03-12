import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('Config', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore environment
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('MICRO_EXPERT_')) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('should return defaults when no overrides', () => {
    const config = loadConfig();
    expect(config.port).toBe(3333);
    expect(config.host).toBe('127.0.0.1');
    expect(config.agentId).toBe('micro-expert');
    expect(config.defaultUserId).toBe('local');
    expect(config.maxTokens).toBe(512);
    expect(config.temperature).toBe(0.7);
    expect(config.idleTimeout).toBe(300);
    expect(config.thinkingMode).toBe(false);
    expect(config.recallTemplate).toBe('default');
  });

  it('should override with CLI args', () => {
    const config = loadConfig({ port: 9999, maxTokens: 1024 });
    expect(config.port).toBe(9999);
    expect(config.maxTokens).toBe(1024);
    // Non-overridden values stay default
    expect(config.host).toBe('127.0.0.1');
  });

  it('should read environment variables', () => {
    process.env.MICRO_EXPERT_PORT = '4444';
    process.env.MICRO_EXPERT_MAX_TOKENS = '2048';
    process.env.MICRO_EXPERT_THINKING = 'true';

    const config = loadConfig();
    expect(config.port).toBe(4444);
    expect(config.maxTokens).toBe(2048);
    expect(config.thinkingMode).toBe(true);
  });

  it('should prioritize CLI over env vars', () => {
    process.env.MICRO_EXPERT_PORT = '4444';
    const config = loadConfig({ port: 5555 });
    expect(config.port).toBe(5555);
  });

  it('should ignore undefined CLI overrides', () => {
    const config = loadConfig({ port: undefined as unknown as number });
    expect(config.port).toBe(3333); // default
  });
});
