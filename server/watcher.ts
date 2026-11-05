/**
 * Watches transcript roots for changes and feeds them into the indexer, incrementally.
 * Uses `fs.watch(root, { recursive: true })` (supported on macOS/Windows; Linux support
 * varies by kernel/filesystem — a root that errors on watch is logged and skipped rather
 * than crashing the server). Debounces per-file for a quiet period so an in-progress write
 * doesn't trigger a reparse mid-write.
 */
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { directoryExists } from './paths.js';

const QUIET_PERIOD_MS = 3_000;
const RELEVANT_SUFFIXES = ['.jsonl', '.meta.json', 'custom-title.json'];

export interface WatcherDeps {
  /** called once per settled file, batched by the quiet-period debounce */
  requestIncremental: (paths: string[]) => void;
  /** injectable for tests; defaults to console.warn/console.error without transcript content */
  log?: (message: string) => void;
}

export interface Watcher {
  dispose(): void;
}

function isRelevant(filename: string): boolean {
  return RELEVANT_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

/** Starts a watcher on each root; roots that don't exist are logged and skipped. */
export function startWatcher(roots: string[], deps: WatcherDeps): Watcher {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const watchers: FSWatcher[] = [];
  const pendingTimers = new Map<string, NodeJS.Timeout>();
  const settledBatch = new Set<string>();
  let flushTimer: NodeJS.Timeout | undefined;

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      if (settledBatch.size === 0) return;
      const paths = [...settledBatch];
      settledBatch.clear();
      deps.requestIncremental(paths);
    }, 50);
  }

  function onFileChanged(path: string): void {
    const existing = pendingTimers.get(path);
    if (existing) clearTimeout(existing);
    pendingTimers.set(
      path,
      setTimeout(() => {
        pendingTimers.delete(path);
        settledBatch.add(path);
        scheduleFlush();
      }, QUIET_PERIOD_MS),
    );
  }

  for (const root of roots) {
    if (!directoryExists(root)) {
      log(`watcher: root does not exist, skipping: ${root}`);
      continue;
    }
    try {
      const watcher = watch(root, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const name = filename.toString();
        if (!isRelevant(name) && !(name.endsWith('.json') && /(?:^|[/\\])(?:chatSessions|emptyWindowChatSessions)[/\\]/.test(join(root, name)))) return;
        onFileChanged(join(root, name));
      });
      watcher.on('error', (err) => {
        log(`watcher: error on root ${root}: ${err instanceof Error ? err.name : 'unknown error'}`);
      });
      watchers.push(watcher);
    } catch (err) {
      log(`watcher: failed to start on root ${root}: ${err instanceof Error ? err.name : 'unknown error'}`);
    }
  }

  return {
    dispose(): void {
      for (const timer of pendingTimers.values()) clearTimeout(timer);
      pendingTimers.clear();
      if (flushTimer) clearTimeout(flushTimer);
      for (const watcher of watchers) watcher.close();
    },
  };
}
