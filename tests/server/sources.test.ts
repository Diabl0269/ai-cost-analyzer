import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(resolveRoots({ env: {} })).toEqual(expect.arrayContaining([
      join(homedir(), '.claude/projects'), join(homedir(), '.codex/sessions'),
      join(homedir(), '.codex/archived_sessions'), join(homedir(), '.copilot/session-state'),
    ]));
    expect(resolveRoots({ env: { CODEX_HOME: '/synthetic/codex' } })).toEqual(expect.arrayContaining([
      join(homedir(), '.claude/projects'), '/synthetic/codex/sessions', '/synthetic/codex/archived_sessions', join(homedir(), '.copilot/session-state'),
    ]));
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
  it('selects OpenCode explicitly, honors XDG_DATA_HOME and keeps demos isolated', () => {
    expect(resolveRoots({ opencodeDirFlag: '/synthetic/opencode', env: {} })).toEqual(['/synthetic/opencode']);
    expect(resolveRoots({ claudeDirFlag: '/synthetic/claude', opencodeDirFlag: '/synthetic/opencode/opencode.db', env: {} })).toEqual(['/synthetic/claude', '/synthetic/opencode/opencode.db']);
    expect(resolveRoots({ env: { CCA_OPENCODE_DIR: '/synthetic/data' } })).toEqual(['/synthetic/data']);
    expect(resolveRoots({ claudeDirFlag: '/synthetic/demo', opencodeDirFlag: '', env: { CCA_OPENCODE_DIR: '/synthetic/real' } })).toEqual(['/synthetic/demo']);
    const data = mkdtempSync(join(tmpdir(), 'cca-xdg-')); temporary.push(data);
    expect(resolveRoots({ env: { XDG_DATA_HOME: data } })).not.toContain(join(data, 'opencode'));
    mkdirSync(join(data, 'opencode')); writeFileSync(join(data, 'opencode', 'opencode.db'), '');
    expect(resolveRoots({ env: { XDG_DATA_HOME: data } })).toContain(join(data, 'opencode'));
    expect(parseFlags(['--opencode-dir', '/synthetic/opencode'], {}).opencodeDir).toBe('/synthetic/opencode');
    expect(() => parseFlags(['--opencode-dir'], {})).toThrow('invalid --opencode-dir');
    expect(() => parseFlags(['--demo', '--opencode-dir', '/synthetic/opencode'], {})).toThrow('mutually exclusive');
  });
  it('selects Copilot CLI/app and editor roots explicitly, honors COPILOT_HOME and keeps demos isolated', () => {
    expect(resolveRoots({ copilotDirFlag: '/synthetic/copilot', env: {} })).toEqual(['/synthetic/copilot/session-state']);
    expect(resolveRoots({ copilotDirFlag: '/synthetic/Code/User', env: {} })).toEqual(['/synthetic/Code/User']);
    expect(resolveRoots({ env: { CCA_COPILOT_DIR: '/synthetic/session-state' } })).toEqual(['/synthetic/session-state']);
    expect(resolveRoots({ env: { COPILOT_HOME: '/synthetic/custom-copilot' } })).toContain('/synthetic/custom-copilot/session-state');
    expect(resolveRoots({ claudeDirFlag: '/synthetic/demo', copilotDirFlag: '', env: { CCA_COPILOT_DIR: '/synthetic/real' } })).toEqual(['/synthetic/demo']);
    expect(parseFlags(['--copilot-dir', '/synthetic/copilot'], {}).copilotDir).toBe('/synthetic/copilot');
    expect(() => parseFlags(['--copilot-dir'], {})).toThrow('invalid --copilot-dir');
    expect(() => parseFlags(['--demo', '--copilot-dir', '/synthetic/copilot'], {})).toThrow('mutually exclusive');
    const root = join(homedir(), '.copilot');
    expect(validateRoots([root], '/synthetic/cca', [root]).violations[0]?.reason).toBe('sensitive_location');
    const sessions = join(root, 'session-state');
    expect(validateRoots([sessions], '/synthetic/cca', [sessions]).ok).toBe(true);
  });
  it('denies the default Codex home and credentials but allows transcript roots', () => {
    const home = join(homedir(), '.codex');
    expect(validateRoots([home], '/synthetic/cca', [home]).violations[0]?.reason).toBe('sensitive_location');
    expect(validateRoots([join(home, 'auth.json')], '/synthetic/cca').violations[0]?.reason).toBe('sensitive_location');
    const roots = [join(home, 'sessions'), join(home, 'archived_sessions')];
    expect(validateRoots(roots, '/synthetic/cca', roots).ok).toBe(true);
  });
  it('selects Gemini CLI and Antigravity roots safely, honors GEMINI_CLI_HOME and denies credential files', () => {
    expect(resolveRoots({ geminiDirFlag: '/synthetic/.gemini', env: {} })).toEqual([
      '/synthetic/.gemini/tmp',
      '/synthetic/.gemini/antigravity/brain',
      '/synthetic/.gemini/antigravity-cli/brain',
    ]);
    expect(resolveRoots({ geminiDirFlag: '/synthetic/antigravity-cli', env: {} })).toEqual(['/synthetic/antigravity-cli/brain']);
    expect(resolveRoots({ geminiDirFlag: '/synthetic/gemini-fixture', env: {} })).toEqual(['/synthetic/gemini-fixture']);
    expect(resolveRoots({ env: { CCA_GEMINI_DIR: '/synthetic/brain' } })).toEqual(['/synthetic/brain']);
    expect(resolveRoots({ claudeDirFlag: '/synthetic/demo', geminiDirFlag: '', env: { CCA_GEMINI_DIR: '/synthetic/real' } })).toEqual(['/synthetic/demo']);
    const gemHome = mkdtempSync(join(tmpdir(), 'cca-gemini-home-')); temporary.push(gemHome);
    expect(resolveRoots({ env: { GEMINI_CLI_HOME: gemHome } })).not.toContain(join(gemHome, '.gemini', 'tmp'));
    mkdirSync(join(gemHome, '.gemini', 'tmp'), { recursive: true });
    mkdirSync(join(gemHome, '.gemini', 'antigravity-cli', 'brain'), { recursive: true });
    const detected = resolveRoots({ env: { GEMINI_CLI_HOME: gemHome } });
    expect(detected).toContain(join(gemHome, '.gemini', 'tmp'));
    expect(detected).toContain(join(gemHome, '.gemini', 'antigravity-cli', 'brain'));
    expect(parseFlags(['--gemini-dir', '/synthetic/gemini'], {}).geminiDir).toBe('/synthetic/gemini');
    expect(() => parseFlags(['--gemini-dir'], {})).toThrow('invalid --gemini-dir');
    expect(() => parseFlags(['--demo', '--gemini-dir', '/synthetic/gemini'], {})).toThrow('mutually exclusive');
    const defaultGem = join(homedir(), '.gemini');
    expect(validateRoots([defaultGem], '/synthetic/cca', [defaultGem]).violations[0]?.reason).toBe('sensitive_location');
    expect(validateRoots([join(defaultGem, 'oauth_creds.json')], '/synthetic/cca').violations[0]?.reason).toBe('sensitive_location');
    expect(validateRoots([join(defaultGem, 'antigravity-cli')], '/synthetic/cca', [join(defaultGem, 'antigravity-cli')]).violations[0]?.reason).toBe('sensitive_location');
    const allowed = [join(defaultGem, 'tmp'), join(defaultGem, 'antigravity', 'brain'), join(defaultGem, 'antigravity-cli', 'brain')];
    expect(validateRoots(allowed, '/synthetic/cca', allowed).ok).toBe(true);
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
