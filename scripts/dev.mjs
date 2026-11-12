#!/usr/bin/env node
/**
 * Dev orchestrator: runs the Hono server (Node's own `--watch`, restarting on file changes,
 * with tsx registered as an ESM loader) and the Vite dev server (proxying `/api` to the Hono
 * server) side by side, prefixing each line of output so it's clear which process said what.
 * Exits as soon as either child dies, and forwards Ctrl-C to both.
 *
 * Why `node --watch --import tsx/esm` rather than `tsx watch`: the `tsx` CLI opens a unix
 * domain socket to talk to its child, which sandboxed shells refuse (`EPERM`). `tsx/esm` is the
 * loader half only — same TypeScript support, no IPC — and it is the same loader
 * `server/indexing.ts` hands the indexing worker in dev.
 */
import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// PATH can shadow nvm's selection for both npm and its scripts.
const selectedNode = process.env.NVM_BIN
  ? join(process.env.NVM_BIN, 'node')
  : process.env.npm_node_execpath;
if (selectedNode && realpathSync(selectedNode) !== realpathSync(process.execPath)) {
  const result = spawnSync(selectedNode, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) console.error(`[dev] could not start selected Node executable: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (!(major === 22 && minor >= 13 || major >= 24)) {
  console.error(`[dev] Node ${process.versions.node} is unsupported. Use Node 22 LTS (run "nvm use" in this shell), then run "npm run dev" again. Node 23's SQLite lacks FTS5.`);
  process.exit(1);
}

const RESET = '\x1b[0m';
const server = {
  name: 'server',
  color: '\x1b[36m', // cyan
  command: process.execPath,
  args: ['--watch', '--watch-preserve-output', '--import', 'tsx/esm', 'server/cli.ts', '--no-open'],
  env: { ...process.env, CCA_DEV: '1' },
};
const web = {
  name: 'web',
  color: '\x1b[35m', // magenta
  command: process.execPath,
  args: ['node_modules/vite/bin/vite.js'],
  env: process.env,
};

function prefixLines(label, color, chunk, stream) {
  const text = chunk.toString('utf8');
  const lines = text.split('\n');
  // last element is either '' (trailing newline) or a partial line; either way printing it as-is
  // keeps behavior simple for a dev-only tool.
  for (const line of lines) {
    if (line.length === 0) continue;
    stream.write(`${color}[${label}]${RESET} ${line}\n`);
  }
}

function startChild(spec) {
  const child = spawn(spec.command, spec.args, { env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => prefixLines(spec.name, spec.color, chunk, process.stdout));
  child.stderr.on('data', (chunk) => prefixLines(spec.name, spec.color, chunk, process.stderr));
  child.on('error', (error) => {
    console.error(`[dev] could not start ${spec.name}: ${error.message}`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (exiting) return;
    console.error(`[dev] ${spec.name} exited (${signal ?? code}); stopping development servers`);
    shutdown(code === 0 ? 0 : code ?? 1);
  });
  return child;
}

const children = [];
let exiting = false;
let startupTimer;
function shutdown(code) {
  if (exiting) return;
  exiting = true;
  clearTimeout(startupTimer);
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exitCode = code;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Node's watch process stays alive even when its application fails to start.
// Wait for the CLI's listening notice instead of serving a UI with a dead API.
const serverProc = startChild(server);
children.push(serverProc);
let startupOutput = '';
function onServerOutput(chunk) {
  startupOutput += chunk.toString('utf8');
  if (!startupOutput.includes('AI Cost Analyzer: http://127.0.0.1:')) return;
  serverProc.stdout.off('data', onServerOutput);
  clearTimeout(startupTimer);
  if (!exiting) children.push(startChild(web));
}
serverProc.stdout.on('data', onServerOutput);
startupTimer = setTimeout(() => {
  console.error('[dev] API server did not start within 30 seconds; see [server] output above. Stopping development servers.');
  shutdown(1);
}, 30_000);
