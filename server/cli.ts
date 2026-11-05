#!/usr/bin/env node
/**
 * `claude-cost-analyzer` CLI: starts the server (default) or runs a one-shot full reindex
 * (`--reindex`) and exits. The `node:sqlite` `ExperimentalWarning` is filtered by the first
 * import below; every other process warning still prints normally.
 */
// Must be the first import: it installs the `node:sqlite` warning filter before any module
// below pulls `node:sqlite` in and triggers the warning. See server/warnings.ts.
import './warnings.js';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runIndex } from '../core/db/indexer.js';
import { FTS5_REQUIRED_MESSAGE, SqliteFeatureError } from '../core/db/schema.js';
import { generateDemoData } from '../core/demo/generate.js';
import type { IndexProgress } from '../core/types.js';
import { ConfigStore } from './config.js';
import type { Flags } from './cli-flags.js';
import { parseFlags } from './cli-flags.js';
import { ensureHomeDir, resolvePaths, resolveRoots } from './paths.js';
import { startServer } from './index.js';
import { readPackageVersion } from './version.js';

/**
 * `--demo`: serves the synthetic demo dataset (core/demo/generate.ts) instead of the user's real
 * transcripts, so the app can be tried or screenshotted without ever touching `~/.claude`. Lands
 * entirely under `<CCA_HOME>/demo/` — `projects/` for the generated transcripts, `home/` for the
 * demo run's own DB and config — so it never shares a database with, or overwrites, the user's
 * real index. Generation is skipped if `<CCA_HOME>/demo/projects` already exists; delete it (or
 * point `--home`/`CCA_HOME` elsewhere) to regenerate with a different `--seed`/`--sessions`.
 */
async function resolveDemoDirs(flags: Flags): Promise<{ claudeDir: string; home: string }> {
  const base = resolvePaths({ home: flags.home });
  const demoRoot = join(base.home, 'demo');
  const claudeDir = join(demoRoot, 'projects');
  const home = join(demoRoot, 'home');
  if (!existsSync(claudeDir)) {
    const summary = await generateDemoData({
      outDir: demoRoot,
      ...(flags.demoSeed !== undefined ? { seed: flags.demoSeed } : {}),
      ...(flags.demoSessions !== undefined ? { sessions: flags.demoSessions } : {}),
    });
    console.log(`generated demo dataset: ${summary.sessions} sessions, ${summary.projects} projects, at ${demoRoot}`);
  }
  console.log(`serving the synthetic demo dataset from ${claudeDir} — your real transcripts are not read`);
  return { claudeDir, home };
}

async function runReindexAndExit(flags: Flags): Promise<void> {
  const paths = resolvePaths({ home: flags.home });
  ensureHomeDir(paths.home);
  const config = ConfigStore.load(paths.configPath);
  const roots = resolveRoots({ settingsRoots: config.get().settings.roots, claudeDirFlag: flags.claudeDir, codexDirFlag: flags.codexDir });

  const result = await runIndex({
    roots,
    dbPath: paths.dbPath,
    full: true,
    pricing: config.get().pricing,
    onProgress: (progress: IndexProgress) => {
      process.stdout.write(`\rindexing: ${progress.filesDone}/${progress.filesTotal} files (${progress.phase})`);
    },
  });
  process.stdout.write('\n');
  console.log(
    `reindexed ${result.sessionsIndexed} sessions (${result.filesSeen} files, ${result.parseErrors} parse errors) in ${result.durationMs}ms`,
  );
}

function openBrowser(url: string): void {
  if (platform() !== 'darwin') return;
  spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2), process.env);

  if (flags.reindex) {
    await runReindexAndExit(flags);
    return;
  }

  const demoDirs = flags.demo ? await resolveDemoDirs(flags) : undefined;

  const server = await startServer({
    port: flags.port,
    dev: process.env.CCA_DEV === '1',
    version: process.env.npm_package_version ?? readPackageVersion(import.meta.url),
    home: demoDirs?.home ?? flags.home,
    claudeDirFlag: demoDirs?.claudeDir ?? flags.claudeDir,
    codexDirFlag: demoDirs ? '' : flags.codexDir,
  });

  console.log(`AI Cost Analyzer: ${server.url}`);
  if (flags.open) openBrowser(server.url);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      // A second Ctrl-C means "I don't care about a clean shutdown anymore" — exit right away
      // instead of making the user wait out the fallback timer below.
      console.log('received second signal, forcing exit');
      process.exit(0);
    }
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    // Belt-and-suspenders: `server.close()` above is expected to resolve in well under a second
    // (SSE streams end themselves, then remaining connections are force-closed), but if some
    // unforeseen handle keeps the process alive anyway, don't hang forever — exit clean after a
    // short grace period. `unref()` so this timer itself never keeps the process alive.
    const fallback = setTimeout(() => process.exit(0), 3_000);
    fallback.unref();
    void server.close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error('error during shutdown', err instanceof Error ? err.message : err);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  if (err instanceof SqliteFeatureError) {
    // A wrong Node build is the single most common way this tool fails to start; say so in one
    // sentence with the fix, not a stack trace.
    console.error(FTS5_REQUIRED_MESSAGE);
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : 'fatal startup error');
  process.exit(1);
});
