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
});
