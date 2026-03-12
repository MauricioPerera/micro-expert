import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  MICRO_EXPERT_HOME, MODELS_DIR, BIN_DIR, CONFIG_FILE,
  type MicroExpertConfig,
} from '../config.js';

interface SetupOptions {
  light?: boolean;
  modelPath?: string;
  llamaServerPath?: string;
  skipModel?: boolean;
  skipServer?: boolean;
}

/** Model presets */
const MODELS = {
  default: {
    name: 'Qwen3.5-0.8B-Q4_K_M',
    url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf',
    size: '533 MB',
    filename: 'Qwen3.5-0.8B-Q4_K_M.gguf',
  },
  light: {
    name: 'gemma-3-270m-it-Q4_K_M',
    url: 'https://huggingface.co/ggml-org/gemma-3-270m-GGUF/resolve/main/gemma-3-270m-Q4_K_M.gguf',
    size: '~170 MB',
    filename: 'gemma-3-270m-Q4_K_M.gguf',
  },
};

/** Detect platform for llama-server binary */
function getPlatformInfo(): { os: string; arch: string; ext: string } {
  const os = process.platform === 'win32' ? 'windows'
    : process.platform === 'darwin' ? 'macos'
    : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const ext = process.platform === 'win32' ? '.exe' : '';
  return { os, arch, ext };
}

/**
 * Run the setup wizard: create directories, download model and llama-server.
 */
export async function runSetup(options: SetupOptions = {}): Promise<void> {
  console.log('\n🔧 MicroExpert Setup\n');

  // 1. Create directories
  for (const dir of [MICRO_EXPERT_HOME, MODELS_DIR, BIN_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
  console.log(`✓ Created ${MICRO_EXPERT_HOME}`);

  const config: Partial<MicroExpertConfig> = {};
  const { ext } = getPlatformInfo();

  // 2. llama-server
  const serverPath = options.llamaServerPath ?? join(BIN_DIR, `llama-server${ext}`);
  config.llamaServerPath = serverPath;

  if (options.skipServer) {
    console.log('⏭ Skipping llama-server download');
  } else if (existsSync(serverPath)) {
    console.log(`✓ llama-server already exists at ${serverPath}`);
  } else if (options.llamaServerPath) {
    console.log(`✓ Using provided llama-server: ${serverPath}`);
  } else {
    console.log('\n⚠ llama-server binary not found.');
    console.log('  Please download it manually from:');
    console.log('  https://github.com/ggerganov/llama.cpp/releases');
    console.log(`  And place it at: ${serverPath}`);
    console.log('  Or pass --llama-server-path /path/to/llama-server\n');
  }

  // 3. Model
  const preset = options.light ? MODELS.light : MODELS.default;
  const modelPath = options.modelPath ?? join(MODELS_DIR, preset.filename);
  config.modelPath = modelPath;

  if (options.skipModel) {
    console.log('⏭ Skipping model download');
  } else if (existsSync(modelPath)) {
    console.log(`✓ Model already exists at ${modelPath}`);
  } else if (options.modelPath && existsSync(options.modelPath)) {
    console.log(`✓ Using provided model: ${modelPath}`);
  } else {
    console.log(`\n📥 Downloading ${preset.name} (${preset.size})...`);
    console.log(`   From: ${preset.url}`);
    console.log(`   To:   ${modelPath}\n`);

    try {
      await downloadFile(preset.url, modelPath);
      console.log(`✓ Model downloaded: ${modelPath}`);
    } catch (e) {
      console.error(`✗ Download failed: ${(e as Error).message}`);
      console.log(`  You can download manually from: ${preset.url}`);
      console.log(`  And place it at: ${modelPath}`);
    }
  }

  // 4. Save config
  const existing = existsSync(CONFIG_FILE)
    ? JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
    : {};

  const merged = { ...existing, ...config };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  console.log(`\n✓ Config saved to ${CONFIG_FILE}`);

  // 5. Summary
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Setup complete!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Model:        ${config.modelPath}`);
  console.log(`  llama-server: ${config.llamaServerPath}`);
  console.log(`  Memory:       ${join(MICRO_EXPERT_HOME, 'memory')}`);
  console.log(`\n  Run: micro-expert serve`);
  console.log('');
}

/**
 * Download a file with progress indication.
 */
async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const totalBytes = parseInt(res.headers.get('content-length') ?? '0', 10);
  let downloadedBytes = 0;
  let lastPercent = -1;

  const body = res.body;
  if (!body) throw new Error('No response body');

  const fileStream = createWriteStream(dest);

  // Transform stream to track progress
  const progressStream = new ReadableStream({
    async start(controller) {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          downloadedBytes += value.length;
          controller.enqueue(value);

          if (totalBytes > 0) {
            const percent = Math.floor((downloadedBytes / totalBytes) * 100);
            if (percent !== lastPercent) {
              lastPercent = percent;
              const mb = (downloadedBytes / 1024 / 1024).toFixed(1);
              const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
              process.stdout.write(`\r   ${mb} MB / ${totalMb} MB (${percent}%)`);
            }
          }
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  await pipeline(
    Readable.fromWeb(progressStream as import('node:stream/web').ReadableStream),
    fileStream,
  );

  if (totalBytes > 0) {
    process.stdout.write('\n');
  }
}
