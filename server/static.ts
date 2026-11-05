/**
 * Serves the built web app (`dist/web`, produced by `vite build`) with SPA fallback for
 * client-side routes. In `tsx` dev mode the built assets normally don't exist (Vite serves
 * `web/` directly on :5173 and proxies `/api` here) — `GET /` then returns a short HTML notice
 * instead of a 404, which is deliberate: the Hono server is not meant to be hit for the app UI
 * in dev.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { isInside } from './paths.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const DEV_NOTICE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>AI Cost Analyzer</title></head>
<body>
  <p>Run <code>npm run build</code>, or use <code>npm run dev</code> and open
  <a href="http://127.0.0.1:5173/">http://127.0.0.1:5173/</a>.</p>
</body>
</html>`;

/** Resolves the built web root. Always ends at `dist/web`, whether this module is running
 * from `server/static.ts` (tsx) or `dist/server/static.js` (built). */
export function resolveWebRoot(): string {
  const isTs = import.meta.url.endsWith('.ts');
  const rel = isTs ? '../dist/web' : '../web';
  return fileURLToPath(new URL(rel, import.meta.url));
}

function contentType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function safeResolve(webRoot: string, requestPath: string): string | null {
  const normalized = normalize(requestPath).replace(/^(\.\.[/\\])+/, '');
  const target = join(webRoot, normalized);
  if (!isInside(webRoot, target)) return null;
  return target;
}

function fileInfo(path: string): { size: number } | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? { size: stat.size } : null;
  } catch {
    return null;
  }
}

export interface StaticOptions {
  webRoot?: string;
}

/** Static + SPA-fallback middleware for every non-`/api` GET request. */
export function staticMiddleware(opts: StaticOptions = {}): MiddlewareHandler {
  const webRoot = opts.webRoot ?? resolveWebRoot();
  const indexPath = join(webRoot, 'index.html');

  return async (c: Context, next: Next) => {
    const url = new URL(c.req.url);
    if (url.pathname.startsWith('/api')) return next();
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();

    if (!existsSync(indexPath)) {
      // Nothing is built. Any *route* (a path with no file extension, which is what a bookmark
      // or a reload of a client-side URL looks like) gets the "run npm run build" notice rather
      // than a bare 404; asset requests still fall through so a missing file reads as missing.
      if (extname(url.pathname) === '' || url.pathname === '/index.html') return c.html(DEV_NOTICE);
      return next();
    }

    const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const target = safeResolve(webRoot, requestPath);
    const info = target ? fileInfo(target) : null;

    if (target && info) {
      const body = readFileSync(target);
      c.header('Content-Type', contentType(target));
      c.header('Content-Length', String(info.size));
      if (url.pathname.startsWith('/assets/')) {
        c.header('Cache-Control', 'public, max-age=31536000, immutable');
      }
      return c.body(body);
    }

    // SPA fallback: any other non-file GET route renders the app shell.
    const indexBody = readFileSync(indexPath);
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(indexBody);
  };
}
