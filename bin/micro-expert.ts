#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig, configSummary, type MicroExpertConfig } from '../src/config.js';
import { MemoryProvider } from '../src/memory/provider.js';
import { InferenceManager } from '../src/inference/manager.js';
import { InferenceClient } from '../src/inference/client.js';
import { AgentLoop } from '../src/agent/loop.js';
import { ToolRegistry, registerBuiltinTools } from '../src/agent/tools.js';
import { McpClientManager } from '../src/mcp/index.js';
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

    const { memory, agent, inference, mcp } = await initComponents(config);

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
      mcp?.disconnectAll().catch(() => {});
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

    const { memory, agent, inference, mcp } = await initComponents(config);

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
          await mcp?.disconnectAll().catch(() => {});
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

    const { memory, agent, inference, mcp } = await initComponents(config);

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
      await mcp?.disconnectAll().catch(() => {});
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

// --- export-memories ---
program
  .command('export-memories')
  .description('Export all memories to a JSON file')
  .option('--userId <id>', 'User ID to export memories for')
  .option('--output <path>', 'Output file path (default: memories-<userId>.json)')
  .action(async (opts) => {
    const globalOpts = program.opts();
    const config = loadConfig({
      modelPath: globalOpts.model,
    });

    const userId = opts.userId ?? config.defaultUserId;
    const memory = new MemoryProvider(config);

    try {
      const exported = memory.exportMemories(userId);
      const outputPath = opts.output ?? `memories-${userId}.json`;

      const { writeFileSync } = await import('node:fs');
      writeFileSync(outputPath, JSON.stringify(exported, null, 2));

      console.log(`✅ Exported ${exported.count} memories to ${outputPath}`);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exitCode = 1;
    } finally {
      memory.dispose();
    }
  });

// --- import-memories ---
program
  .command('import-memories <file>')
  .description('Import memories from a JSON file')
  .option('--userId <id>', 'User ID to import memories for')
  .action(async (file, opts) => {
    const globalOpts = program.opts();
    const config = loadConfig({
      modelPath: globalOpts.model,
    });

    const userId = opts.userId ?? config.defaultUserId;
    const memory = new MemoryProvider(config);

    try {
      const { readFileSync } = await import('node:fs');
      const raw = readFileSync(file, 'utf-8');
      const data = JSON.parse(raw);

      const result = memory.importMemories(userId, data);

      console.log(`✅ Import complete:`);
      console.log(`   Imported: ${result.imported}`);
      if (result.errors > 0) {
        console.log(`   Errors: ${result.errors}`);
      }
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exitCode = 1;
    } finally {
      memory.dispose();
    }
  });

// --- mcp-status ---
program
  .command('mcp-status')
  .description('Show configured MCP servers and their available tools')
  .action(async () => {
    const globalOpts = program.opts();
    const config = loadConfig({
      modelPath: globalOpts.model,
    });

    const serverNames = Object.keys(config.mcpServers);

    if (serverNames.length === 0) {
      console.log('\nNo MCP servers configured.');
      console.log('Add servers to ~/.micro-expert/config.json under "mcpServers".\n');
      console.log('Example:');
      console.log('  {');
      console.log('    "mcpServers": {');
      console.log('      "filesystem": {');
      console.log('        "command": "npx",');
      console.log('        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]');
      console.log('      }');
      console.log('    }');
      console.log('  }\n');
      return;
    }

    console.log(`\n🔌 MCP Servers (${serverNames.length}):\n`);

    const mcp = new McpClientManager();
    try {
      await mcp.connectAll(config.mcpServers);
      const tools = mcp.listTools();

      for (const name of serverNames) {
        const serverTools = tools.filter(t => t.serverName === name);
        console.log(`  ${name}: ${serverTools.length} tool(s)`);
        for (const t of serverTools) {
          console.log(`    - ${t.qualifiedName}: ${t.description}`);
        }
      }

      console.log(`\n  Total: ${tools.length} tool(s)\n`);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exitCode = 1;
    } finally {
      await mcp.disconnectAll();
    }
  });

// --- Parse and run ---
program.parse();

// --- Helpers ---

async function initComponents(config: MicroExpertConfig) {
  const memory = new MemoryProvider(config);
  const inference = new InferenceManager(config);
  const client = new InferenceClient(inference);
  const tools = new ToolRegistry();
  registerBuiltinTools(tools, memory);

  // MCP client setup — connect to configured MCP servers
  let mcp: McpClientManager | undefined;
  const serverNames = Object.keys(config.mcpServers);
  if (serverNames.length > 0) {
    mcp = new McpClientManager();
    await mcp.connectAll(config.mcpServers);
    const mcpTools = mcp.listTools();
    if (mcpTools.length > 0) {
      console.log(`[micro-expert] MCP: connected ${mcpTools.length} tool(s) from ${serverNames.length} server(s)`);
    }
  }

  const agent = new AgentLoop(client, memory, config, tools, mcp);

  return { memory, inference, client, tools, agent, mcp };
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? 'start'
    : process.platform === 'darwin' ? 'open'
    : 'xdg-open';

  import('node:child_process').then(({ exec }) => {
    exec(`${cmd} ${url}`);
  }).catch(() => { /* Ignore if browser can't open */ });
}
