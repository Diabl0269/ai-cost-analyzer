/**
 * `ai-cost-analyzer menubar build|install|uninstall|status`: an optional native macOS menu-bar app
 * (integrations/menubar/, Swift + AppKit, built with `swiftc`, no Xcode project). It is a thin
 * client of `GET /api/analytics/summary`; it does not manage the server's autostart. All effects go
 * through `MenubarDeps`, so tests never run swiftc/codesign or touch ~/Applications.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecFn } from './autostart.js';
import { probeServer } from './autostart.js';
import { readPackageVersion } from './version.js';

export const MENUBAR_LABEL = 'com.ai-cost-analyzer.menubar';
export const APP_NAME = 'AI Cost Analyzer.app';
export const EXECUTABLE = 'ai-cost-analyzer-menubar';
export const SWIFT_SOURCES = ['Format.swift', 'main.swift'];

export const SWIFTC_MISSING_MESSAGE =
  'swiftc was not found. The menu-bar app is built locally and needs the Xcode Command Line Tools: run `xcode-select --install`, then retry.';

export interface MenubarDeps {
  platform: NodeJS.Platform;
  exec: ExecFn;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  cliPath: string;
  /** Directory holding Format.swift, main.swift and Info.plist. */
  sourceDir: string;
  version: string;
  mkdir: (path: string) => void;
  writeFile: (path: string, data: string, mode?: number) => void;
  readFile: (path: string) => string;
  remove: (path: string) => void;
  exists: (path: string) => boolean;
  probe: (port: number) => Promise<boolean>;
  log: (line: string) => void;
}

export interface MenubarOptions {
  port: number;
}

export function installedAppPath(homeDir: string): string {
  return join(homeDir, 'Applications', APP_NAME);
}
export function buildDirPath(homeDir: string): string {
  return join(homeDir, 'Library', 'Caches', 'ai-cost-analyzer', 'menubar');
}
function executableOf(app: string): string {
  return join(app, 'Contents', 'MacOS', EXECUTABLE);
}

function realExec(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(cmd, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      done({ code, stdout, stderr });
    });
  });
}

export function defaultDeps(): MenubarDeps {
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    platform: platform(),
    exec: realExec,
    homeDir: homedir(),
    env: process.env,
    nodePath: process.execPath,
    cliPath: resolve(here, 'cli.js'),
    // dist/server/ -> ../../integrations/menubar (the same relative path works from server/ in the repo)
    sourceDir: resolve(here, '..', '..', 'integrations', 'menubar'),
    version: readPackageVersion(),
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    writeFile: (p, data, mode) => {
      writeFileSync(p, data, mode === undefined ? undefined : { mode });
      if (mode !== undefined) chmodSync(p, mode);
    },
    readFile: (p) => readFileSync(p, 'utf8'),
    remove: (p) => rmSync(p, { recursive: true, force: true }),
    exists: existsSync,
    probe: (port) => probeServer(port),
    log: (line) => console.log(line),
  };
}

function requireDarwin(deps: MenubarDeps): void {
  if (deps.platform !== 'darwin') throw new Error('menubar is only supported on macOS');
}

function fail(what: string, r: { code: number; stderr: string }): Error {
  return new Error(`${what} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
}

/** Compiles the sources into `<buildDir>/AI Cost Analyzer.app` and ad-hoc signs it. */
export async function buildMenubar(opts: MenubarOptions, deps: MenubarDeps): Promise<string> {
  requireDarwin(deps);
  const probe = await deps.exec('swiftc', ['--version']);
  if (probe.code !== 0) throw new Error(SWIFTC_MISSING_MESSAGE);
  for (const f of [...SWIFT_SOURCES, 'Info.plist']) {
    if (!deps.exists(join(deps.sourceDir, f))) throw new Error(`menu-bar source missing: ${join(deps.sourceDir, f)}`);
  }
  const app = join(buildDirPath(deps.homeDir), APP_NAME);
  const macos = join(app, 'Contents', 'MacOS');
  const resources = join(app, 'Contents', 'Resources');
  deps.remove(app);
  deps.mkdir(macos);
  deps.mkdir(resources);
  const compile = await deps.exec('swiftc', [
    '-O',
    '-o',
    executableOf(app),
    ...SWIFT_SOURCES.map((f) => join(deps.sourceDir, f)),
  ]);
  if (compile.code !== 0) throw fail('swiftc', compile);
  const plist = deps.readFile(join(deps.sourceDir, 'Info.plist')).replace(/__VERSION__/g, deps.version);
  deps.writeFile(join(app, 'Contents', 'Info.plist'), plist);
  // The app is launched from Finder/launchd without our environment, so bake in how to reach us.
  const config = { port: opts.port, node: deps.nodePath, cli: deps.cliPath };
  deps.writeFile(join(resources, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const sign = await deps.exec('codesign', ['--force', '--sign', '-', app]);
  if (sign.code !== 0) throw fail('codesign', sign);
  deps.log(`built ${app}`);
  return app;
}

async function quitRunning(deps: MenubarDeps): Promise<void> {
  await deps.exec('pkill', ['-x', EXECUTABLE]); // exit 1 = not running
}

export async function installMenubar(opts: MenubarOptions, deps: MenubarDeps): Promise<void> {
  const built = await buildMenubar(opts, deps);
  const dest = installedAppPath(deps.homeDir);
  await quitRunning(deps);
  deps.mkdir(dirname(dest));
  deps.remove(dest);
  const copy = await deps.exec('ditto', [built, dest]);
  if (copy.code !== 0) throw fail('ditto', copy);
  const open = await deps.exec('open', [dest]);
  if (open.code !== 0) throw fail('open', open);
  deps.log(`installed ${dest}`);
  deps.log('enable launch at login from the app menu, or: ai-cost-analyzer menubar login enable');
}

export async function uninstallMenubar(deps: MenubarDeps): Promise<void> {
  requireDarwin(deps);
  const dest = installedAppPath(deps.homeDir);
  if (deps.exists(executableOf(dest))) await deps.exec(executableOf(dest), ['--login', 'disable']);
  await quitRunning(deps);
  deps.remove(dest);
  deps.remove(buildDirPath(deps.homeDir));
  deps.log('menu-bar app uninstalled');
}

export async function loginMenubar(action: string, deps: MenubarDeps): Promise<void> {
  requireDarwin(deps);
  if (action !== 'enable' && action !== 'disable' && action !== 'status') {
    throw new Error('usage: ai-cost-analyzer menubar login enable|disable|status');
  }
  const exe = executableOf(installedAppPath(deps.homeDir));
  if (!deps.exists(exe)) throw new Error('menu-bar app is not installed; run `ai-cost-analyzer menubar install`');
  const r = await deps.exec(exe, ['--login', action]);
  if (r.code !== 0) throw fail('login', r);
  deps.log(r.stdout.trim());
}

export interface MenubarStatus {
  installed: boolean;
  running: boolean;
  login: boolean;
  serverResponding: boolean;
}

export async function menubarStatus(opts: MenubarOptions, deps: MenubarDeps): Promise<MenubarStatus> {
  requireDarwin(deps);
  const exe = executableOf(installedAppPath(deps.homeDir));
  const installed = deps.exists(exe);
  const running = (await deps.exec('pgrep', ['-x', EXECUTABLE])).code === 0;
  const loginOut = installed ? (await deps.exec(exe, ['--login', 'status'])).stdout : '';
  const login = /: enabled/.test(loginOut);
  const serverResponding = await deps.probe(opts.port);
  deps.log(`app: ${installed ? 'installed' : 'not installed'}${installed ? ` (${installedAppPath(deps.homeDir)})` : ''}`);
  deps.log(`process: ${running ? 'running' : 'not running'}`);
  deps.log(`launch at login: ${login ? 'enabled' : 'disabled'}`);
  deps.log(`server: ${serverResponding ? `responding on port ${opts.port}` : `not responding on port ${opts.port}`}`);
  return { installed, running, login, serverResponding };
}

export function parseMenubarArgs(argv: string[], env: NodeJS.ProcessEnv): { action: string; rest: string[]; options: MenubarOptions } {
  const action = argv[0] ?? '';
  const options: MenubarOptions = { port: Number(env.CCA_PORT ?? 4141) };
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg.startsWith('--')) throw new Error(`unrecognized menubar flag: ${arg}`);
    else rest.push(arg);
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) throw new Error('invalid --port value');
  return { action, rest, options };
}

/** Entry point for `cli.ts`; `argv` excludes the leading `menubar`. */
export async function runMenubar(argv: string[], deps: MenubarDeps = defaultDeps()): Promise<void> {
  const { action, rest, options } = parseMenubarArgs(argv, deps.env);
  if (action === 'build') await buildMenubar(options, deps);
  else if (action === 'install') await installMenubar(options, deps);
  else if (action === 'uninstall') await uninstallMenubar(deps);
  else if (action === 'status') await menubarStatus(options, deps);
  else if (action === 'login') await loginMenubar(rest[0] ?? '', deps);
  else throw new Error('usage: ai-cost-analyzer menubar build|install|uninstall|status|login [--port N]');
}
