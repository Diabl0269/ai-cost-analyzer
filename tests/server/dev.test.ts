import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'scripts/dev.mjs');
const directories: string[] = [];
const processes: ChildProcess[] = [];

afterEach(() => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function run(args: string[], cwd = root, env: NodeJS.ProcessEnv = { ...process.env, NVM_BIN: '', npm_node_execpath: '' }) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(child);
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

function fixture(server: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'cca-dev-'));
  directories.push(directory);
  mkdirSync(join(directory, 'server'));
  mkdirSync(join(directory, 'node_modules/vite/bin'), { recursive: true });
  symlinkSync(join(root, 'node_modules/tsx'), join(directory, 'node_modules/tsx'), 'dir');
  writeFileSync(join(directory, 'server/cli.ts'), server);
  writeFileSync(join(directory, 'node_modules/vite/bin/vite.js'), `
    const { existsSync } = require('node:fs');
    console.log(existsSync('api-ready') ? 'WEB_STARTED_AFTER_API' : 'WEB_STARTED_TOO_EARLY');
    process.exit(7);
  `);
  return directory;
}

describe('dev runner', () => {
  it.each(['npm', 'nvm'])('uses %s selection when PATH resolves a different runtime', async (selection) => {
    const directory = fixture(`
      import { writeFileSync } from 'node:fs';
      writeFileSync('api-ready', '');
      console.log('AI Cost Analyzer: http://127.0.0.1:4141/');
      setInterval(() => {}, 1000);
    `);
    const result = await run([
      '--input-type=module',
      '--eval',
      `Object.defineProperty(process.versions, 'node', { value: '23.11.0' });
       Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(root)} });
       await import(${JSON.stringify(script)});`,
    ], directory, {
      ...process.env,
      NVM_BIN: selection === 'nvm' ? dirname(process.execPath) : '',
      npm_node_execpath: selection === 'npm' ? process.execPath : root,
    });
    expect(result.code).toBe(7);
    expect(result.output).toContain('WEB_STARTED_AFTER_API');
    expect(result.output).not.toContain('unsupported');
  });

  it.each(['20.19.0', '22.12.0', '23.11.0'])('rejects Node %s before starting either server', async (version) => {
    const result = await run([
      '--input-type=module',
      '--eval',
      `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} }); await import(${JSON.stringify(script)});`,
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`Node ${version} is unsupported`);
    expect(result.output).toContain('nvm use');
    expect(result.output).not.toContain('[web]');
    expect(result.output).not.toContain('[server]');
  });

  it('starts Vite only after the API listening notice and preserves a child failure exit code', async () => {
    const directory = fixture(`
      import { writeFileSync } from 'node:fs';
      setTimeout(() => {
        writeFileSync('api-ready', '');
        process.stdout.write('AI Cost Analyzer: http://127.');
        setTimeout(() => process.stdout.write('0.0.1:4141/\\n'), 50);
      }, 200);
      setInterval(() => {}, 1000);
    `);
    const result = await run([script], directory);
    expect(result.code).toBe(7);
    expect(result.output).toContain('WEB_STARTED_AFTER_API');
    expect(result.output).not.toContain('WEB_STARTED_TOO_EARLY');
    expect(result.output).toContain('web exited (7)');
  });

  it('stops the watch process without starting Vite when API startup fails', async () => {
    const directory = fixture(`
      console.error('SYNTHETIC_API_STARTUP_FAILURE');
      process.exit(1);
    `);
    const result = await run([script], directory);
    expect(result.code).toBe(1);
    expect(result.output).toContain('SYNTHETIC_API_STARTUP_FAILURE');
    expect(result.output).toContain('API server did not start within 30 seconds');
    expect(result.output).not.toContain('[web]');
  }, 40_000);
});
