import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { resolveRoots } from '../../server/paths.js';
import { parseFlags } from '../../server/cli-flags.js';
import { ConfigStore } from '../../server/config.js';
import { defaultPricing } from '../../core/pricing/defaults.js';
import { defaultSettings } from '../../core/settings.js';
import { validateRoots } from '../../server/rootsPolicy.js';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe('transcript source selection', () => {
  it('defaults to both transcript providers without selecting credential roots', () => {
    expect(resolveRoots({ env: {} })).toEqual([
      join(homedir(), '.claude/projects'), join(homedir(), '.codex/sessions'),
      join(homedir(), '.codex/archived_sessions'),
    ]);
    expect(resolveRoots({ env: { CODEX_HOME: '/synthetic/codex' } })).toEqual([
      join(homedir(), '.claude/projects'), '/synthetic/codex/sessions', '/synthetic/codex/archived_sessions',
    ]);
    expect(resolveRoots({ settingsRoots: defaultSettings().roots, env: { CODEX_HOME: '/synthetic/codex' } })).toContain('/synthetic/codex/sessions');
  });
  it('keeps custom and explicit Claude fixture roots isolated', () => {
    expect(resolveRoots({ claudeDirFlag: '/synthetic/claude', env: {} })).toEqual(['/synthetic/claude']);
    expect(resolveRoots({ settingsRoots: ['/synthetic/fixture'], env: {} })).toEqual(['/synthetic/fixture']);
  });
  it('combines explicitly selected providers and supports a direct Codex sessions root', () => {
    expect(resolveRoots({ claudeDirFlag: '/synthetic/claude', codexDirFlag: '/synthetic/codex', env: {} })).toEqual([
      '/synthetic/claude', '/synthetic/codex/sessions', '/synthetic/codex/archived_sessions',
    ]);
    expect(resolveRoots({ env: { CCA_CODEX_DIR: '/synthetic/sessions' } })).toEqual(['/synthetic/sessions']);
    expect(resolveRoots({ env: { CCA_CODEX_DIR: '/synthetic/archived_sessions' } })).toEqual(['/synthetic/archived_sessions']);
    expect(resolveRoots({ claudeDirFlag: '/synthetic/demo', codexDirFlag: '', env: { CCA_CODEX_DIR: '/synthetic/real' } })).toEqual(['/synthetic/demo']);
  });
  it('parses the new flag, retains legacy flags, and rejects demo conflicts/missing values', () => {
    const flags = parseFlags(['--codex-dir', '/synthetic/codex', '--claude-dir', '/synthetic/claude', '--reindex', '--home', '/synthetic/home'], {});
    expect(flags.codexDir).toBe('/synthetic/codex');
    expect(flags.claudeDir).toBe('/synthetic/claude');
    expect(flags.reindex).toBe(true);
    expect(() => parseFlags(['--codex-dir'], {})).toThrow('invalid --codex-dir');
    expect(() => parseFlags(['--demo', '--codex-dir', '/synthetic/codex'], {})).toThrow('mutually exclusive');
  });
  it('denies the default Codex home and credentials but allows transcript roots', () => {
    const home = join(homedir(), '.codex');
    expect(validateRoots([home], '/synthetic/cca', [home]).violations[0]?.reason).toBe('sensitive_location');
    expect(validateRoots([join(home, 'auth.json')], '/synthetic/cca').violations[0]?.reason).toBe('sensitive_location');
    const roots = [join(home, 'sessions'), join(home, 'archived_sessions')];
    expect(validateRoots(roots, '/synthetic/cca', roots).ok).toBe(true);
  });
});

describe('saved configuration upgrades', () => {
  it('adds published OpenAI prices and default sources while preserving edits', () => {
    const home = mkdtempSync(join(tmpdir(), 'cca-config-upgrade-'));
    temporary.push(home);
    const path = join(home, 'config.json');
    const pricing = defaultPricing();
    pricing.models = pricing.models.filter((model) => !model.key.startsWith('gpt-') || model.key === 'gpt-6.1-sol');
    pricing.models.find((model) => model.key === 'gpt-6.1-sol')!.input = 77;
    const settings = { ...defaultSettings(), roots: ['~/.claude/projects'] };
    writeFileSync(path, JSON.stringify({ settings, pricing }));
    const loaded = ConfigStore.load(path).get();
    expect(loaded.pricing.models.find((model) => model.key === 'gpt-6.1-sol')?.input).toBe(77);
    expect(loaded.pricing.models.find((model) => model.key === 'gpt-5.3-codex')).toBeDefined();
    expect(loaded.settings.roots).toEqual(defaultSettings().roots);
    expect(JSON.parse(readFileSync(path, 'utf8')).pricing.models).toHaveLength(loaded.pricing.models.length);
    loaded.settings.roots = ['/synthetic/fixture'];
    writeFileSync(path, JSON.stringify(loaded));
    expect(ConfigStore.load(path).get().settings.roots).toEqual(['/synthetic/fixture']);
  });
});
