import { createServer as createHttpServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRoute, type RouteContext } from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Cached UI HTML */
let uiHtml: string | null = null;

function getUiHtml(): string {
  if (uiHtml) return uiHtml;
  try {
    uiHtml = readFileSync(join(__dirname, '..', 'ui', 'index.html'), 'utf-8');
  } catch {
    // Fallback: try from source location (dev mode)
    try {
      uiHtml = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'index.html'), 'utf-8');
    } catch {
      uiHtml = '<html><body><h1>MicroExpert</h1><p>UI not found. Run from project root.</p></body></html>';
    }
  }
  return uiHtml;
}

/**
 * Create the MicroExpert HTTP server.
 * Serves the UI on GET / and API routes on /v1/*, /health, /history.
 */
export function createServer(ctx: RouteContext): Server {
  const server = createHttpServer(async (req, res) => {
    // CORS headers
    const origin = req.headers.origin ?? '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Try API routes first
      const handled = await handleRoute(req, res, ctx);
      if (handled) return;

      // Serve UI on root
      if (req.url === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getUiHtml());
        return;
      }

      // Favicon (prevent 404 noise)
      if (req.url === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found' } }));
    } catch (e) {
      console.error('[micro-expert] Server error:', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Internal server error' } }));
      }
    }
  });

  return server;
}
