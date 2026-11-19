import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { statusRoutes } from '../../server/routes/status.js';
import type { AppDeps } from '../../server/deps.js';
import { defaultPricing } from '../../core/pricing/defaults.js';
import { defaultSettings } from '../../core/settings.js';

describe('GET status retained indexing failure', () => {
  it('returns the failure on a fresh request and omits it after repair', async () => {
    let error: string | undefined = 'Synthetic scan failed';
    const deps = {
      config: { get: () => ({ pricing: defaultPricing(), settings: defaultSettings() }) },
      store: { dbPath: '/synthetic/index.sqlite', status: async () => ({ lastIndexedAt: null, dbBytes: 0, counts: { projects: 0, sessions: 0, requests: 0, agents: 0, messages: 0 }, unpricedModels: [] }) },
      index: { status: () => ({ indexing: false, lastIndexedAt: null, error }) },
      roots: ['/synthetic/transcripts'], version: 'test',
    } as unknown as AppDeps;
    const app = new Hono().route('/status', statusRoutes(deps));
    expect(await (await app.request('/status')).json()).toMatchObject({ indexError: 'Synthetic scan failed' });
    error = undefined;
    expect(await (await app.request('/status')).json()).not.toHaveProperty('indexError');
  });

  it('caps and passes through indexing failures', async () => {
    const failures = Array.from({ length: 60 }, (_, i) => ({ sessionId: `s${i}`, provider: 'claude', paths: ['~/p.jsonl'], phase: 'parse', error: 'Error: x' }));
    const deps = {
      config: { get: () => ({ pricing: defaultPricing(), settings: defaultSettings() }) },
      store: { dbPath: '/synthetic/index.sqlite', status: async () => ({ lastIndexedAt: null, dbBytes: 0, counts: { projects: 0, sessions: 0, requests: 0, agents: 0, messages: 0 }, unpricedModels: [] }) },
      index: { status: () => ({ indexing: false, lastIndexedAt: null, indexFailures: failures }) },
      roots: [], version: 'test',
    } as unknown as AppDeps;
    const body = await (await new Hono().route('/status', statusRoutes(deps)).request('/status')).json() as { indexFailures: unknown[]; indexFailureCount: number };
    expect(body.indexFailures).toHaveLength(50);
    expect(body.indexFailureCount).toBe(60);
    expect(body.indexFailures[0]).toMatchObject({ paths: ['~/p.jsonl'] });
    expect(body).not.toHaveProperty('indexError');
  });

  it('reports capped discovery warnings alongside, not as, an index error', async () => {
    const discoverWarnings = Array.from({ length: 60 }, (_, i) => ({ path: `~/w${i}`, message: 'EACCES: permission denied' }));
    const deps = {
      config: { get: () => ({ pricing: defaultPricing(), settings: defaultSettings() }) },
      store: { dbPath: '/synthetic/index.sqlite', status: async () => ({ lastIndexedAt: null, dbBytes: 0, counts: { projects: 0, sessions: 0, requests: 0, agents: 0, messages: 0 }, unpricedModels: [] }) },
      index: { status: () => ({ indexing: false, lastIndexedAt: null, discoverWarnings }) },
      roots: [], version: 'test',
    } as unknown as AppDeps;
    const body = await (await new Hono().route('/status', statusRoutes(deps)).request('/status')).json() as { discoverWarnings: unknown[]; discoverWarningCount: number };
    expect(body.discoverWarnings).toHaveLength(50);
    expect(body.discoverWarningCount).toBe(60);
    expect(body).not.toHaveProperty('indexError');
  });
});
