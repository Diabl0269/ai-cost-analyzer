/**
 * `claude-cost-analyzer` CLI flag parsing, split out of `cli.ts` so it can be unit-tested without
 * pulling in a module that starts a server or opens a browser as a side effect of import.
 */
export interface Flags {
  port: number;
  open: boolean;
  claudeDir?: string;
  codexDir?: string;
  copilotDir?: string;
  reindex: boolean;
  home?: string;
  demo: boolean;
  demoSeed?: number;
  demoSessions?: number;
}

export function parseFlags(argv: string[], env: NodeJS.ProcessEnv): Flags {
  const flags: Flags = {
    port: Number(env.CCA_PORT ?? 4141),
    open: true,
    reindex: false,
    demo: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--port':
        flags.port = Number(argv[++i]);
        break;
      case '--no-open':
        flags.open = false;
        break;
      case '--claude-dir':
        flags.claudeDir = argv[++i];
        break;
      case '--copilot-dir':
        flags.copilotDir = argv[++i];
        break;
      case '--codex-dir':
        flags.codexDir = argv[++i];
        break;
      case '--reindex':
        flags.reindex = true;
        break;
      case '--home':
        flags.home = argv[++i];
        break;
      case '--demo':
        flags.demo = true;
        break;
      case '--seed':
        flags.demoSeed = Number(argv[++i]);
        break;
      case '--sessions':
        flags.demoSessions = Number(argv[++i]);
        break;
      default:
        console.warn(`unrecognized flag: ${arg}`);
    }
  }
  if (!Number.isFinite(flags.port) || flags.port <= 0) {
    throw new Error('invalid --port value');
  }
  for (const name of ['claudeDir', 'codexDir', 'copilotDir', 'home'] as const) {
    if (flags[name] !== undefined && (!flags[name] || flags[name]!.startsWith('--'))) {
      throw new Error(`invalid --${name === 'claudeDir' ? 'claude-dir' : name === 'codexDir' ? 'codex-dir' : name === 'copilotDir' ? 'copilot-dir' : name} value`);
    }
  }
  if (argv.includes('--copilot-dir') && flags.copilotDir === undefined) throw new Error('invalid --copilot-dir value');
  if (argv.includes('--codex-dir') && flags.codexDir === undefined) throw new Error('invalid --codex-dir value');
  if (argv.includes('--claude-dir') && flags.claudeDir === undefined) throw new Error('invalid --claude-dir value');
  if (flags.demo) {
    if (flags.copilotDir) throw new Error('--demo and --copilot-dir are mutually exclusive');
    if (flags.codexDir) throw new Error('--demo and --codex-dir are mutually exclusive');
    if (flags.claudeDir) throw new Error('--demo and --claude-dir are mutually exclusive');
    if (flags.demoSeed !== undefined && !Number.isFinite(flags.demoSeed)) {
      throw new Error('invalid --seed value');
    }
    if (flags.demoSessions !== undefined && (!Number.isFinite(flags.demoSessions) || flags.demoSessions <= 0)) {
      throw new Error('invalid --sessions value');
    }
  }
  return flags;
}
