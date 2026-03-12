#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig, configSummary, type MicroExpertConfig } from '../src/config.js';
import { MemoryProvider } from '../src/memory/provider.js';
import { InferenceManager } from '../src/inference/manager.js';
import { InferenceClient } from '../src/inference/client.js';
import { AgentLoop } from '../src/agent/loop.js';
import { ToolRegistry, registerBuiltinTools } from '../src/agent/tools.js';
import { createServer } from '../src/server/http.js';
import { runSetup } from '../src/setup/wizard.js';

const program = new Command();

program
  .name('micro-expert')
  .description('Local AI agent powered by sub-1B models and Context-Time Training')
  .version('0.1.0');

// Global options
program
  .option('--model <path>', 'Path to GGUF model file')
  .option('--port <number>', 'HTTP server port', parseInt)
  .option('--light', 'Use lightweight model (Gemma 270M)');

// --- setup ---
program
  .command('setup')
  .description('Download model and configure MicroExpert')
  .option('--light', 'Use lightweight model (Gemma 3 270M instead of Qwen3.5 0.8B)')
  .option('--model-path <path>', 'Path to existing GGUF model')
  .option('--llama-server-path <path>', 'Path to llama-server binary')
  .option('--skip-model', 'Skip model download')
  .option('--skip-server', 'Skip llama-server download')
  .action(async (opts) => {
    await runSetup({
      light: opts.light || program.opts().light,
      modelPath: opts.modelPath,
      llamaServerPath: opts.llamaServerPath,
      skipModel: opts.skipModel,
      skipServer: opts.skipServer,
    });
  });

// --- serve ---
program
  .command('serve')
  .description('Start the MicroExpert server with web UI')
  .option('--no-open', 'Do not open browser automatically')
  .action(async (opts) => {
    const globalOpts = program.opts();
    const config = loadConfig({
      modelPath: globalOpts.model,
      port: globalOpts.port,
    });

    const { memory, agent, inference } = initComponents(config);

    const server = createServer({ agent, memory, inference, config });

    server.listen(config.port, config.host, () => {
      console.log(`\n🧠 MicroExpert v0.1.0`);
      console.log(`   http://${config.host}:${config.port}\n`);

      if (opts.open !== false) {
        openBrowser(`http://127.0.0.1:${config.port}`);
      }
    });

    // Graceful shutdown
    const shutdown = () => {
      console.log('\n[micro-expert] Shutting down...');
      inference.stop();
      memory.dispose();
      server.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// --- chat ---
program
  .command('chat')
  .description('Interactive chat in the terminal')
  .action(async () => {
    const globalOpts = program.opts();
    const config = loadConfig({
      modelPath: globalOpts.model,
    });

    const { memory, agent, inference } = initComponents(config);

    console.log('🧠 MicroExpert Chat (type "exit" to quit)\n');

    const readline = await import('node:readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = () => {
      rl.question('You: ', async (input) => {
        const text = input.trim();
        if (!text || text === 'exit' || text === 'quit') {
          inference.stop();
          memory.dispose();
          rl.close();
          return;
        }

        process.stdout.write('MicroExpert: ');

        try {
          for await (const delta of agent.runStream({
            message: text,
            userId: config.defaultUserId,
          })) {
            process.stdout.write(delta.content);
          }
        } catch (e) {
          process.stdout.write(`[Error: ${(e as Error).message}]`);
        }

        process.stdout.write('\n\n');
        prompt();
      });
    };

    prompt();
  });

// --- ask ---
program
  .command('ask <question>')
  .description('Ask a single question and get an answer')
  .action(async (question) => {
    const globalOpts = program.opts();
    const config = loadConfig({
      modelPath: globalOpts.model,
    });

    const { memory, agent, inference } = initComponents(config);

    try {
      for await (const delta of agent.runStream({
        message: question,
        userId: config.defaultUserId,
      })) {
        process.stdout.write(delta.content);
      }
      process.stdout.write('\n');
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exitCode = 1;
    } finally {
      inference.stop();
      memory.dispose();
    }
  });

// --- status ---
program
  .command('status')
  .description('Show current configuration and status')
  .action(async () => {
    const globalOpts = program.opts();
    const config = loadConfig({
      modelPath: globalOpts.model,
      port: globalOpts.port,
    });

    console.log('\n🧠 MicroExpert Status\n');
    console.log(configSummary(config));

    // Check memory
    try {
      const memory = new MemoryProvider(config);
      const stats = memory.stats();
      console.log(`\nMemory stats:`);
      for (const [key, val] of Object.entries(stats)) {
        console.log(`  ${key}: ${val}`);
      }
      memory.dispose();
    } catch (e) {
      console.log(`\nMemory: ✗ ${(e as Error).message}`);
    }

    console.log('');
  });

// --- Parse and run ---
program.parse();

// --- Helpers ---

function initComponents(config: MicroExpertConfig) {
  const memory = new MemoryProvider(config);
  const inference = new InferenceManager(config);
  const client = new InferenceClient(inference);
  const tools = new ToolRegistry();
  registerBuiltinTools(tools, memory);
  const agent = new AgentLoop(client, memory, config);

  return { memory, inference, client, tools, agent };
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? 'start'
    : process.platform === 'darwin' ? 'open'
    : 'xdg-open';

  import('node:child_process').then(({ exec }) => {
    exec(`${cmd} ${url}`);
  }).catch(() => { /* Ignore if browser can't open */ });
}
