#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig, configSummary, type MicroExpertConfig } from '../src/config.js';
import { MemoryProvider } from '../src/memory/provider.js';
import { InferenceManager } from '../src/inference/manager.js';
import { InferenceClient } from '../src/inference/client.js';
import { AgentLoop } from '../src/agent/loop.js';
import { McpClientManager } from '../src/mcp/index.js';
import { LlamaAiProvider } from '../src/memory/ai-provider.js';
import { generateSkillSeeds } from '../src/memory/seed.js';
import { createServer } from '../src/server/http.js';
import { runSetup } from '../src/setup/wizard.js';
import { TelegramBot } from '../src/telegram/bot.js';

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
  .description('Export memories to a JSON file (v1 flat or v2 pack format)')
  .option('--userId <id>', 'User ID to export memories for')
  .option('--output <path>', 'Output file path (default: memories-<userId>.json)')
  .option('--pack-name <name>', 'Pack name (enables v2 format for catalog publishing)')
  .option('--pack-desc <desc>', 'Pack description')
  .option('--pack-author <author>', 'Pack author')
  .option('--pack-version <ver>', 'Pack version (e.g., 1.0.0)')
  .option('--pack-url <url>', 'Pack source URL')
  .option('--pack-models <models>', 'Compatible models (comma-separated, e.g., "qwen3.5-0.8b,qwen3.5-2b")')
  .option('--pack-tags <tags>', 'Pack tags for catalog search (comma-separated)')
  .option('--filter <query>', 'Export only memories matching this search query (e.g., "n8n workflow")')
  .option('--tags <tags>', 'Export only memories with these tags (comma-separated, e.g., "n8n,mcp")')
  .action(async (opts) => {
    const globalOpts = program.opts();
    const config = loadConfig({
      modelPath: globalOpts.model,
    });

    const userId = opts.userId ?? config.defaultUserId;
    const memory = new MemoryProvider(config);

    try {
      // Build pack metadata if any pack option is provided
      const hasPack = opts.packName || opts.packDesc || opts.packAuthor;
      const packMeta = hasPack ? {
        name: opts.packName ?? 'Unnamed Pack',
        description: opts.packDesc ?? '',
        author: opts.packAuthor,
        packVersion: opts.packVersion,
        url: opts.packUrl,
        models: opts.packModels?.split(',').map((m: string) => m.trim()),
        packTags: opts.packTags?.split(',').map((t: string) => t.trim()),
      } : undefined;

      // Build filter if query or tags are provided
      const hasFilter = opts.filter || opts.tags;
      const filter = hasFilter ? {
        query: opts.filter,
        tags: opts.tags?.split(',').map((t: string) => t.trim()),
      } : undefined;

      const exported = memory.exportMemories(userId, packMeta, filter);
      const outputPath = opts.output ?? `memories-${userId}.json`;

      const { writeFileSync } = await import('node:fs');
      writeFileSync(outputPath, JSON.stringify(exported, null, 2));

      const skillCount = exported.skills?.length ?? 0;
      const memCount = exported.memories.length;
      console.log(`✅ Exported ${exported.count} items (${memCount} memories, ${skillCount} skills) to ${outputPath}`);
      if (filter) {
        console.log(`   Filter: ${filter.query ? `query="${filter.query}"` : ''}${filter.tags ? ` tags=[${filter.tags.join(', ')}]` : ''}`);
      }
      if (exported.pack?.name) {
        console.log(`   Pack: "${exported.pack.name}" v${exported.pack.packVersion ?? '0.0.0'}`);
      }
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
  .description('Import memories from a JSON file (v1 or v2 format)')
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
      if (result.skills > 0) {
        console.log(`   Skills: ${result.skills}`);
      }
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

// --- install (download + import from URL) ---
program
  .command('install <source>')
  .description('Install a memory pack from a URL or local file')
  .option('--userId <id>', 'User ID to import for')
  .action(async (source, opts) => {
    const globalOpts = program.opts();
    const config = loadConfig({
      modelPath: globalOpts.model,
    });

    const userId = opts.userId ?? config.defaultUserId;
    const memory = new MemoryProvider(config);

    try {
      let raw: string;

      if (source.startsWith('http://') || source.startsWith('https://')) {
        // Download from URL (supports GitHub raw URLs)
        console.log(`📦 Downloading pack from ${source}...`);
        const res = await fetch(source, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        raw = await res.text();
      } else {
        // Local file
        const { readFileSync } = await import('node:fs');
        raw = readFileSync(source, 'utf-8');
      }

      const data = JSON.parse(raw);
      const result = memory.importMemories(userId, data);

      const packName = data.pack?.name ?? source;
      console.log(`✅ Installed "${packName}":`);
      console.log(`   Imported: ${result.imported}`);
      if (result.skills > 0) {
        console.log(`   Skills: ${result.skills}`);
      }
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

// --- mine (extract skills from stored sessions) ---
program
  .command('mine')
  .description('Mine stored sessions to extract skills and memories using the local model')
  .option('--userId <id>', 'User ID to mine sessions for')
  .option('--limit <n>', 'Max sessions to mine (default: 10)', '10')
  .action(async (opts) => {
    const globalOpts = program.opts();
    const config = loadConfig({
      modelPath: globalOpts.model,
    });

    const userId = opts.userId ?? config.defaultUserId;
    const limit = parseInt(opts.limit, 10) || 10;

    // Mining requires inference — start the model
    const inference = new InferenceManager(config);
    const client = new InferenceClient(inference);
    const aiProvider = new LlamaAiProvider(client);
    const memory = new MemoryProvider(config, aiProvider);

    try {
      await inference.start();

      // List sessions and mine un-mined ones
      const sessions = memory.getHistory(userId, 100);
      console.log(`Found ${sessions.length} session(s) for user "${userId}"`);

      let mined = 0;
      let totalMemories = 0;
      let totalSkills = 0;

      for (const session of sessions) {
        if (mined >= limit) break;

        try {
          console.log(`  Mining session ${session.id}...`);
          const result = await memory.mine(session.id);
          totalMemories += result.memories;
          totalSkills += result.skills;
          mined++;

          if (result.memories > 0 || result.skills > 0) {
            console.log(`    → ${result.memories} memories, ${result.skills} skills`);
          } else {
            console.log(`    → nothing extracted`);
          }
        } catch (e) {
          console.error(`    → error: ${(e as Error).message}`);
        }
      }

      console.log(`\n✅ Mined ${mined} session(s):`);
      console.log(`   Memories extracted: ${totalMemories}`);
      console.log(`   Skills extracted: ${totalSkills}`);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exitCode = 1;
    } finally {
      inference.stop();
      memory.dispose();
    }
  });

// --- seed (generate artificial experience from MCP tool metadata) ---
program
  .command('seed')
  .description('Generate skill memories from MCP tool metadata (artificial experience)')
  .option('--output <path>', 'Export generated seeds to a file instead of saving to memory')
  .option('--userId <id>', 'User ID to save seeds for')
  .option('--pack-name <name>', 'Pack name when exporting')
  .option('--dry-run', 'Show what would be generated without saving')
  .action(async (opts) => {
    const globalOpts = program.opts();
    const config = loadConfig({
      modelPath: globalOpts.model,
    });

    const serverNames = Object.keys(config.mcpServers);
    if (serverNames.length === 0) {
      console.log('No MCP servers configured. Add servers to ~/.micro-expert/config.json.');
      return;
    }

    // Connect to MCP servers to discover tools
    const mcp = new McpClientManager();
    try {
      await mcp.connectAll(config.mcpServers);
      const tools = mcp.listTools();

      if (tools.length === 0) {
        console.log('No tools found from MCP servers.');
        return;
      }

      console.log(`Found ${tools.length} tool(s) from ${serverNames.length} server(s)\n`);

      // Generate seeds
      const seeds = generateSkillSeeds(tools);
      console.log(`Generated ${seeds.length} skill seed(s)\n`);

      if (opts.dryRun) {
        // Dry run — just display
        for (const seed of seeds) {
          console.log(`  [${seed.category}] ${seed.content.slice(0, 120)}${seed.content.length > 120 ? '...' : ''}`);
        }
        return;
      }

      if (opts.output) {
        // Export as pack file
        const packData = {
          version: 2,
          count: seeds.length,
          pack: {
            name: opts.packName ?? `MCP Seeds — ${serverNames.join(', ')}`,
            description: `Auto-generated skill seeds from MCP tool metadata`,
            generatedAt: new Date().toISOString(),
          },
          memories: [] as unknown[],
          skills: seeds,
        };

        const { writeFileSync } = await import('node:fs');
        writeFileSync(opts.output, JSON.stringify(packData, null, 2));
        console.log(`✅ Exported ${seeds.length} seeds to ${opts.output}`);
      } else {
        // Save directly to memory
        const userId = opts.userId ?? config.defaultUserId;
        const memory = new MemoryProvider(config);

        try {
          let saved = 0;
          for (const seed of seeds) {
            memory.saveMemory(userId, seed.content, seed.category, seed.tags);
            saved++;
          }
          console.log(`✅ Saved ${saved} seed(s) to memory for user "${userId}"`);
        } finally {
          memory.dispose();
        }
      }
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exitCode = 1;
    } finally {
      await mcp.disconnectAll();
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

// --- telegram ---
program
  .command('telegram')
  .description('Start the Telegram bot (interact with MicroExpert via Telegram chat)')
  .option('--token <token>', 'Telegram bot token (overrides config)')
  .action(async (opts) => {
    const globalOpts = program.opts();
    const config = loadConfig({
      modelPath: globalOpts.model,
    });

    const token = opts.token ?? config.telegram?.botToken;
    if (!token) {
      console.error('Error: No Telegram bot token provided.');
      console.error('Options:');
      console.error('  --token <token>');
      console.error('  MICRO_EXPERT_TELEGRAM_TOKEN=<token>');
      console.error('  ~/.micro-expert/config.json: { "telegram": { "botToken": "..." } }');
      process.exitCode = 1;
      return;
    }

    const { memory, agent, inference, mcp } = await initComponents(config);
    const bot = new TelegramBot(agent, token, config.telegram?.allowedUsers);

    try {
      await bot.start();
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      inference.stop();
      memory.dispose();
      await mcp?.disconnectAll().catch(() => {});
      process.exitCode = 1;
      return;
    }

    // Graceful shutdown
    const shutdown = () => {
      console.log('\n[micro-expert] Shutting down Telegram bot...');
      bot.stop();
      mcp?.disconnectAll().catch(() => {});
      inference.stop();
      memory.dispose();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// --- Parse and run ---
program.parse();

// --- Helpers ---

async function initComponents(config: MicroExpertConfig) {
  const inference = new InferenceManager(config);
  const client = new InferenceClient(inference);

  // Create AI provider for auto-mining (uses the same llama-server)
  const aiProvider = new LlamaAiProvider(client);
  const memory = new MemoryProvider(config, aiProvider);
  if (memory.isMiningEnabled) {
    console.log('[micro-expert] Auto-mining enabled — skills will be extracted from sessions');
  }

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

  const agent = new AgentLoop(client, memory, config, mcp);

  return { memory, inference, client, agent, mcp };
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? 'start'
    : process.platform === 'darwin' ? 'open'
    : 'xdg-open';

  import('node:child_process').then(({ exec }) => {
    exec(`${cmd} ${url}`);
  }).catch(() => { /* Ignore if browser can't open */ });
}
