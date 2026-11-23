/**
 * Assembles the Hono app: security headers → host/origin guard → auth-session route →
 * session-cookie guard → API routes → static/SPA fallback. `createApp` takes all runtime
 * dependencies as an argument so tests can inject fakes and never touch the real DB or FS
 * (besides the injected `store`/`config`, this module itself has no I/O).
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createAuthState, hostGuard, parseLoopbackOriginUrls, securityHeaders, sessionAuth } from './auth.js';
import type { AppDeps } from './deps.js';
import { analyticsRoutes } from './routes/analytics.js';
import { authRoutes } from './routes/auth.js';
import { eventsRoutes } from './routes/events.js';
import { exportRoutes } from './routes/export.js';
import { pricingRoutes } from './routes/pricing.js';
import { projectsRoutes } from './routes/projects.js';
import { reindexRoutes } from './routes/reindex.js';
import { searchRoutes } from './routes/search.js';
import { sessionsRoutes } from './routes/sessions.js';
import { settingsRoutes } from './routes/settings.js';
import { statusRoutes } from './routes/status.js';
import { staticMiddleware } from './static.js';

/** Every request body this API accepts (pricing table, settings, `{full}`) is a few KB of JSON
 * at most. `@hono/node-server` and Hono itself impose no default cap, so an authenticated PUT
 * with a multi-megabyte body would otherwise be buffered and `JSON.parse`d in full before zod
 * ever sees it. 1 MiB is generous headroom over any real payload and small enough to make that
 * not a concern. */
const MAX_API_BODY_BYTES = 1024 * 1024;

/**
 * Origins the dev server accepts besides its own. Vite proxies `/api` to this server, so a
 * mutation arrives carrying the *Vite* origin — which is 5173 by default but `CCA_VITE_PORT`
 * whenever two agents run side by side, and a POST from that UI was answered 403 (GETs carry no
 * Origin at all, so only writes broke). `CCA_DEV_ORIGINS` still wins for anything else.
 */
function devOrigins(): string {
  const port = process.env.CCA_VITE_PORT;
  const fromVite = port ? [`http://127.0.0.1:${port}`, `http://localhost:${port}`] : [];
  return [process.env.CCA_DEV_ORIGINS, ...fromVite].filter(Boolean).join(',');
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const authState = createAuthState();
  const embedOrigins = parseLoopbackOriginUrls(process.env.CCA_EMBED_ORIGINS);

  app.use('*', securityHeaders({ embedOrigins }));
  app.use(
    '/api/*',
    hostGuard({
      port: deps.port,
      dev: deps.dev,
      ...(devOrigins() ? { devOrigins: devOrigins() } : {}),
      embedOrigins,
    }),
  );
  app.route('/api/auth', authRoutes(authState));
  app.use('/api/*', sessionAuth(authState));
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_API_BODY_BYTES,
      onError: (c) => c.json({ error: { code: 'payload_too_large', message: 'request body too large' } }, 413),
    }),
  );

  app.route('/api/status', statusRoutes(deps));
  app.route('/api/projects', projectsRoutes(deps));
  app.route('/api/sessions', sessionsRoutes(deps));
  app.route('/api/search', searchRoutes(deps));
  app.route('/api/analytics', analyticsRoutes(deps));
  app.route('/api/pricing', pricingRoutes(deps));
  app.route('/api/settings', settingsRoutes(deps));
  app.route('/api/reindex', reindexRoutes(deps));
  app.route('/api/events', eventsRoutes(deps));
  app.route('/api/export', exportRoutes(deps));

  app.notFound((c) => {
    if (new URL(c.req.url).pathname.startsWith('/api')) {
      return c.json({ error: { code: 'not_found', message: 'unknown endpoint' } }, 404);
    }
    return c.text('not found', 404);
  });

  // Hono's built-in fallback for an uncaught throw inside a route handler is a bare
  // `text("Internal Server Error", 500)` — it never leaks the error itself to the client, but it
  // also isn't the `{ error: { code, message } }` envelope every other error on this API uses
  // (SPEC §7.2), and it's plain text on `/api/*` where clients expect JSON. Normalize it here.
  // Only the error's *class name* is logged (never `.message`/`.stack`): those can carry request
  // input or, worse, a fragment of transcript content if a bug surfaced it inside an error
  // message somewhere upstream — SPEC §1.4's "never log transcript content" applies to crash
  // logs too, not just the normal request log.
  app.onError((err, c) => {
    const className = err instanceof Error ? err.constructor.name : typeof err;
    console.error(`unhandled error in request handler (${className})`);
    if (new URL(c.req.url).pathname.startsWith('/api')) {
      return c.json({ error: { code: 'internal_error', message: 'internal error' } }, 500);
    }
    return c.text('internal error', 500);
  });

  app.use('*', staticMiddleware({ webRoot: deps.staticRoot }));

  return app;
}
