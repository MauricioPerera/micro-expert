import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { McpServerConfig } from './mcp/index.js';

/** Base directory for all MicroExpert user data */
export const MICRO_EXPERT_HOME = join(homedir(), '.micro-expert');
export const MEMORY_DIR = join(MICRO_EXPERT_HOME, 'memory');
export const MODELS_DIR = join(MICRO_EXPERT_HOME, 'models');
export const BIN_DIR = join(MICRO_EXPERT_HOME, 'bin');
export const CONFIG_FILE = join(MICRO_EXPERT_HOME, 'config.json');

export interface MicroExpertConfig {
  /** Path to the GGUF model file */
  modelPath: string;
  /** Path to llama-server binary */
  llamaServerPath: string;
  /** HTTP server port for the UI */
  port: number;
  /** HTTP server host */
  host: string;
  /** Agent ID for RepoMemory scoping */
  agentId: string;
  /** Default user ID when not specified */
  defaultUserId: string;
  /** Seconds of inactivity before stopping llama-server (0 = never) */
  idleTimeout: number;
  /** Default max tokens for generation */
  maxTokens: number;
  /** Default temperature */
  temperature: number;
  /** Default top_p */
  topP: number;
  /** Max items to recall from memory */
  recallLimit: number;
  /** Max chars for CTT context injection */
  contextBudget: number;
  /** Enable thinking mode (Qwen3.5) — off by default for stability */
  thinkingMode: boolean;
  /** Internal port for llama-server (auto-assigned if 0) */
  llamaServerPort: number;
  /** Context size for llama-server */
  contextSize: number;
  /** Number of CPU threads for inference (0 = auto) */
  threads: number;
  /** Recall template: default, technical, support, rag_focused */
  recallTemplate: string;
  /** MCP server configurations (same format as claude_desktop_config.json) */
  mcpServers: Record<string, McpServerConfig>;
  /** Maximum number of MCP tools to expose to the model (sub-1B models need short prompts) */
  mcpMaxTools: number;
  /** Path to mmproj GGUF file for vision support (empty = auto-detect, 'none' = disabled) */
  mmprojPath: string;
  /** Telegram bot configuration */
  telegram?: {
    /** Bot token from @BotFather */
    botToken: string;
    /** Allowed Telegram user IDs (empty = allow all) */
    allowedUsers?: number[];
  };
}

const DEFAULTS: MicroExpertConfig = {
  modelPath: join(MODELS_DIR, 'model.gguf'),
  llamaServerPath: join(BIN_DIR, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'),
  port: 3333,
  host: '127.0.0.1',
  agentId: 'micro-expert',
  defaultUserId: 'local',
  idleTimeout: 300,
  maxTokens: 512,
  temperature: 0.7,
  topP: 0.9,
  recallLimit: 5,
  contextBudget: 4096,
  thinkingMode: false,
  llamaServerPort: 0,
  contextSize: 4096,
  threads: 0,
  recallTemplate: 'default',
  mcpServers: {},
  mcpMaxTools: 10,
  mmprojPath: '',
};

/** Environment variable mapping (MICRO_EXPERT_ prefix) */
const ENV_MAP: Partial<Record<keyof MicroExpertConfig, string>> = {
  modelPath: 'MICRO_EXPERT_MODEL_PATH',
  llamaServerPath: 'MICRO_EXPERT_LLAMA_SERVER_PATH',
  port: 'MICRO_EXPERT_PORT',
  host: 'MICRO_EXPERT_HOST',
  agentId: 'MICRO_EXPERT_AGENT_ID',
  defaultUserId: 'MICRO_EXPERT_USER_ID',
  idleTimeout: 'MICRO_EXPERT_IDLE_TIMEOUT',
  maxTokens: 'MICRO_EXPERT_MAX_TOKENS',
  temperature: 'MICRO_EXPERT_TEMPERATURE',
  recallLimit: 'MICRO_EXPERT_RECALL_LIMIT',
  contextBudget: 'MICRO_EXPERT_CONTEXT_BUDGET',
  thinkingMode: 'MICRO_EXPERT_THINKING',
  contextSize: 'MICRO_EXPERT_CONTEXT_SIZE',
  threads: 'MICRO_EXPERT_THREADS',
  recallTemplate: 'MICRO_EXPERT_RECALL_TEMPLATE',
  mmprojPath: 'MICRO_EXPERT_MMPROJ_PATH',
};

/** Load config file if it exists */
function loadConfigFile(): Partial<MicroExpertConfig> {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as Partial<MicroExpertConfig>;
  } catch {
    console.error(`[micro-expert] Warning: Could not parse ${CONFIG_FILE}`);
    return {};
  }
}

/** Read environment variables into a partial config */
function loadEnvVars(): Partial<MicroExpertConfig> {
  const result: Partial<MicroExpertConfig> = {};

  for (const [key, envName] of Object.entries(ENV_MAP)) {
    const val = process.env[envName!];
    if (val === undefined) continue;

    const k = key as keyof MicroExpertConfig;
    const defaultVal = DEFAULTS[k];

    if (typeof defaultVal === 'number') {
      const num = Number(val);
      if (!isNaN(num)) (result as Record<string, unknown>)[k] = num;
    } else if (typeof defaultVal === 'boolean') {
      (result as Record<string, unknown>)[k] = val === '1' || val === 'true';
    } else {
      (result as Record<string, unknown>)[k] = val;
    }
  }

  // Handle nested telegram config from env vars
  const telegramToken = process.env.MICRO_EXPERT_TELEGRAM_TOKEN;
  const telegramUsers = process.env.MICRO_EXPERT_TELEGRAM_USERS;
  if (telegramToken) {
    (result as Record<string, unknown>).telegram = {
      botToken: telegramToken,
      allowedUsers: telegramUsers
        ? telegramUsers.split(',').map(id => parseInt(id.trim(), 10)).filter(n => !isNaN(n))
        : undefined,
    };
  }

  return result;
}

/**
 * Build final config by merging: defaults < config file < env vars < CLI overrides.
 */
export function loadConfig(cliOverrides: Partial<MicroExpertConfig> = {}): MicroExpertConfig {
  const fileConfig = loadConfigFile();
  const envConfig = loadEnvVars();

  const config = {
    ...DEFAULTS,
    ...fileConfig,
    ...envConfig,
    ...stripUndefined(cliOverrides),
  };

  // Auto-detect mmproj file next to the model if not explicitly set
  if (!config.mmprojPath) {
    config.mmprojPath = detectMmproj(config.modelPath);
  }

  // Validate ranges
  if (config.port < 1 || config.port > 65535) {
    console.warn(`[micro-expert] Invalid port ${config.port}, using default ${DEFAULTS.port}`);
    config.port = DEFAULTS.port;
  }
  if (config.temperature < 0 || config.temperature > 2) {
    console.warn(`[micro-expert] Invalid temperature ${config.temperature}, using default ${DEFAULTS.temperature}`);
    config.temperature = DEFAULTS.temperature;
  }
  if (config.threads < 0) {
    console.warn(`[micro-expert] Invalid threads ${config.threads}, using default ${DEFAULTS.threads}`);
    config.threads = DEFAULTS.threads;
  }
  if (config.maxTokens < 1) {
    console.warn(`[micro-expert] Invalid maxTokens ${config.maxTokens}, using default ${DEFAULTS.maxTokens}`);
    config.maxTokens = DEFAULTS.maxTokens;
  }
  if (config.contextSize < 128) {
    console.warn(`[micro-expert] Invalid contextSize ${config.contextSize}, using default ${DEFAULTS.contextSize}`);
    config.contextSize = DEFAULTS.contextSize;
  }

  return config;
}

/** Remove undefined values so they don't override lower-priority sources */
function stripUndefined(obj: Partial<MicroExpertConfig>): Partial<MicroExpertConfig> {
  const result: Partial<MicroExpertConfig> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      (result as Record<string, unknown>)[k] = v;
    }
  }
  return result;
}

/**
 * Auto-detect an mmproj file in the same directory as the model.
 * Looks for files matching mmproj*.gguf, prefers F16 over F32/BF16.
 */
function detectMmproj(modelPath: string): string {
  try {
    const dir = dirname(modelPath);
    if (!existsSync(dir)) return '';
    const files = readdirSync(dir).filter(f => /^mmproj.*\.gguf$/i.test(f));
    if (files.length === 0) return '';
    // Prefer F16, then BF16, then F32, then first match
    const preferred = files.find(f => f.includes('F16'))
      || files.find(f => f.includes('BF16'))
      || files.find(f => f.includes('F32'))
      || files[0];
    const fullPath = join(dir, preferred);
    console.log(`[micro-expert] Auto-detected mmproj: ${fullPath}`);
    return fullPath;
  } catch {
    return '';
  }
}

/** Get a human-readable summary of the current config */
export function configSummary(config: MicroExpertConfig): string {
  const modelExists = existsSync(config.modelPath);
  const serverExists = existsSync(config.llamaServerPath);

  return [
    `Model:         ${config.modelPath} ${modelExists ? '✓' : '✗ not found'}`,
    `llama-server:  ${config.llamaServerPath} ${serverExists ? '✓' : '✗ not found'}`,
    `Server:        http://${config.host}:${config.port}`,
    `Agent ID:      ${config.agentId}`,
    `User ID:       ${config.defaultUserId}`,
    `Idle timeout:  ${config.idleTimeout}s`,
    `Max tokens:    ${config.maxTokens}`,
    `Temperature:   ${config.temperature}`,
    `Context size:  ${config.contextSize}`,
    `Recall limit:  ${config.recallLimit}`,
    `Recall template: ${config.recallTemplate}`,
    `Thinking mode: ${config.thinkingMode ? 'on' : 'off'}`,
    `Vision:        ${config.mmprojPath && config.mmprojPath !== 'none' ? config.mmprojPath + (existsSync(config.mmprojPath) ? ' ✓' : ' ✗ not found') : 'off'}`,
    `MCP servers:   ${Object.keys(config.mcpServers).length > 0 ? Object.keys(config.mcpServers).join(', ') : 'none'}`,
    `Memory store:  ${MEMORY_DIR}`,
  ].join('\n');
}
