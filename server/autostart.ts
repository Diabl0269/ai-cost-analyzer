/**
 * `ai-cost-analyzer autostart enable|disable|status`: a macOS LaunchAgent that keeps the local
 * server running. Every side effect (launchctl, filesystem, HTTP probe) goes through an injected
 * `AutostartDeps`, so tests never touch the real launchd or the user's LaunchAgents directory.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUTOSTART_LABEL = 'com.ai-cost-analyzer.server';
const THROTTLE_SECONDS = 30;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

export interface AutostartDeps {
  platform: NodeJS.Platform;
  exec: ExecFn;
  /** Home directory used for `~/Library/...`. */
  homeDir: string;
  uid: number;
  nodePath: string;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  writeFile: (path: string, data: string, mode: number) => void;
  mkdir: (path: string, mode: number) => void;
  remove: (path: string) => void;
  exists: (path: string) => boolean;
  probe: (port: number) => Promise<boolean>;
  log: (line: string) => void;
}

export interface AutostartOptions {
  port: number;
  home?: string;
}

export interface PlistInput {
  nodePath: string;
  cliPath: string;
  port: number;
  env: Record<string, string>;
  logDir: string;
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Only variables the server actually reads; never the whole shell environment. */
export function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (value === undefined || value === '') continue;
    if (key.startsWith('CCA_') || key === 'CODEX_HOME' || key === 'COPILOT_HOME' || key === 'HOME') {
      out[key] = value;
    }
  }
  return out;
}

export function buildPlist(input: PlistInput): string {
  const args = [input.nodePath, input.cliPath, '--no-open', '--port', String(input.port)];
  const argXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  const envEntries = Object.entries(input.env);
  const envXml =
    envEntries.length === 0
      ? ''
      : `  <key>EnvironmentVariables</key>
  <dict>
${envEntries.map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`).join('\n')}
  </dict>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AUTOSTART_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
${envXml}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>${THROTTLE_SECONDS}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(input.logDir, 'server.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(input.logDir, 'server.err.log'))}</string>
</dict>
</plist>
`;
}

export function plistPath(homeDir: string): string {
  return join(homeDir, 'Library', 'LaunchAgents', `${AUTOSTART_LABEL}.plist`);
}
export function logDirPath(homeDir: string): string {
  return join(homeDir, 'Library', 'Logs', 'ai-cost-analyzer');
}

/**
 * True when something on the port answers like this app: `/api/status` is either readable (200 with
 * a `version`) or refused by our auth layer with a JSON `error.code`.
 */
export async function probeServer(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json()) as { version?: unknown; error?: { code?: unknown } };
    if (res.ok) return typeof body.version === 'string';
    return (res.status === 401 || res.status === 403) && typeof body.error?.code === 'string';
  } catch {
    return false;
  }
}

function realExec(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((done) => {
    execFile(cmd, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      done({ code, stdout, stderr });
    });
  });
}

export function defaultDeps(): AutostartDeps {
  return {
    platform: platform(),
    exec: realExec,
    homeDir: homedir(),
    uid: process.getuid?.() ?? 0,
    nodePath: process.execPath,
    cliPath: resolve(dirname(fileURLToPath(import.meta.url)), 'cli.js'),
    env: process.env,
    writeFile: (path, data, mode) => {
      writeFileSync(path, data, { mode });
      chmodSync(path, mode);
    },
    mkdir: (path, mode) => {
      mkdirSync(path, { recursive: true, mode });
      chmodSync(path, mode);
    },
    remove: (path) => rmSync(path, { force: true }),
    exists: existsSync,
    probe: (port) => probeServer(port),
    log: (line) => console.log(line),
  };
}

function domain(deps: AutostartDeps): string {
  return `gui/${deps.uid}`;
}
function target(deps: AutostartDeps): string {
  return `${domain(deps)}/${AUTOSTART_LABEL}`;
}

function requireDarwin(deps: AutostartDeps): void {
  if (deps.platform !== 'darwin') throw new Error('autostart is only supported on macOS (launchd)');
}

export async function enableAutostart(opts: AutostartOptions, deps: AutostartDeps): Promise<void> {
  requireDarwin(deps);
  const env = filterEnv(deps.env);
  if (opts.home) env.CCA_HOME = resolve(opts.home);
  // Port is passed as an argument; a stale CCA_PORT in the environment must not contradict it.
  delete env.CCA_PORT;
  env.HOME = env.HOME ?? deps.homeDir;
  const path = plistPath(deps.homeDir);
  const logDir = logDirPath(deps.homeDir);
  deps.mkdir(dirname(path), 0o755);
  deps.mkdir(logDir, 0o700);
  deps.writeFile(path, buildPlist({ nodePath: deps.nodePath, cliPath: deps.cliPath, port: opts.port, env, logDir }), 0o644);

  // Idempotent: unload any previous definition first; "not loaded" is not an error.
  await deps.exec('launchctl', ['bootout', target(deps)]);
  const boot = await deps.exec('launchctl', ['bootstrap', domain(deps), path]);
  if (boot.code !== 0) throw new Error(`launchctl bootstrap failed: ${boot.stderr.trim() || `exit ${boot.code}`}`);
  const kick = await deps.exec('launchctl', ['kickstart', '-k', target(deps)]);
  if (kick.code !== 0) throw new Error(`launchctl kickstart failed: ${kick.stderr.trim() || `exit ${kick.code}`}`);
  const deadline = Date.now() + 10_000;
  while (!(await deps.probe(opts.port)) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 250));
  }
  if (!(await deps.probe(opts.port))) {
    throw new Error(`server did not become ready on port ${opts.port}; check ${join(logDir, 'server.err.log')}`);
  }
  deps.log(`autostart enabled: http://127.0.0.1:${opts.port}`);
  deps.log(`logs: ${logDir}`);
}

export async function disableAutostart(deps: AutostartDeps): Promise<void> {
  requireDarwin(deps);
  await deps.exec('launchctl', ['bootout', target(deps)]);
  deps.remove(plistPath(deps.homeDir));
  deps.log('autostart disabled');
}

export interface AutostartStatus {
  installed: boolean;
  loaded: boolean;
  state?: string;
  pid?: number;
  responding: boolean;
}

export async function autostartStatus(opts: AutostartOptions, deps: AutostartDeps): Promise<AutostartStatus> {
  requireDarwin(deps);
  const installed = deps.exists(plistPath(deps.homeDir));
  const printed = await deps.exec('launchctl', ['print', target(deps)]);
  const loaded = printed.code === 0;
  const state = loaded ? /^\s*state = (\S+)/m.exec(printed.stdout)?.[1] : undefined;
  const pidText = loaded ? /^\s*pid = (\d+)/m.exec(printed.stdout)?.[1] : undefined;
  const responding = await deps.probe(opts.port);
  const status: AutostartStatus = {
    installed,
    loaded,
    responding,
    ...(state ? { state } : {}),
    ...(pidText ? { pid: Number(pidText) } : {}),
  };
  deps.log(`plist: ${installed ? 'installed' : 'not installed'}`);
  deps.log(`launchd: ${loaded ? `loaded (${state ?? 'unknown state'}${status.pid ? `, pid ${status.pid}` : ''})` : 'not loaded'}`);
  deps.log(`server: ${responding ? `responding on port ${opts.port}` : `not responding on port ${opts.port}`}`);
  return status;
}

export function parseAutostartArgs(argv: string[], env: NodeJS.ProcessEnv): { action: string; options: AutostartOptions } {
  const action = argv[0] ?? '';
  const options: AutostartOptions = { port: Number(env.CCA_PORT ?? 4141) };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--home') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error('invalid --home value');
      options.home = v;
    } else throw new Error(`unrecognized autostart flag: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) throw new Error('invalid --port value');
  return { action, options };
}

/** Entry point for `cli.ts`; `argv` excludes the leading `autostart`. */
export async function runAutostart(argv: string[], deps: AutostartDeps = defaultDeps()): Promise<void> {
  const { action, options } = parseAutostartArgs(argv, deps.env);
  if (action === 'enable') await enableAutostart(options, deps);
  else if (action === 'disable') await disableAutostart(deps);
  else if (action === 'status') await autostartStatus(options, deps);
  else throw new Error('usage: ai-cost-analyzer autostart enable|disable|status [--port N] [--home DIR]');
}
