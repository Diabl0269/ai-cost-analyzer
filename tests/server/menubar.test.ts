import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SWIFTC_MISSING_MESSAGE,
  buildMenubar,
  installMenubar,
  installedAppPath,
  loginMenubar,
  menubarStatus,
  parseMenubarArgs,
  runMenubar,
  uninstallMenubar,
  type MenubarDeps,
} from '../../server/menubar.js';

function makeDeps(over: Partial<MenubarDeps> = {}, fail: Record<string, number> = {}) {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const removed: string[] = [];
  const logs: string[] = [];
  const deps: MenubarDeps = {
    platform: 'darwin',
    exec: async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`.trim());
      const code = fail[cmd] ?? 0;
      return { code, stdout: args[0] === '--login' ? 'login item: enabled' : '', stderr: code ? 'boom' : '' };
    },
    homeDir: '/Users/dev',
    env: {},
    nodePath: '/opt/node/bin/node',
    cliPath: '/opt/app/dist/server/cli.js',
    sourceDir: '/opt/app/integrations/menubar',
    version: '1.2.3',
    mkdir: () => {},
    writeFile: (p, d) => void files.set(p, d),
    readFile: () => '<string>__VERSION__</string>',
    remove: (p) => void removed.push(p),
    exists: () => true,
    probe: async () => true,
    log: (l) => void logs.push(l),
    ...over,
  };
  return { deps, calls, files, removed, logs };
}

describe('menubar', () => {
  it('refuses on non-darwin before running anything', async () => {
    const { deps, calls } = makeDeps({ platform: 'linux' });
    for (const run of [
      () => buildMenubar({ port: 4141 }, deps),
      () => installMenubar({ port: 4141 }, deps),
      () => uninstallMenubar(deps),
      () => menubarStatus({ port: 4141 }, deps),
    ]) {
      await expect(run()).rejects.toThrow(/only supported on macOS/);
    }
    expect(calls).toEqual([]);
  });

  it('explains a missing swiftc', async () => {
    const { deps, calls } = makeDeps({}, { swiftc: 1 });
    await expect(buildMenubar({ port: 4141 }, deps)).rejects.toThrow(SWIFTC_MISSING_MESSAGE);
    expect(SWIFTC_MISSING_MESSAGE).toMatch(/xcode-select --install/);
    expect(calls).toEqual(['swiftc --version']);
  });

  it('builds: compile, Info.plist with version, config.json, ad-hoc codesign', async () => {
    const { deps, calls, files } = makeDeps();
    const app = await buildMenubar({ port: 4150 }, deps);
    expect(app).toBe('/Users/dev/Library/Caches/ai-cost-analyzer/menubar/AI Cost Analyzer.app');
    expect(calls[1]).toMatch(/^swiftc -O -o .*Contents\/MacOS\/ai-cost-analyzer-menubar .*Format\.swift .*main\.swift$/);
    expect(calls[2]).toBe(`codesign --force --sign - ${app}`);
    expect(files.get(`${app}/Contents/Info.plist`)).toBe('<string>1.2.3</string>');
    expect(JSON.parse(files.get(`${app}/Contents/Resources/config.json`)!)).toEqual({
      port: 4150,
      node: '/opt/node/bin/node',
      cli: '/opt/app/dist/server/cli.js',
    });
  });

  it('reports swiftc compile errors and a missing source', async () => {
    await expect(buildMenubar({ port: 1 }, makeDeps({}, { codesign: 1 }).deps)).rejects.toThrow(/codesign failed: boom/);
    const bad = makeDeps({ exists: () => false });
    await expect(buildMenubar({ port: 1 }, bad.deps)).rejects.toThrow(/source missing/);
  });

  it('installs into ~/Applications and opens it', async () => {
    const { deps, calls, removed } = makeDeps();
    await installMenubar({ port: 4141 }, deps);
    const dest = installedAppPath('/Users/dev');
    expect(dest).toBe('/Users/dev/Applications/AI Cost Analyzer.app');
    expect(calls.slice(-3)).toEqual([
      'pkill -x ai-cost-analyzer-menubar',
      expect.stringMatching(/^ditto .*AI Cost Analyzer\.app \/Users\/dev\/Applications\/AI Cost Analyzer\.app$/),
      `open ${dest}`,
    ]);
    expect(calls.some((c) => c === `open ${dest}`)).toBe(true);
    expect(removed).toContain(dest);
  });

  it('uninstalls: disables login item, quits, removes the app', async () => {
    const { deps, calls, removed } = makeDeps();
    await uninstallMenubar(deps);
    const dest = installedAppPath('/Users/dev');
    expect(calls).toEqual([
      `${dest}/Contents/MacOS/ai-cost-analyzer-menubar --login disable`,
      'pkill -x ai-cost-analyzer-menubar',
    ]);
    expect(removed[0]).toBe(dest);
  });

  it('status and login', async () => {
    const { deps, logs } = makeDeps();
    expect(await menubarStatus({ port: 4141 }, deps)).toEqual({ installed: true, running: true, login: true, serverResponding: true });
    expect(logs).toContain('launch at login: enabled');
    await loginMenubar('enable', deps);
    await expect(loginMenubar('nope', deps)).rejects.toThrow(/usage/);
    await expect(loginMenubar('enable', makeDeps({ exists: () => false }).deps)).rejects.toThrow(/not installed/);
  });

  it('parses args and routes', async () => {
    expect(parseMenubarArgs(['install', '--port', '4150'], {}).options.port).toBe(4150);
    expect(parseMenubarArgs(['build'], { CCA_PORT: '4200' }).options.port).toBe(4200);
    expect(() => parseMenubarArgs(['build', '--bogus'], {})).toThrow(/unrecognized/);
    await expect(runMenubar(['wat'], makeDeps().deps)).rejects.toThrow(/usage/);
  });
});

function hasSwiftc(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('swiftc', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasSwiftc())('menubar Swift formatter', () => {
  it('passes its self-test', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cca-menubar-'));
    try {
      const src = resolve(__dirname, '../../integrations/menubar');
      const bin = join(dir, 'fmt-test');
      execFileSync('swiftc', ['-o', bin, join(src, 'Format.swift'), join(src, 'tests', 'main.swift')], {
        env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(dir, 'mc') },
      });
      expect(execFileSync(bin, { encoding: 'utf8' }).trim()).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
