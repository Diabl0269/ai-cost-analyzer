Read `CONTRIBUTING.md` for the full developer setup, commands, layout, and conventions.

A few local-tooling notes not worth putting in the public docs:

- Sandboxed shells need loopback/network access explicitly enabled for anything that starts a
  server, runs Playwright, or curls `127.0.0.1`.
- `npx tsx` fails in a sandboxed shell (it opens a unix domain socket to its child process); use
  `node --import tsx/esm <file>.ts` instead.
- Never run two builds at once — `dist/` is shared.
- Ports and homes are overridable via `CCA_PORT`, `CCA_VITE_PORT`, `CCA_HOME`, `CCA_CLAUDE_DIR`,
  `CCA_E2E_PORT`, `CCA_E2E_HOME`.

- Codex adapter: `core/codex/`; keep fixtures synthetic and never scan auth/config files.
- `CCA_CODEX_DIR` / `--codex-dir` choose Codex sources; `CODEX_HOME` changes the default home.
- Queries accept `provider=claude|codex`; absence means combined. Keep provider in navigation.
- Schema version 4 adds provider. Folder grouping uses exact cwd across providers.
- `CCA_E2E_CODEX_DIR` opts browser tests into synthetic mixed-source data.
- Project/executable name is AI Cost Analyzer / `ai-cost-analyzer`; keep legacy CLI/data compatibility.

- Long-context tariffs are resolved from per-request context, not summed usage; grouped SQL keeps
  `pricingContextTokens` separate from totals. Keep this distinction in every new aggregate.
- The privacy scan skips `.git` files as well as directories so managed worktrees are supported.
