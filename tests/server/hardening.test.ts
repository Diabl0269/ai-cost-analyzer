/**
 * Regression tests for the security-review hardening pass:
 *  - export filename header injection (session id must be a plain token)
 *  - `settings.roots` policy (existing directories only, no sensitive locations, with a
 *    grandfather exemption for an already-configured root that has since disappeared)
 *  - request body size cap on `/api/*`
 *  - the indexing worker exiting without ever posting a message is treated as a crash, not a
 *    silent hang
 *  - an uncaught throw inside a route handler still answers with the standard error envelope
 *  - `POST /api/reindex { full: true }` is honoured regardless of how the body is framed
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../../server/config.js';
import { createApp } from '../../server/app.js';
import { createIndexManager } from '../../server/indexing.js';
import { validateRoots } from '../../server/rootsPolicy.js';
import { createSseHub } from '../../server/sse.js';
import type { AppDeps } from '../../server/deps.js';
import { authedCookieHeader, buildTestApp, fakeIndexManager, jsonBody, type TestApp } from './helpers.js';
import { FAKE_SESSION_ID } from './fake-store.js';

describe('export filename header injection', () => {
  let ctx: TestApp;
  afterEach(() => ctx?.cleanup());

  async function tryId(rawId: string): Promise<Response> {
    ctx = buildTestApp();
    const cookie = await authedCookieHeader(ctx.app, ctx.port);
    const path = `/api/export/sessions/${encodeURIComponent(rawId)}.json`;
    return ctx.app.request(path, { headers: { host: `127.0.0.1:${ctx.port}`, cookie } });
  }

  it('400s a session id containing a quote instead of building a broken header', async () => {
    const res = await tryId(`${FAKE_SESSION_ID}"; evil`);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  it('400s a session id containing CRLF instead of injecting a header', async () => {
    const res = await tryId(`${FAKE_SESSION_ID}\r\nX-Injected: yes`);
    expect(res.status).toBe(400);
    expect(res.headers.get('x-injected')).toBeNull();
  });

  it('400s a session id containing a path separator', async () => {
    const res = await tryId('../../../etc/passwd');
    expect(res.status).toBe(400);
  });

  it('still serves a well-formed id with a clean Content-Disposition', async () => {
    const res = await tryId(FAKE_SESSION_ID);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${FAKE_SESSION_ID}.json"`);
  });
});

describe('settings.roots policy (unit)', () => {
  it('rejects system and credential directories', () => {
    const ccaHome = '/does-not-matter-for-this-check';
    for (const bad of ['/etc', '/', `${process.env.HOME}/.ssh`, `${process.env.HOME}/.claude`]) {
      const result = validateRoots([bad], ccaHome);
      expect(result.ok).toBe(false);
      expect(result.violations[0]?.reason).toBe('sensitive_location');
    }
  });

  it('allows the documented default root', () => {
    const home = mkdtempSync(join(tmpdir(), 'cca-default-root-'));
    const root = join(home, '.claude', 'projects');
    mkdirSync(root, { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const result = validateRoots([root], '/does-not-matter');
      expect(result.ok).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a root that is not an existing directory', () => {
    const result = validateRoots(['/definitely/not/a/real/path/xyz'], '/does-not-matter');
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.reason).toBe('not_a_directory');
  });

  it('rejects the app own CCA_HOME as a root', () => {
    const ccaHome = mkdtempSync(join(tmpdir(), 'cca-roots-'));
    const result = validateRoots([ccaHome], ccaHome);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.reason).toBe('sensitive_location');
    rmSync(ccaHome, { recursive: true, force: true });
  });

  it('grandfathers a previously-configured root that has since disappeared', () => {
    const missing = join('/private/tmp', `cca-roots-missing-${Date.now()}`);
    const withoutHistory = validateRoots([missing], '/does-not-matter');
    expect(withoutHistory.ok).toBe(false);

    const withHistory = validateRoots([missing], '/does-not-matter', [missing]);
    expect(withHistory.ok).toBe(true);
  });

  it('never grandfathers the sensitive-location check', () => {
    const result = validateRoots(['/etc'], '/does-not-matter', ['/etc']);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.reason).toBe('sensitive_location');
  });
});

describe('PUT /api/settings enforces the roots policy end-to-end', () => {
  let ctx: TestApp;
  afterEach(() => ctx?.cleanup());

  it('400s when roots points at /etc', async () => {
    ctx = buildTestApp();
    const cookie = await authedCookieHeader(ctx.app, ctx.port);
    const headers = { host: `127.0.0.1:${ctx.port}`, cookie, 'content-type': 'application/json' };
    const current = await jsonBody(await ctx.app.request('/api/settings', { headers }));
    const res = await ctx.app.request('/api/settings', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...current, roots: ['/etc'] }),
    });
    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error.code).toBe('bad_request');
    expect(ctx.config.get().settings.roots).not.toContain('/etc');
  });

  it('does not block an unrelated field change when the already-configured root is missing', async () => {
    ctx = buildTestApp();
    const missingRoot = join('/private/tmp', `cca-settings-missing-${Date.now()}`);
    ctx.config.updateSettings({ ...ctx.config.get().settings, roots: [missingRoot] });
    const cookie = await authedCookieHeader(ctx.app, ctx.port);
    const headers = { host: `127.0.0.1:${ctx.port}`, cookie, 'content-type': 'application/json' };
    const current = await jsonBody(await ctx.app.request('/api/settings', { headers }));
    const res = await ctx.app.request('/api/settings', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...current, theme: 'slate' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('request body size cap on /api/*', () => {
  let ctx: TestApp;
  afterEach(() => ctx?.cleanup());

  it('413s an oversize PUT /api/settings body instead of buffering/parsing it', async () => {
    ctx = buildTestApp();
    const cookie = await authedCookieHeader(ctx.app, ctx.port);
    const headers = { host: `127.0.0.1:${ctx.port}`, cookie, 'content-type': 'application/json' };
    const current = await jsonBody(await ctx.app.request('/api/settings', { headers }));
    const oversizePadding = 'x'.repeat(20 * 1024 * 1024);
    const res = await ctx.app.request('/api/settings', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...current, oversizePadding }),
    });
    expect(res.status).toBe(413);
  });

  it('413s an oversize PUT /api/pricing body', async () => {
    ctx = buildTestApp();
    const cookie = await authedCookieHeader(ctx.app, ctx.port);
    const headers = { host: `127.0.0.1:${ctx.port}`, cookie, 'content-type': 'application/json' };
    const res = await ctx.app.request('/api/pricing', {
      method: 'PUT',
      headers,
      body: `{${'"a":1,'.repeat(1024 * 1024)}"b":1}`,
    });
    expect(res.status).toBe(413);
  });

  it('still 400s a small malformed JSON body (not swallowed by the size guard)', async () => {
    ctx = buildTestApp();
    const cookie = await authedCookieHeader(ctx.app, ctx.port);
    const res = await ctx.app.request('/api/pricing', {
      method: 'PUT',
      headers: { host: `127.0.0.1:${ctx.port}`, cookie, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('uncaught route errors still answer the standard error envelope', () => {
  it('normalizes an unhandled throw on /api/* to a 500 JSON envelope, never a bare 500 text body', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cca-onerror-'));
    const config = ConfigStore.load(join(home, 'config.json'));
    const brokenStore = {
      status: () => {
        throw new Error('boom: should never reach the client');
      },
    };
    const deps: AppDeps = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately partial fake to force a throw
      store: brokenStore as any,
      config,
      index: fakeIndexManager(),
      sse: createSseHub(),
      roots: ['/home/user/.claude/projects'],
      port: 4141,
      dev: false,
      version: 'test',
      ccaHome: home,
    };
    const app = createApp(deps);
    const authRes = await app.request('/api/auth/session', {
      method: 'POST',
      headers: { host: '127.0.0.1:4141' },
    });
    const cookieMatch = /cca_session=([^;]+)/.exec(authRes.headers.get('set-cookie') ?? '');
    const cookie = `cca_session=${cookieMatch?.[1]}`;

    const res = await app.request('/api/status', { headers: { host: '127.0.0.1:4141', cookie } });
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await jsonBody(res);
    expect(body.error.code).toBe('internal_error');
    expect(JSON.stringify(body)).not.toContain('boom');
    rmSync(home, { recursive: true, force: true });
  });
});

describe('IndexManager survives a worker that exits without ever posting a message', () => {
  it('reports an error event, clears `indexing`, and still accepts a follow-up request', async () => {
    const crashScript = join(tmpdir(), `cca-crash-worker-${Date.now()}.mjs`);
    writeFileSync(crashScript, 'process.exit(7);\n');

    const events: { type: string }[] = [];
    const mgr = createIndexManager({
      roots: [],
      dbPath: ':memory:',
      broadcast: (event) => events.push(event),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fake pricing
      pricing: () => ({}) as any,
      workerPath: crashScript,
    });

    mgr.requestFull();
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(mgr.status().indexing).toBe(false);

    // A crash must not leave the manager stuck thinking a run is still in progress: a follow-up
    // request has to actually start (and itself crash + report again), not be silently coalesced
    // into a pending run that never starts.
    events.length = 0;
    mgr.requestFull();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(events.some((e) => e.type === 'error')).toBe(true);

    await mgr.dispose();
    rmSync(crashScript, { force: true });
  });
});

describe('POST /api/reindex reads the body without relying on Content-Length', () => {
  function buildAppWithIndexSpy(): { app: ReturnType<typeof createApp>; calls: string[]; cleanup(): void } {
    const home = mkdtempSync(join(tmpdir(), 'cca-reindex-'));
    const config = ConfigStore.load(join(home, 'config.json'));
    const calls: string[] = [];
    const deps: AppDeps = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- route never reads the store
      store: {} as any,
      config,
      index: {
        status: () => ({ indexing: false, lastIndexedAt: null }),
        requestFull: () => calls.push('full'),
        requestRescan: () => calls.push('rescan'),
        requestIncremental: () => {},
        dispose: () => Promise.resolve(),
      },
      sse: createSseHub(),
      roots: ['/home/user/.claude/projects'],
      port: 4141,
      dev: false,
      version: 'test',
      ccaHome: home,
    };
    return { app: createApp(deps), calls, cleanup: () => rmSync(home, { recursive: true, force: true }) };
  }

  async function cookieFor(app: ReturnType<typeof createApp>): Promise<string> {
    const res = await app.request('/api/auth/session', { method: 'POST', headers: { host: '127.0.0.1:4141' } });
    const match = /cca_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
    return `cca_session=${match?.[1]}`;
  }

  it('a genuinely bodyless POST rescans', async () => {
    const { app, calls, cleanup } = buildAppWithIndexSpy();
    const cookie = await cookieFor(app);
    const res = await app.request('/api/reindex', { method: 'POST', headers: { host: '127.0.0.1:4141', cookie } });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['rescan']);
    cleanup();
  });

  it('{ full: true } triggers a full rebuild even without an explicit Content-Length header', async () => {
    const { app, calls, cleanup } = buildAppWithIndexSpy();
    const cookie = await cookieFor(app);
    // The Fetch `Request` object never exposes a computed Content-Length via `.headers` (verified:
    // `new Request(url, { body }).headers.get('content-length')` is `null`), which is exactly the
    // shape of a chunked-transfer request on the wire — this is the regression this test guards.
    const res = await app.request('/api/reindex', {
      method: 'POST',
      headers: { host: '127.0.0.1:4141', cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ full: true }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['full']);
    cleanup();
  });

  it('400s malformed JSON instead of silently rescanning', async () => {
    const { app, calls, cleanup } = buildAppWithIndexSpy();
    const cookie = await cookieFor(app);
    const res = await app.request('/api/reindex', {
      method: 'POST',
      headers: { host: '127.0.0.1:4141', cookie, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
    cleanup();
  });
});
