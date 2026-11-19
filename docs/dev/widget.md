# Menu-bar widget (SwiftBar)

A native alternative that needs no SwiftBar is described in `docs/dev/menubar.md`
(`ai-cost-analyzer menubar install`).

`integrations/swiftbar/ai-cost-analyzer.5m.sh` is a SwiftBar/xbar plugin (refreshes every 5 minutes,
per the `.5m.` in the filename). It talks to the local server only.

## Install

1. Install SwiftBar and choose a plugin folder.
2. Copy the script there and `chmod +x` it.
3. Run the server in the background: `ai-cost-analyzer autostart enable` (`docs/dev/autostart.md`).
4. Non-default port: set `CCA_PORT` (SwiftBar: plugin → Preferences → Environment).

If the server is unreachable the title is `⚠ offline`.

## Auth

The script mirrors the web client: `POST /api/auth/session` into a temporary cookie jar, then
`GET /api/analytics/summary` with that cookie. The jar is deleted on exit. JSON is parsed with
`osascript -l JavaScript`, so `jq` is not needed.

## `GET /api/analytics/summary`

Type: `SummaryResponse` (`core/types.ts`); aggregate: `summaryUsage` / `combineSummaryUsage` in
`core/db/analytics.ts`; `Store.summary()` in `core/db/store.ts`.

- `periods.today`: the current local day. `periods.week`: the last 7 local days including today
  (same as the UI's "7 days" preset). Each has `range`, `total` and `byProvider`
  (`claude|codex|copilot|opencode`).
- Per-provider `SummaryUsage`: `cost` (USD at list prices), `costStatus`
  (`recorded|partial|unpriced|unavailable`), `tokens{input,output,cacheRead,cacheWrite,total}`,
  `sessions`, `unavailableSessions`, `partialSessions`.
- `estimatedCost` (optional) is USD for usage on models priced only through a `pricing.estimateAs`
  rule (e.g. an unpriced model estimated as another). It is never included in `cost`, whose status
  stays `unpriced`/`partial`; the plugin prints `$1.00 + ≈ $0.40 (estimate)` or `≈ $0.40 (estimate)`.
- `cost` is `null` for `unavailable` (sessions with activity but no token telemetry) and `unpriced`
  (usage only on models with no tariff). It is never a fabricated 0. `partial` means the number is a
  lower bound; the plugin prints it as `$1.23+`. A provider with no activity is `recorded` with 0.
- The total is the sum of known provider costs; it is `partial` if any active provider is degraded.
- Cost comes from the same grouped, per-request-context pricing as the overview; `tokens.total` is a
  plain token sum and is not used for pricing.
- `hideScratchProjects` applies to usage and session counts. `budget` is the calendar-month status
  used by the overview and (as there) ignores scratch hiding.
- Also returned: `indexing`, `indexError`, `indexFailureCount`, `lastIndexedAt`, `generatedAt`.
- Copilot credits are not USD and are not stored in the index, so they are not reported; Copilot
  USD figures are token-based list-price estimates.

## Tests

`tests/server/summary.test.ts` (auth, shape, provider split, boundaries, unavailable ≠ 0) and
`tests/server/swiftbar-plugin.test.ts` (runs the script against a stub server; macOS only).
