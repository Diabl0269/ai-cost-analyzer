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

- Indexing failures remain visible through `/api/status.indexError` and incremental updates; clear
  them only after a successful full rebuild/rescan, never just because a later file indexed.
- Assistant transcripts missing token telemetry show unavailable costs, rather than exact zero.

- `core/codex/prompts.ts` separates complete injected envelopes from real user requests; retain
  raw transcript ranges and context attribution when changing title/prompt normalization.
- Bump `PARSER_VERSION` in `core/db/indexer.ts` when derived parser facts change; it refreshes
  unchanged transcripts and search entries without changing the database schema.
- Internal data-page links retain provider/date/project filters. Project navigation lists all
  folders in the provider/date scope, even while the main view is filtered to one folder.
- CSV `costStatus` distinguishes recorded, partial, unpriced, and unavailable monetary values.

- Overview `usageCoverage` counts incomplete sessions independently of request rows; preserve
  provider/project/date scoping and do not imply zero cost when token telemetry is absent.

- Session column selection uses measured table space and explicit width budgets. Cost must stay
  visible without horizontal scrolling; keep responsive edge assertions when adding columns.

- Copilot adapters: `core/copilot/` handles CLI/app events and VS Code snapshots/journals;
  `server/copilot-paths.ts` discovers platform-specific local editor stores. See `docs/dev/copilot.md`.
- `CCA_COPILOT_DIR` / `--copilot-dir` choose explicit sources; `COPILOT_HOME` changes the default.
  Provider queries also accept `copilot`; `CCA_E2E_COPILOT_DIR` enables synthetic browser checks.
- Copilot aggregate request rows are accounting buckets, excluded from API call counts; never infer
  per-request context tariffs or tool allocation from session totals. Credits are not USD.
- VS Code journal transcript paging uses reconstructed virtual sequence numbers, not byte ranges.
  Retain visible models via `recordedModels` when billing usage is unavailable.
- `codex-auto-review` has no confirmed published zero tariff: keep it unpriced unless billing
  evidence changes. `docs/dev/auto-review-pricing.md` records the checked sources and regression.
- Copilot session buckets retain token/cost totals but are excluded from individual call counts
  in sessions, models, overview and index status. Preserve `RequestCost.usageGranularity` in UI guards.
- `core/cost/usage-coverage.ts` owns absent-versus-partial usage semantics for UI and CSV;
  aggregate tokens can exist without observed API calls. Do not use request count alone.
