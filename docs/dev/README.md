# Developer notes index

Module-owner notes for whoever picks this repo up next. Start with `../../SPEC.md` (binding) and
`../METHODOLOGY.md` (the cost model in plain language); the files below go one level deeper per
module.

- **`parse.md`** — `core/discover.ts`, `core/jsonl.ts`, `core/parse/**`: turning JSONL transcripts
  into `ParsedSession`, and every gotcha in the format (dedup, iterations, turns, titles).
- **`cost-db.md`** — `core/pricing/**`, `core/cost/**`, `core/db/**`: the pricing table, the
  attribution model (generation/ingest/carry, baseline, assistant history), the SQLite index and
  its query semantics.
- **`server.md`** — `server/**`: the Hono app, auth/security model, indexing worker, SSE, watcher,
  static serving, CLI.
- **`web.md`** — `web/**`: components, data hooks, URL state, conventions, accessibility, the
  estimated-split receipt.
- **`integration.md`** — how the four modules run together: Node version requirements, dev vs
  production process layout, env vars, ports, who owns which SQLite connection, what-if pricing,
  validation.
- **`validation.md`** — the cost-state cross-check method and the last recorded run
  (`npm run validate -- --write-doc`).
- **`demo.md`** — `core/demo/**`, `scripts/gen-demo-data.ts`, `scripts/demo.mjs`: the synthetic
  demo dataset (what it contains, the seed/now/sessions knobs, how demo mode serves it).
- **`demo-video.md`** — `scripts/demo-video.ts`, `scripts/demo-video/*`: the narrated screen tour
  (`docs/demo/demo.mp4`/`.webm`/`.gif`), how its timing and voice selection work, and how to record
  a new one.
- **`copilot.md`** / **`opencode.md`** — the Copilot and OpenCode adapters: sources, format, usage semantics and limits.
- `executive-summary.md` — how the executive one-pager (`docs/executive-summary.html`) was produced, every figure with its API source, and how to refresh it.
