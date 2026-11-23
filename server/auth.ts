/**
 * Auth + security headers for the loopback-only server (SPEC §7.3). This is a single-user
 * tool; the goal is to stop a malicious *webpage* (open in the same browser) from talking to
 * it via cross-site requests or DNS rebinding, not to authenticate multiple real users.
 *
 * Layers, applied in order:
 *  1. hostGuard   — Host must be an allowed loopback origin; Sec-Fetch-Site/Origin must agree.
 *  2. sessionAuth — every other /api/* route requires the `cca_session` cookie.
 *  3. securityHeaders — nosniff / CSP / no-referrer / no-store on API responses.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getCookie, setCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler, Next } from 'hono';

export const SESSION_COOKIE = 'cca_session';
const AUTH_SESSION_PATH = '/api/auth/session';
const STATUS_PATH = '/api/status';

export interface AuthOptions {
  port: number;
  dev: boolean;
  /**
   * Extra dev origins to accept for the Host/Origin checks, comma-separated
   * (`CCA_DEV_ORIGINS=http://127.0.0.1:5174,http://localhost:5174`). Only consulted when
   * `dev` is true, so production never widens its allow-list from the environment.
   */
  devOrigins?: string;
  /** Explicitly allow same-site iframe requests when a loopback parent is configured. */
  embedOrigins?: string[];
}

/** Holds the single in-memory session token for this server process's lifetime. */
export interface AuthState {
  readonly token: string;
}

export function createAuthState(): AuthState {
  return { token: randomBytes(32).toString('hex') };
}

/** Loopback host names only: an extra dev origin may not open the server to the network. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Parses comma-separated `http(s)` URLs on loopback hosts with an explicit port. Anything else
 * is dropped silently — a typo must never widen an allow-list to a routable address. Used by
 * `CCA_DEV_ORIGINS` (Host/Origin checks) and `CCA_EMBED_ORIGINS` (CSP `frame-ancestors`).
 */
export function parseLoopbackOriginUrls(value: string | undefined): string[] {
  if (!value) return [];
  const origins: string[] = [];
  for (const raw of value.split(',')) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (!LOOPBACK_HOSTNAMES.has(url.hostname)) continue;
    if (url.port === '') continue;
    origins.push(`${url.protocol}//${url.hostname}:${url.port}`);
  }
  return origins;
}

/** `host:port` entries for the Host header allow-list, derived from loopback origin URLs. */
function extraDevHosts(value: string | undefined): string[] {
  return parseLoopbackOriginUrls(value).map((origin) => new URL(origin).host);
}

function allowedHosts(opts: AuthOptions): Set<string> {
  const hosts = [`127.0.0.1:${opts.port}`, `localhost:${opts.port}`];
  if (opts.dev) {
    hosts.push('127.0.0.1:5173', 'localhost:5173', ...extraDevHosts(opts.devOrigins));
  }
  return new Set(hosts);
}

function allowedOrigins(opts: AuthOptions): Set<string> {
  return new Set([...allowedHosts(opts)].map((host) => `http://${host}`));
}

function jsonError(c: Context, status: 401 | 403, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

/** Layer 1: Host allow-list, Sec-Fetch-Site, and Origin checks. Applies to all `/api/*`. */
export function hostGuard(opts: AuthOptions): MiddlewareHandler {
  const hosts = allowedHosts(opts);
  const origins = allowedOrigins(opts);
  return async (c: Context, next: Next) => {
    const host = c.req.header('host');
    if (!host || !hosts.has(host)) {
      return jsonError(c, 403, 'forbidden', 'request Host is not allowed');
    }
    const secFetchSite = c.req.header('sec-fetch-site');
    const allowsEmbeddedSameSite = secFetchSite === 'same-site' && (opts.embedOrigins?.length ?? 0) > 0;
    if (secFetchSite !== undefined && secFetchSite !== 'same-origin' && secFetchSite !== 'none' && !allowsEmbeddedSameSite) {
      return jsonError(c, 403, 'forbidden', 'cross-site request blocked');
    }
    const origin = c.req.header('origin');
    if (origin !== undefined && !origins.has(origin)) {
      return jsonError(c, 403, 'forbidden', 'request Origin is not allowed');
    }
    await next();
  };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Issues the session cookie. Mounted at `POST /api/auth/session`, behind hostGuard only. */
export function issueSessionHandler(state: AuthState) {
  return (c: Context): Response => {
    setCookie(c, SESSION_COOKIE, state.token, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
    });
    return c.body(null, 204);
  };
}

/**
 * Layer 2: requires the session cookie on every `/api/*` route except the session-issuing
 * route itself. `CCA_ALLOW_UNAUTH_STATUS=1` exempts `GET /api/status` (used by health checks
 * that run before the browser has authenticated).
 */
export function sessionAuth(state: AuthState, env: NodeJS.ProcessEnv = process.env): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname;
    if (path === AUTH_SESSION_PATH) return next();
    if (env.CCA_ALLOW_UNAUTH_STATUS === '1' && c.req.method === 'GET' && path === STATUS_PATH) {
      return next();
    }
    const cookie = getCookie(c, SESSION_COOKIE);
    if (!cookie || !safeEqual(cookie, state.token)) {
      return jsonError(c, 401, 'unauthenticated', 'missing or invalid session cookie');
    }
    await next();
  };
}

export interface SecurityHeadersOptions {
  /**
   * Loopback parent origins that may embed this app in an iframe (`CCA_EMBED_ORIGINS`). When
   * empty, `frame-ancestors 'none'` keeps the default standalone-only posture.
   */
  embedOrigins?: string[];
}

function contentSecurityPolicy(embedOrigins: string[]): string {
  const frameAncestors =
    embedOrigins.length === 0 ? "'none'" : `'self' ${embedOrigins.join(' ')}`;
  return (
    "default-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; " +
    `script-src 'self'; connect-src 'self'; frame-ancestors ${frameAncestors}`
  );
}

/** Security headers for every response. `Cache-Control: no-store` is limited to `/api/*`. */
export function securityHeaders(opts: SecurityHeadersOptions = {}): MiddlewareHandler {
  const embedOrigins = opts.embedOrigins ?? [];
  const csp = contentSecurityPolicy(embedOrigins);
  return async (c: Context, next: Next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', csp);
    if (new URL(c.req.url).pathname.startsWith('/api')) {
      c.header('Cache-Control', 'no-store');
    }
  };
}
