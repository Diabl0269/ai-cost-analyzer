import { describe, expect, it } from 'vitest';
import {
  AUTOSTART_LABEL,
  autostartStatus,
  buildPlist,
  disableAutostart,
  enableAutostart,
  filterEnv,
  parseAutostartArgs,
  plistPath,
  runAutostart,
  xmlEscape,
  type AutostartDeps,
  type ExecResult,
} from '../../server/autostart.js';

function makeDeps(over: Partial<AutostartDeps> = {}, execResults: Record<string, ExecResult> = {}) {
  const calls: string[] = [];
  const files = new Map<string, { data: string; mode: number }>();
  const dirs: Array<[string, number]> = [];
  const logs: string[] = [];
  const deps: AutostartDeps = {
    platform: 'darwin',
    exec: async (cmd, args) => {
      const line = `${cmd} ${args.join(' ')}`;
      calls.push(line);
      return execResults[args[0]!] ?? { code: 0, stdout: '', stderr: '' };
    },
    homeDir: '/Users/dev',
    uid: 501,
    nodePath: '/opt/node 22/bin/node',
    cliPath: '/opt/app/dist/server/cli.js',
    env: { HOME: '/Users/dev', PATH: '/bin', SECRET_TOKEN: 'x', CCA_CLAUDE_DIR: '/c&d', CODEX_HOME: '/cx', CCA_PORT: '9' },
    writeFile: (p, data, mode) => void files.set(p, { data, mode }),
    mkdir: (p, mode) => void dirs.push([p, mode]),
    remove: (p) => void files.delete(p),
    exists: (p) => files.has(p),
    probe: async () => true,
    log: (l) => void logs.push(l),
    ...over,
  };
  return { deps, calls, files, dirs, logs };
}

describe('plist', () => {
  it('escapes XML', () => {
    expect(xmlEscape(`a&b<c>"d"'e'`)).toBe('a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;');
  });

  it('builds a plist with absolute args, env and logs', () => {
    const plist = buildPlist({
      nodePath: '/opt/n&n/node',
      cliPath: '/opt/cli.js',
      port: 4141,
      env: { CCA_HOME: '/h<1>' },
      logDir: '/Users/dev/Library/Logs/ai-cost-analyzer',
    });
    expect(plist).toContain(`<string>${AUTOSTART_LABEL}</string>`);
    expect(plist).toContain('<string>/opt/n&amp;n/node</string>');
    expect(plist).toContain('<string>--no-open</string>');
    expect(plist).toContain('<string>4141</string>');
    expect(plist).toContain('<key>CCA_HOME</key>\n    <string>/h&lt;1&gt;</string>');
    expect(plist).toContain('<key>SuccessfulExit</key>\n    <false/>');
    expect(plist).toContain('<integer>30</integer>');
    expect(plist).toContain('server.err.log');
  });

  it('keeps only supported env vars', () => {
    expect(filterEnv({ HOME: '/h', PATH: '/bin', SECRET_TOKEN: 'x', CCA_A: '1', COPILOT_HOME: '/c', CODEX_HOME: '' })).toEqual({
      CCA_A: '1',
      COPILOT_HOME: '/c',
      HOME: '/h',
    });
  });
});

describe('enable / disable / status', () => {
  it('enable writes the plist and runs launchctl in order', async () => {
    const { deps, calls, files, dirs } = makeDeps();
    await enableAutostart({ port: 4200, home: '/data' }, deps);
    const path = plistPath('/Users/dev');
    expect(files.get(path)?.mode).toBe(0o644);
    const data = files.get(path)!.data;
    expect(data).toContain('<string>4200</string>');
    expect(data).toContain('<key>CCA_HOME</key>\n    <string>/data</string>');
    expect(data).toContain('/c&amp;d');
    expect(data).not.toContain('SECRET_TOKEN');
    expect(data).not.toContain('<key>CCA_PORT</key>');
    expect(dirs).toContainEqual(['/Users/dev/Library/Logs/ai-cost-analyzer', 0o700]);
    expect(calls).toEqual([
      `launchctl bootout gui/501/${AUTOSTART_LABEL}`,
      `launchctl bootstrap gui/501 ${path}`,
      `launchctl kickstart -k gui/501/${AUTOSTART_LABEL}`,
    ]);
  });

  it('enable is idempotent', async () => {
    const { deps, calls, files } = makeDeps({}, { bootout: { code: 113, stdout: '', stderr: 'not loaded' } });
    await enableAutostart({ port: 4141 }, deps);
    const first = files.get(plistPath('/Users/dev'))!.data;
    await enableAutostart({ port: 4141 }, deps);
    expect(files.get(plistPath('/Users/dev'))!.data).toBe(first);
    expect(calls.filter((c) => c.includes('bootstrap'))).toHaveLength(2);
  });

  it('enable surfaces a bootstrap failure', async () => {
    const { deps } = makeDeps({}, { bootstrap: { code: 5, stdout: '', stderr: 'Input/output error' } });
    await expect(enableAutostart({ port: 4141 }, deps)).rejects.toThrow(/bootstrap failed: Input\/output error/);
  });

  it('enable waits for readiness and fails clearly when the server never starts', async () => {
    const { deps } = makeDeps({ probe: async () => false });
    await expect(enableAutostart({ port: 4141 }, deps)).rejects.toThrow(
      'server did not become ready on port 4141; check /Users/dev/Library/Logs/ai-cost-analyzer/server.err.log',
    );
  }, 15_000);

  it('disable boots out and deletes the plist', async () => {
    const { deps, calls, files } = makeDeps();
    await enableAutostart({ port: 4141 }, deps);
    calls.length = 0;
    await disableAutostart(deps);
    expect(calls).toEqual([`launchctl bootout gui/501/${AUTOSTART_LABEL}`]);
    expect(files.size).toBe(0);
  });

  it('status parses launchctl print and probes', async () => {
    const { deps, calls } = makeDeps({}, { print: { code: 0, stdout: `x = {\n\tstate = running\n\tpid = 777\n}`, stderr: '' } });
    const s = await autostartStatus({ port: 4141 }, deps);
    expect(s).toEqual({ installed: false, loaded: true, state: 'running', pid: 777, responding: true });
    expect(calls).toEqual([`launchctl print gui/501/${AUTOSTART_LABEL}`]);
  });

  it('status reports not loaded', async () => {
    const { deps } = makeDeps({ probe: async () => false }, { print: { code: 113, stdout: '', stderr: '' } });
    const s = await autostartStatus({ port: 4141 }, deps);
    expect(s).toEqual({ installed: false, loaded: false, responding: false });
  });

  it('refuses on non-darwin without running anything', async () => {
    const { deps, calls } = makeDeps({ platform: 'linux' });
    await expect(runAutostart(['enable'], deps)).rejects.toThrow(/only supported on macOS/);
    await expect(runAutostart(['disable'], deps)).rejects.toThrow(/macOS/);
    await expect(runAutostart(['status'], deps)).rejects.toThrow(/macOS/);
    expect(calls).toEqual([]);
  });
});

describe('parseAutostartArgs', () => {
  it('parses flags and validates', () => {
    expect(parseAutostartArgs(['enable', '--port', '5000', '--home', '/h'], {})).toEqual({
      action: 'enable',
      options: { port: 5000, home: '/h' },
    });
    expect(parseAutostartArgs(['status'], { CCA_PORT: '4300' }).options.port).toBe(4300);
    expect(() => parseAutostartArgs(['enable', '--port', 'x'], {})).toThrow(/invalid --port/);
    expect(() => parseAutostartArgs(['enable', '--bogus'], {})).toThrow(/unrecognized/);
  });

  it('rejects unknown actions', async () => {
    const { deps } = makeDeps();
    await expect(runAutostart(['nope'], deps)).rejects.toThrow(/usage/);
  });
});
