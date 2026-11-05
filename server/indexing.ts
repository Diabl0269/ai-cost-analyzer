/**
 * IndexManager: runs full/incremental indexing inside a `worker_threads` Worker, single-flight
 * (a request that arrives while one is running is coalesced into a pending run that starts
 * right after), and forwards progress to SSE subscribers via the injected `broadcast`.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { IndexEvent, IndexProgress, PricingConfig } from '../core/types.js';
import type { IndexResult } from '../core/store.js';
import type { WorkerMessage, RunMessage } from './worker.js';

/** What kind of index run to perform; also the coalescing priority order (see MODE_RANK). */
export type IndexMode = 'full' | 'rescan' | 'incremental';

export interface IndexManagerStatus {
  /** A successful incremental run does not repair an incomplete root scan. */
  error?: string;
  indexing: boolean;
  progress?: IndexProgress;
  lastIndexedAt: string | null;
}

export interface IndexManagerLike {
  status(): IndexManagerStatus;
  /** drop and rebuild the whole DB */
  requestFull(): void;
  /** mtime/size diff across all configured roots (boot, manual "reindex" without full:true) */
  requestRescan(): void;
  /** reparse only the sessions owning these changed files (watcher) */
  requestIncremental(paths: string[]): void;
  dispose(): Promise<void>;
}

export interface IndexManagerOptions {
  roots: string[];
  dbPath: string;
  broadcast: (event: IndexEvent) => void;
  /**
   * Read at the start of every run so a pricing edit takes effect on the next index without a
   * restart. Indexing uses it for `charsPerToken` only.
   */
  pricing: () => PricingConfig;
  /**
   * Called after a run finishes successfully, before the `indexed` event is broadcast. The
   * server uses it to `store.reopen()` after a full rebuild (which drops and recreates every
   * table underneath the reader's connection).
   */
  onRunComplete?: (mode: IndexMode, result: IndexResult) => void;
  /** override for tests; defaults to resolving server/worker.(js|ts) next to this file */
  workerPath?: string;
}

type Mode = IndexMode;

/** Priority order for coalescing: a queued 'full' or 'rescan' subsumes everything below it. */
const MODE_RANK: Record<Mode, number> = { full: 2, rescan: 1, incremental: 0 };

/** Resolves worker.js next to this file when built, or worker.ts (run via tsx) in dev. */
function resolveWorkerPath(): string {
  const isTs = import.meta.url.endsWith('.ts');
  const workerUrl = new URL(isTs ? './worker.ts' : './worker.js', import.meta.url);
  return fileURLToPath(workerUrl);
}

function spawnWorker(workerPath: string): Worker {
  const isTs = workerPath.endsWith('.ts');
  // `tsx/esm` (not bare `tsx`) is the loader-only entry: it registers the TS resolver without
  // trying to create tsx's CLI IPC socket, which is not permitted in every sandbox.
  return new Worker(workerPath, isTs ? { execArgv: ['--import', 'tsx/esm'] } : {});
}

class IndexManagerImpl implements IndexManagerLike {
  private error: string | undefined;
  private running = false;
  private runningMode: Mode | null = null;
  private currentWorker: Worker | null = null;
  private progress: IndexProgress | undefined;
  private lastIndexedAt: string | null = null;
  private pendingMode: Mode | null = null;
  private readonly pendingPaths = new Set<string>();
  private readonly workerPath: string;

  constructor(private readonly opts: IndexManagerOptions) {
    this.workerPath = opts.workerPath ?? resolveWorkerPath();
  }

  status(): IndexManagerStatus {
    return { indexing: this.running, progress: this.progress, lastIndexedAt: this.lastIndexedAt, error: this.error };
  }

  requestFull(): void {
    this.enqueue('full', []);
  }

  requestRescan(): void {
    this.enqueue('rescan', []);
  }

  requestIncremental(paths: string[]): void {
    if (paths.length === 0) return;
    this.enqueue('incremental', paths);
  }

  private enqueue(mode: Mode, paths: string[]): void {
    if (!this.running) {
      this.start(mode, paths);
      return;
    }
    if (this.pendingMode && MODE_RANK[this.pendingMode] >= MODE_RANK[mode]) {
      if (mode === 'incremental') for (const path of paths) this.pendingPaths.add(path);
      return;
    }
    this.pendingMode = mode;
    if (mode !== 'incremental') this.pendingPaths.clear();
    for (const path of paths) this.pendingPaths.add(path);
  }

  private start(mode: Mode, paths: string[]): void {
    this.running = true;
    this.runningMode = mode;
    this.progress = undefined;
    const worker = spawnWorker(this.workerPath);
    this.currentWorker = worker;
    // `finished` guards against the worker's own 'exit' event (fired for every worker, including
    // ones that completed normally and were then terminate()d by onMessage) being mistaken for a
    // crash. It is only false if neither a terminal ('done'/'error') message nor the 'error'
    // event has been seen yet when 'exit' fires — i.e. the worker died without telling us why
    // (OOM kill, process.exit() inside the worker, an uncaught rejection that crashes the
    // isolate). Without this, a silent worker death left `running` stuck `true` forever: the
    // status pill would show "indexing" forever and every future reindex request would just be
    // coalesced into a pending run that never starts (SPEC §7: worker crash mid-index must keep
    // the server serving and report an error event).
    let finished = false;
    worker.on('message', (msg: WorkerMessage) => {
      if (msg.type !== 'progress') finished = true;
      this.onMessage(msg);
    });
    worker.on('error', (err: Error) => {
      finished = true;
      this.onMessage({ type: 'error', message: err.message });
    });
    worker.on('exit', (code: number) => {
      if (finished) return;
      finished = true;
      this.onMessage({ type: 'error', message: `indexing worker exited unexpectedly (code ${code})` });
    });
    const run: RunMessage = {
      type: 'run',
      mode,
      roots: this.opts.roots,
      dbPath: this.opts.dbPath,
      paths,
      pricing: this.opts.pricing(),
    };
    worker.postMessage(run);
  }

  private onMessage(msg: WorkerMessage): void {
    if (msg.type === 'progress') {
      this.progress = msg.progress;
      this.opts.broadcast({ type: 'progress', progress: msg.progress });
      return;
    }
    void this.currentWorker?.terminate();
    this.currentWorker = null;
    this.running = false;
    const mode = this.runningMode;
    this.runningMode = null;
    this.progress = undefined;
    if (msg.type === 'done') {
      if (mode) this.opts.onRunComplete?.(mode, msg.result);
      if (msg.result.sessionsFailed) {
        this.error = `${msg.result.sessionsFailed} session(s) could not be parsed. The index is incomplete; retry indexing all roots.`;
        this.opts.broadcast({ type: 'error', message: this.error });
        this.maybeStartPending();
        return;
      }
      this.lastIndexedAt = new Date().toISOString();
      if (mode === 'full' || mode === 'rescan') this.error = undefined;
      this.opts.broadcast({ type: 'indexed', at: this.lastIndexedAt, ...(this.error ? { indexError: this.error } : {}) });
      if (msg.result.changedSessionIds.length > 0) {
        this.opts.broadcast({ type: 'sessionsChanged', sessionIds: msg.result.changedSessionIds });
      }
    } else {
      this.error = msg.message;
      this.opts.broadcast({ type: 'error', message: msg.message });
    }
    this.maybeStartPending();
  }

  private maybeStartPending(): void {
    if (!this.pendingMode) return;
    const mode = this.pendingMode;
    const paths = [...this.pendingPaths];
    this.pendingMode = null;
    this.pendingPaths.clear();
    this.start(mode, paths);
  }

  async dispose(): Promise<void> {
    this.pendingMode = null;
    this.pendingPaths.clear();
    if (this.currentWorker) {
      await this.currentWorker.terminate();
      this.currentWorker = null;
    }
    this.running = false;
    this.runningMode = null;
  }
}

export function createIndexManager(opts: IndexManagerOptions): IndexManagerLike {
  return new IndexManagerImpl(opts);
}
