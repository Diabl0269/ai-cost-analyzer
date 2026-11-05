import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import type { IndexEvent } from '../../core/types.js';
import { defaultPricing } from '../../core/pricing/defaults.js';
import { createIndexManager, type IndexManagerLike } from '../../server/indexing.js';

type FakeWorker = EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };
const mock = vi.hoisted(() => ({ workers: [] as FakeWorker[] }));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return { Worker: class extends EventEmitter {
    postMessage = vi.fn();
    terminate = vi.fn(async () => 0);
    constructor() { super(); mock.workers.push(this); }
  } };
});
const result = { sessionsIndexed: 1, sessionsSkipped: 0, filesSeen: 1, parseErrors: 0, durationMs: 1, changedSessionIds: [] };
let manager: IndexManagerLike | undefined;
afterEach(async () => { await manager?.dispose(); mock.workers.length = 0; });

describe('retained indexing failure', () => {
  it('keeps a failed full scan visible through progress and successful incremental runs until rescan repairs it', () => {
    const events: IndexEvent[] = [];
    manager = createIndexManager({ roots: ['/synthetic/transcripts'], dbPath: '/synthetic/index.sqlite', pricing: defaultPricing, broadcast: (event) => events.push(event), workerPath: '/synthetic/worker.js' });
    manager.requestFull();
    mock.workers.at(-1)!.emit('message', { type: 'error', message: 'Synthetic duplicate agent row' });
    expect(manager.status()).toMatchObject({ indexing: false, error: 'Synthetic duplicate agent row' });
    manager.requestIncremental(['/synthetic/transcripts/session.jsonl']);
    mock.workers.at(-1)!.emit('message', { type: 'progress', progress: { phase: 'parse', filesDone: 0, filesTotal: 1, sessionsDone: 0, sessionsTotal: 1, startedAt: '2026-11-05T10:00:00Z' } });
    expect(manager.status().error).toBe('Synthetic duplicate agent row');
    mock.workers.at(-1)!.emit('message', { type: 'done', result });
    expect(manager.status()).toMatchObject({ indexing: false, error: 'Synthetic duplicate agent row' });
    expect(events.at(-1)).toMatchObject({ type: 'indexed', indexError: 'Synthetic duplicate agent row' });
    manager.requestRescan();
    expect(manager.status().error).toBe('Synthetic duplicate agent row');
    mock.workers.at(-1)!.emit('message', { type: 'done', result });
    expect(manager.status().error).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'indexed' });
    expect(events.at(-1)).not.toHaveProperty('indexError');
  });

  it('also clears the failure after a successful full rebuild', () => {
    manager = createIndexManager({ roots: [], dbPath: '/synthetic/index.sqlite', pricing: defaultPricing, broadcast: () => {}, workerPath: '/synthetic/worker.js' });
    manager.requestFull();
    mock.workers.at(-1)!.emit('message', { type: 'error', message: 'Synthetic scan failed' });
    manager.requestFull();
    mock.workers.at(-1)!.emit('message', { type: 'done', result });
    expect(manager.status().error).toBeUndefined();
  });
  it('reports a failed-session result as incomplete instead of up to date', () => {
    const events: IndexEvent[] = [];
    manager = createIndexManager({ roots: [], dbPath: '/synthetic/index.sqlite', pricing: defaultPricing, broadcast: event => events.push(event), workerPath: '/synthetic/worker.js' });
    manager.requestRescan();
    mock.workers.at(-1)!.emit('message', { type: 'done', result: { ...result, sessionsFailed: 1 } });
    expect(manager.status()).toMatchObject({ indexing: false, error: expect.stringContaining('could not be parsed') });
    expect(events.at(-1)?.type).toBe('error');
    expect(events.some(event => event.type === 'indexed')).toBe(false);
  });

});
