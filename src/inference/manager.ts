import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { MicroExpertConfig } from '../config.js';

/**
 * Manages the llama-server lifecycle: start, stop, health check, idle timeout.
 * The server is spawned as a child process and auto-stops after inactivity.
 */
export class InferenceManager {
  private process: ChildProcess | null = null;
  private _port = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private startPromise: Promise<number> | null = null;
  private readonly config: MicroExpertConfig;

  constructor(config: MicroExpertConfig) {
    this.config = config;
  }

  get port(): number {
    return this._port;
  }

  get isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  /**
   * Start llama-server if not already running.
   * Returns the port it's listening on.
   */
  async start(): Promise<number> {
    if (this.isRunning) {
      this.resetIdleTimer();
      return this._port;
    }

    if (this.startPromise) {
      // Another call is already starting the server — wait for it
      return this.startPromise;
    }

    this.startPromise = this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<number> {

    if (!existsSync(this.config.llamaServerPath)) {
      this.startPromise = null;
      throw new Error(
        `llama-server not found at ${this.config.llamaServerPath}. Run 'micro-expert setup' first.`
      );
    }

    if (!existsSync(this.config.modelPath)) {
      this.startPromise = null;
      throw new Error(
        `Model not found at ${this.config.modelPath}. Run 'micro-expert setup' first.`
      );
    }

    // Pick port: configured or random available
    this._port = this.config.llamaServerPort || await this.findFreePort();

    const args = [
      '--model', this.config.modelPath,
      '--port', String(this._port),
      '--ctx-size', String(this.config.contextSize),
      '--host', '127.0.0.1',
    ];

    if (this.config.threads > 0) {
      args.push('--threads', String(this.config.threads));
    }

    // Vision: pass mmproj if configured and file exists
    if (this.config.mmprojPath && this.config.mmprojPath !== 'none' && existsSync(this.config.mmprojPath)) {
      args.push('--mmproj', this.config.mmprojPath);
    }

    // Disable thinking mode by default for stability with small models
    if (!this.config.thinkingMode) {
      args.push('--jinja');
    }

    console.log(`[micro-expert] Starting llama-server on port ${this._port}...`);

    this.process = spawn(this.config.llamaServerPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.on('exit', (code) => {
      console.log(`[micro-expert] llama-server exited with code ${code}`);
      this.process = null;
      this.startPromise = null;
      this.clearIdleTimer();
    });

    // Capture stderr for error reporting
    this.process.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line && !line.includes('slot') && !line.includes('sampling')) {
        // Only log meaningful errors, not per-token noise
        if (line.includes('error') || line.includes('Error') || line.includes('fatal')) {
          console.error(`[llama-server] ${line}`);
        }
      }
    });

    try {
      await this.waitForHealth();
      console.log(`[micro-expert] llama-server ready on port ${this._port}`);
      this.startPromise = null;
      this.resetIdleTimer();
      return this._port;
    } catch (e) {
      this.startPromise = null;
      this.stop();
      throw e;
    }
  }

  /**
   * Stop llama-server gracefully.
   */
  stop(): void {
    this.clearIdleTimer();
    if (!this.process) return;

    console.log('[micro-expert] Stopping llama-server...');

    const proc = this.process;
    this.process = null;

    // Try graceful shutdown first
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/f'], { stdio: 'ignore' });
    } else {
      proc.kill('SIGTERM');
      // Force kill after 5 seconds
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 5000);
    }
  }

  /**
   * Ensure server is running, start if needed.
   * Call this before every inference request.
   */
  async ensureRunning(): Promise<number> {
    this.resetIdleTimer();
    if (this.isRunning) return this._port;
    return this.start();
  }

  /**
   * Notify that a request was made (resets idle timer).
   */
  touch(): void {
    this.resetIdleTimer();
  }

  /**
   * Wait until llama-server responds to health check.
   */
  private async waitForHealth(timeoutMs = 120_000): Promise<number> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`http://127.0.0.1:${this._port}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) return this._port;
      } catch {
        // Not ready yet
      }
      await sleep(500);
    }
    throw new Error(`llama-server failed to start within ${timeoutMs / 1000}s`);
  }

  /**
   * Health check — is the server responding?
   */
  async healthCheck(): Promise<boolean> {
    if (!this.isRunning) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${this._port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    if (this.config.idleTimeout > 0) {
      this.idleTimer = setTimeout(() => {
        console.log(`[micro-expert] Idle timeout (${this.config.idleTimeout}s) — stopping llama-server`);
        this.stop();
      }, this.config.idleTimeout * 1000);
      // Don't keep process alive just for the timer
      this.idleTimer.unref();
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async findFreePort(): Promise<number> {
    const { createServer } = await import('node:net');
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          const port = addr.port;
          server.close(() => resolve(port));
        } else {
          server.close(() => reject(new Error('Failed to find free port')));
        }
      });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
