import https from 'node:https';
import type { AgentLoop } from '../agent/loop.js';
import type { ChatMessage } from '../inference/client.js';

const API_BASE = 'https://api.telegram.org';
const MAX_MSG_LEN = 4096;
const MAX_HISTORY = 10;
const POLL_TIMEOUT = 30;
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30000;

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; width: number; height: number }>;
}

/**
 * Telegram bot that connects MicroExpert to Telegram via long polling.
 * Uses node:https directly — no external dependencies.
 */
export class TelegramBot {
  private readonly agent: AgentLoop;
  private readonly token: string;
  private readonly allowedUsers: Set<number> | null;
  private readonly histories = new Map<number, ChatMessage[]>();
  private running = false;
  private offset = 0;

  constructor(agent: AgentLoop, token: string, allowedUsers?: number[]) {
    this.agent = agent;
    this.token = token;
    this.allowedUsers = allowedUsers && allowedUsers.length > 0
      ? new Set(allowedUsers)
      : null;
  }

  async start(): Promise<void> {
    // Verify token by calling getMe
    const me = await this.api('getMe');
    if (!me.ok) {
      throw new Error(`Invalid Telegram bot token: ${me.description ?? 'unknown error'}`);
    }
    const result = me.result as Record<string, unknown>;
    console.log(`[micro-expert] Telegram bot @${result.username} connected`);
    this.running = true;
    this.pollLoop();
  }

  stop(): void {
    this.running = false;
  }

  private async pollLoop(): Promise<void> {
    let retryMs = RETRY_BASE_MS;

    while (this.running) {
      try {
        const data = await this.api('getUpdates', {
          offset: this.offset,
          timeout: POLL_TIMEOUT,
          allowed_updates: ['message'],
        });

        if (!data.ok) {
          console.error(`[micro-expert] Telegram getUpdates error: ${data.description}`);
          await sleep(retryMs);
          retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
          continue;
        }

        retryMs = RETRY_BASE_MS; // Reset on success

        for (const update of data.result as TelegramUpdate[]) {
          this.offset = update.update_id + 1;
          if (update.message) {
            // Don't await — process in background so polling continues
            this.handleMessage(update.message).catch(e => {
              console.error(`[micro-expert] Telegram message handler error:`, e);
            });
          }
        }
      } catch (e) {
        if (!this.running) return;
        console.error(`[micro-expert] Telegram poll error: ${(e as Error).message}`);
        await sleep(retryMs);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    }
  }

  private async handleMessage(msg: TelegramMessage): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!userId) return;

    // Check allowlist
    if (this.allowedUsers && !this.allowedUsers.has(userId)) {
      await this.sendText(chatId, 'Sorry, you are not authorized to use this bot.');
      return;
    }

    let text = msg.text ?? msg.caption ?? '';
    let image: string | undefined;

    // Handle photos — download and convert to base64
    if (msg.photo && msg.photo.length > 0) {
      try {
        // Take the largest photo (last in array)
        const photo = msg.photo[msg.photo.length - 1];
        const fileData = await this.downloadPhoto(photo.file_id);
        image = `data:image/jpeg;base64,${fileData.toString('base64')}`;
        if (!text) text = 'What is in this image?';
      } catch (e) {
        console.error(`[micro-expert] Photo download failed: ${(e as Error).message}`);
        await this.sendText(chatId, 'Sorry, I could not process the image.');
        return;
      }
    }

    if (!text) return; // Ignore stickers, voice, etc.

    // Send "typing" indicator
    this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

    // Get or create conversation history for this user
    const history = this.histories.get(userId) ?? [];

    try {
      const result = await this.agent.run({
        message: text,
        userId: String(userId),
        history,
        image,
      });

      // Update history
      history.push({ role: 'user', content: text });
      history.push({ role: 'assistant', content: result.content });

      // Trim history to last N turns
      while (history.length > MAX_HISTORY * 2) {
        history.shift();
      }
      this.histories.set(userId, history);

      // Send response (split if too long)
      await this.sendLongText(chatId, result.content);
    } catch (e) {
      console.error(`[micro-expert] Agent error for user ${userId}: ${(e as Error).message}`);
      await this.sendText(chatId, 'Sorry, I encountered an error. Please try again.');
    }
  }

  private async downloadPhoto(fileId: string): Promise<Buffer> {
    const fileInfo = await this.api('getFile', { file_id: fileId });
    const fileResult = fileInfo.result as Record<string, unknown> | undefined;
    if (!fileInfo.ok || !fileResult?.file_path) {
      throw new Error('Could not get file path from Telegram');
    }
    const url = `${API_BASE}/file/bot${this.token}/${fileResult.file_path}`;
    return downloadBuffer(url);
  }

  private async sendText(chatId: number, text: string): Promise<void> {
    await this.api('sendMessage', {
      chat_id: chatId,
      text,
    });
  }

  private async sendLongText(chatId: number, text: string): Promise<void> {
    const chunks = splitMessage(text, MAX_MSG_LEN);
    for (const chunk of chunks) {
      await this.api('sendMessage', {
        chat_id: chatId,
        text: chunk,
      });
    }
  }

  /** Call the Telegram Bot API */
  private api(method: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : '';
      const req = https.request(
        {
          hostname: 'api.telegram.org',
          path: `/bot${this.token}/${method}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: (POLL_TIMEOUT + 10) * 1000, // Slightly longer than poll timeout
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error(`Invalid JSON from Telegram: ${data.slice(0, 200)}`));
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Telegram API timeout')); });
      req.write(payload);
      req.end();
    });
  }
}

/** Download a URL into a Buffer */
function downloadBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Split a message into chunks at newline boundaries */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen; // No newline found — hard split
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
