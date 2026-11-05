/**
 * Wires the real dependencies (DB-backed Store, on-disk ConfigStore, worker-thread indexer,
 * SSE hub) and starts the HTTP server on 127.0.0.1. Used by `server/cli.ts`; kept separate so
 * tests can exercise `createApp` without ever calling `startServer`.
 */
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { createStore } from '../core/db/store.js';
import { createApp } from './app.js';
import { ConfigStore } from './config.js';
import type { AppDeps } from './deps.js';
import { createIndexManager } from './indexing.js';
import { ensureHomeDir, resolvePaths, resolveRoots } from './paths.js';
import { createSseHub } from './sse.js';
import { createShutdown } from './shutdown.js';
import { startWatcher, type Watcher } from './watcher.js';

export interface StartServerOptions {
  port: number;
  dev: boolean;
  version: string;
  /** CCA_HOME override (already resolved, absolute) */
  home?: string;
  /** --claude-dir flag override */
  claudeDirFlag?: string;
  codexDirFlag?: string;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const paths = resolvePaths({ home: opts.home });
  ensureHomeDir(paths.home);

  const config = ConfigStore.load(paths.configPath);
  const roots = resolveRoots({ settingsRoots: config.get().settings.roots, claudeDirFlag: opts.claudeDirFlag, codexDirFlag: opts.codexDirFlag });

  const store = createStore(paths.dbPath);
  const sse = createSseHub();
  const index = createIndexManager({
    roots,
    dbPath: paths.dbPath,
    broadcast: (event) => sse.broadcast(event),
    pricing: () => config.get().pricing,
    onRunComplete: (mode) => {
      // A full rebuild drops and recreates every table from the worker's own connection; the
      // reader here must start from a fresh handle or it queries objects that no longer exist.
      if (mode === 'full') store.reopen();
    },
  });

  const deps: AppDeps = {
    store,
    config,
    index,
    sse,
    roots,
    port: opts.port,
    dev: opts.dev,
    version: opts.version,
    ccaHome: paths.home,
  };
  const app = createApp(deps);

  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: opts.port }, () => resolve(s));
  });

  index.requestRescan();
  const watcher: Watcher = startWatcher(roots, {
    requestIncremental: (paths_) => index.requestIncremental(paths_),
  });

  const url = `http://127.0.0.1:${opts.port}/`;

  return {
    url,
    close: createShutdown({ watcher, index, sse, store, server }),
  };
}
