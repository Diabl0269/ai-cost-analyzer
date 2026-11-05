# Contributing

Thanks for looking at AI Cost Analyzer. This is a local, single-user web app that reads Claude
Code transcripts from `~/.claude/projects` and prices every request, tool call, subagent, workflow,
hook and harness injection at API list prices. The full design is `SPEC.md` (binding); the cost
model is explained in `docs/METHODOLOGY.md`; per-module notes live in `docs/dev/*.md`.

## Node 22, always

`node:sqlite` is the app's only database driver and the index needs FTS5 (trigram tokenizer);
Node 23's bundled SQLite lacks it. Start every shell session with `nvm use` (`.nvmrc` pins 22), or:

```sh
export PATH="$(dirname "$(nvm which 22)"):$PATH"
```

`npx tsx` can hang in a sandboxed shell — the `tsx` CLI opens a unix domain socket to talk to its
child process, which a sandbox may refuse. Run TypeScript one-offs with
`node --import tsx/esm <file>.ts` instead; that's the loader half only, no socket.

## Commands

| command | what it does |
|---|---|
| `npm run dev` | server (4141, `CCA_DEV=1`) + Vite (5173) via `scripts/dev.mjs`; starts local servers |
| `npm run build` | `tsc -p tsconfig.node.json && vite build` → `dist/` |
| `npm start` | runs the built `dist/server/cli.js`; starts a local server |
| `npm test` | vitest, all against fakes/fixtures, never a real transcript DB |
| `npm run test:e2e` | builds, boots the server on 4171 against `tests/fixtures/projects`, Playwright + axe; starts a local server and a browser |
| `npm run typecheck` | `tsconfig.node.json` + `tsconfig.web.json` + `tsconfig.tests.json` |
| `npm run validate` | `scripts/validate-cost-state.ts` — cross-checks computed cost vs Claude Code's `cost-state` tally |
| `npm run screenshot` | `scripts/screenshot.ts` — every page, both themes, into `docs/screenshots/`; needs a running server and a browser |
| `npm run demo` | `scripts/demo.mjs` — generates the synthetic demo dataset (once) and serves it on 4142 from its own `CCA_HOME`; `--fresh`, `--seed`, `--sessions`, `--port`, `--no-open` |
| `npm run demo:data -- --out <dir>` | `scripts/gen-demo-data.ts` — deterministic synthetic `~/.claude/projects`-shaped tree (`core/demo/`) |
| `npm run demo:video -- --base <url> --out docs/demo` | `scripts/demo-video.ts` — narrated Playwright tour → mp4/webm/gif/poster (`docs/dev/demo-video.md`) |
| `npm run check:privacy` | `scripts/check-privacy.mjs` — fails on emails, foreign `/Users/<name>` paths, Slack IDs, and tokens listed in the git-ignored `.privacy-denylist.local` |

Loopback curl and any Playwright run need network/loopback access, which a sandboxed shell may not
grant by default.

Ports and homes are all overridable, so more than one checkout can run at once without colliding:
`CCA_PORT` / `CCA_VITE_PORT` / `CCA_HOME` / `CCA_CLAUDE_DIR` for `npm run dev`, and `CCA_E2E_PORT` /
`CCA_E2E_HOME` for `npm run test:e2e`. `dist/` is shared — never run two builds at once.

## Layout

```
core/                 pure TypeScript, no HTTP, no React — types.ts is the shared contract
  types.ts            domain + API types. Append-only; never rename or repurpose a field.
  discover.ts jsonl.ts parse/    JSONL → ParsedSession        (parser module)
  pricing/ cost/ db/             pricing table, attribution, SQLite index, queries  (cost/index module)
  demo/                          seeded synthetic dataset generator (pure; no real data)  (docs/dev/demo.md)
server/               Hono app: routes, auth, indexing worker, SSE, fs watcher, CLI
web/                  Vite + React 19 UI ("The Ledger"): components, routes, design tokens
scripts/              dev.mjs, demo.mjs, gen-demo-data.ts, demo-video.ts (+ demo-video/), screenshot.ts, validate-cost-state.ts, check-privacy.mjs
tests/                core/** (vitest), fixtures/projects (synthetic), e2e/** (Playwright)
docs/                 METHODOLOGY.md, dev/*.md, screenshots/ (demo data), demo/ (video), executive-summary.html
```

Detailed per-module notes: `docs/dev/parse.md`, `docs/dev/cost-db.md`, `docs/dev/server.md`,
`docs/dev/web.md`, `docs/dev/integration.md`, `docs/dev/validation.md`.

## Shared contracts

- `core/types.ts` is the contract between every module. Extend it, don't fork it — new fields are
  additive.
- `core/store.ts` / `core/db/store.ts`: `createStore(dbPath)` implements every read/write query the
  server uses. Routes call `Store` methods, never raw SQL.

## Conventions

- ESM everywhere; imports use explicit `.js` extensions (even from `.ts` sources).
- Web code uses `@/` (→ `web/src`) and `@core/` (→ `core`) aliases — **except** `web/src/lib/*`
  modules also imported directly by a test (`format.ts`, `range.ts`): those need relative imports
  with an explicit `.js` so they compile under both `tsconfig.web.json` (Bundler resolution) and
  `tsconfig.tests.json` (NodeNext, no aliases).
- Dependencies are frozen to `package.json`. Don't add or upgrade one without a license check (no
  GPL in this project); if something's missing, stop and raise it before installing.
- **Money is computed at read time and never stored.** Only token counts (integers) live in the
  DB; every dollar figure is `tokens × current PricingConfig`, so editing prices or a what-if swap
  never needs a re-index.
- Estimated numbers are always labelled **est.** in the UI (`<EstimateBadge>`); exact numbers never
  carry it.
- No real transcript content anywhere outside your own `~/.claude/projects`: fixtures under
  `tests/fixtures` are synthetic, hand-computed totals live in `tests/fixtures/README.md`, and logs
  /docs/error messages never echo transcript text.

## Design brief

`SPEC.md` §8 ("The Ledger") is binding, not inspiration. New pages compose the components
documented in `docs/dev/web.md` (`LedgerTable`, `Receipt`, `Kpi`, `CostWaterfall`, `ContextStrip`,
`ModelChip`, `EstimateBadge`, …) — don't hand-roll a table or a chart that already has a component.

## Validation oracle

Claude Code's own `cost-state` lines are a per-**process** running tally, not a per-session one: a
resumed, forked or continued session can start that counter already holding a parent's total, or
reset it while the transcript keeps the whole history. `core/cost/reported.ts` classifies each
session's comparison (`match`, `tally-includes-earlier-process`, `file-covers-more-than-tally`,
`hidden-calls-only`, `mixed`) rather than pass/failing it — see `docs/METHODOLOGY.md` §2 and
`docs/dev/validation.md` for the current numbers.

## Schema version bump = rebuild

The DB is a rebuildable cache keyed by `PRAGMA user_version` (currently `SCHEMA_VERSION = 4`). A
mismatch drops and recreates every table on next open — there are no migrations. Bump it whenever
`core/db/schema.ts` changes shape.

## How to add things

- **A page**: `web/src/routes/<name>/Page.tsx` (default export, one `<h1>`), register it in
  `web/src/app/routes.tsx` with `lazyPage(...)` and a `handle.title`. See `docs/dev/web.md` §"Adding
  a page" for the full checklist (rail slot, shortcuts, loading/empty/error states).
- **An endpoint**: add a route file under `server/routes/`, a zod schema in `server/schemas.ts`, and
  a matching type in `core/types.ts` §API. Validate query/body with `parseQuery`/`parseJsonBody`
  before touching the store; never echo raw input in an error.
- **A pricing entry**: append to the table in `core/pricing/defaults.ts` per `SPEC.md` §5.2 (label,
  prefix match, per-token prices, fast-mode prices if any, chars/token); `findModelPrice` picks the
  longest prefix match, so order doesn't matter but specificity does.

## Gates before a pull request

1. `npm run typecheck` clean.
2. `npm test` green.
3. If you touched `web/**`, `core/**`, or anything the built server serves: `npm run test:e2e`
   green (this also runs `npm run build`).
4. Never modify `package.json`, tsconfigs, or `SPEC.md` without discussion first. Never write under
   `~/.claude` or `~/.claude-cost-analyzer` during dev/test — use a scratch `CCA_HOME` and your own
   port, and stop every process you started.
5. `node scripts/check-privacy.mjs` must exit 0 — no real names, paths, or transcript content.

## Multiple AI tools

`core/codex/` adapts Codex rollout files into the shared parser contract. Discovery records a
provider (`claude`, `codex` or `copilot`), the index stores it on sessions, and `RangeQuery.provider` scopes
all list/search/analytics/export queries. Missing provider means all providers. Shared projects merge by
exact reported working directory, preserving Claude project IDs for existing links.

Codex roots use `--codex-dir`, `CCA_CODEX_DIR`, or `CODEX_HOME`; archived rollouts are included.
Keep dev/test roots explicit so no real local Codex sessions are indexed into test homes.
No new dependencies are required. `ai-cost-analyzer` and the legacy `claude-cost-analyzer`
executables use the same CLI. For mixed-source browser checks, set `CCA_E2E_CODEX_DIR` to
`tests/fixtures/codex` and run `playwright test providers.spec.ts` after a build.

The web navigation wrappers in `web/src/lib/navigation.tsx` preserve provider selection;
`web/src/lib/provider.ts` owns parsing and URL propagation. Use these wrappers for internal
links and navigation. `useDateRange` carries provider with date/project state to API queries.

## Index completeness

An indexing exception may leave completed sessions in the cache. The error is retained in the
index manager, exposed as `/api/status.indexError`, and displayed as **Index incomplete** until
a successful full rebuild or rescan. A successful incremental update cannot certify the whole
index. Validate discovery versus indexed counts against real source roots before claiming a
preview contains the user's history; a successful HTTP response proves only that the server runs.
Codex sessions with assistant messages and no token telemetry display an unavailable cost.

## Parser cache version and Codex prompts

`core/codex/prompts.ts` recognizes complete leading AGENTS instructions, environment/browser
context, and other harness envelopes. These remain readable as harness lines in the transcript;
titles, prompt counts, and prompt search use the first actual request. Quoted instructions inside
ordinary requests are preserved. Context-only sessions use a distinct identifier fallback.

When those derived facts change, increment `PARSER_VERSION` in `core/db/indexer.ts`. A successful
root scan marks that version in the existing meta table; a mismatch reparses unchanged files,
refreshing titles and full-text search automatically. A failed whole-session parse cannot mark
the upgrade complete or report the index as up to date. No schema change is needed.

Data-page navigation carries provider, dates and project. Settings/document links carry only
provider; page-specific filters and cursors are not global. The project tree deliberately drops
the selected-project constraint when loading its navigation choices.

The session ledger selects the richest column set fitting its measured container, including the
project rail's space. Keep the Cost column visible at every supported width. Codex rows display
readable model labels; full model IDs remain available in tooltips.


## Copilot sources

`core/copilot/` reads CLI/app event streams and VS Code saved snapshots/journals. See
`docs/dev/copilot.md` for precise coverage, telemetry limitations and source-selection flags.
`server/copilot-paths.ts` resolves the local platform's editor storage paths. `CCA_COPILOT_DIR`,
`--copilot-dir` and `COPILOT_HOME` select Copilot roots; `CCA_E2E_COPILOT_DIR` enables synthetic
browser coverage. Preserve missing-usage state and never interpret Copilot credits as dollars.
