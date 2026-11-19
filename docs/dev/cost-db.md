# core-cost-index — pricing, cost, attribution, index, queries

Owns `core/pricing/**`, `core/cost/**`, `core/db/**`, `core/settings.ts`.
One rule drives the design: **tokens are stored, money is not.** Every dollar figure is computed at
read time from stored token counts plus the caller's `PricingConfig`, so editing the pricing table or
running a what-if never requires re-indexing.

## Pricing (`core/pricing`)

```ts
defaultPricing(): PricingConfig                                   // defaults.ts, SPEC §5.2 table
normalizeModelId(id): string                                      // lowercase, strip `[1m]` and `@…`
findModelPrice(id, pricing): ModelPrice | null                    // longest prefix; exact entries last
resolvePrice(model, {speed,inferenceGeo,serviceTier}, pricing): ResolvedPrice   // USD per TOKEN
createPriceResolver(pricing, whatIf?): PriceResolver              // memoized; use in every hot loop
parseWhatIf('opus-5>sonnet-5,fable-5>opus-5'): Map<string,string>
costOfUsage(usage, resolved, webSearchPer1000): CostBreakdown
requestCost(req, pricing, resolver?): { cost, resolved, perIteration? }
formatMoney / formatMoneyCompact / formatTokens / formatPercent / formatDuration / formatModelLabel
pricingConfigSchema, parsePricingConfig(input)                    // zod v4, for PUT /api/pricing
```

- `ResolvedPrice.perToken` already has fast / us-geo (×1.1) / batch (×0.5) applied. Never re-apply them.
- `unpriced: true` means "no entry matched" — under the default `zero` policy the prices are 0; under
  `fallbackModel` they come from `fallbackModelKey`. Either way the UI must label the number.
- `core/pricing/format.ts` is browser-safe (no node imports) — import it from `web/src` too.
- `core/settings.ts` has `defaultSettings()`, `userSettingsSchema`, `parseUserSettings`, `PLAN_PRESETS`
  and `applyPlanPreset`.

## Attribution (`core/cost`)

```ts
attributeTranscript(t: ParsedTranscript, pricing): TranscriptAttribution   // price-independent facts
attributionByRef(attribution): Map<string|number, AttributedItem>
priceRequests(requests, pricing, resolver?): RequestCost[]
buildPriceIndex(rows): RequestPriceIndex                          // prefix sums over one transcript
priceRange(tokens, ingestSeq, lastCarrySeq, index): PricedRange   // the money half of priceItem
priceItem(facts, index): AttributedCost                           // O(1) after an O(log n) lookup
toolCallCosts(rows, indexFor): ToolCallCost[]                     // childCost stays null here
contextItemCosts(rows, indexFor): ContextItemCost[]               // assistant history + baseline
computeInsights(input: InsightsInput, ctx): Insight[]
planComparison(dailyCosts, settings) / budgetStatus(dailyCosts, settings, now)
```

`TranscriptAttribution` / `AttributedItem` / `OutputShare` were appended to the end of `core/types.ts`.

Beyond the gap items (tool results, prompts, hook text, attachments, compact summaries),
`attributeTranscript` emits three **context items** that own the rest of the window
(`ContextItemKind`, see docs/METHODOLOGY.md §3):

| kind | tokens | ingested at | carried to |
|---|---|---|---|
| `assistant_history` | `output − thinking` of R_i, plus a second item for `thinking` | R_{i+1} | end / next compaction; the thinking half stops at the end of its turn |
| `baseline` | `context(R_anchor) − Σ` items live at R_anchor | R_anchor | the last request of the transcript, compactions included |
| `post_compaction_floor` | `context(R_after) − Σ` items live at R_after | R_after | next compaction or end |

`R_anchor` is the first request whose `contextTokens` is at least the tokens of the items ingested
at it. Leading requests that fail that test are background calls (title generation on a resumed or
forked session) whose context is smaller than the compact summary they are supposed to be carrying;
anchoring the baseline there measured 0 and left the whole real floor unattributed. For an ordinary
session the anchor is R_0 and the formula is the plain one.

They carry no generation cost (the output tokens are billed exactly, as `assistantOutput`), so a
context item is ingest + carry only and nothing is double counted. `assistant_history` uses
`estMethod: 'exact-output'` (`ContextEstMethod`, a superset of `EstMethod` that only context items
use — `EstMethod` itself is unchanged so the web `EstimateBadge` still covers every value it sees).
Together they make the estimated split reconcile to the exact context cost. Measured on this
machine's whole history (477 sessions, `input$ + cacheWrite$ + cacheRead$` against Σ of the
estimated context categories):

| | residual |
|---|---:|
| before (gap items only) | **47.7 %** unattributed |
| after | **−2.0 %** (an overshoot) |
| 50 most expensive sessions, median \|residual\| | 10.3 % (23 within 10 %, 36 within 15 %, p90 29.3 %) |

What is left is estimation noise with two causes, and neither is an arithmetic bug:

1. **Under-attribution (positive residual).** Gaps where the measured context growth is more than
   2.5× the characters the transcript recorded, so the Δ scaling is rejected — persisted tool
   output, attachments with no `rendered` — and forked or resumed sessions whose context holds a
   parent conversation that is not in the file at all. The worst session in the top 50 is 68 %
   unattributed and is of the second kind: 419k context tokens against 120k the transcript can
   account for.
2. **Overshoot (negative residual).** `priceRange` charges carry at `avgContextPrice(R_k)`, as
   SPEC §5.3 defines it. That average is pulled above the cache-read price by whatever the request
   *wrote*, so carried history is priced high on any request that both writes and reads. The next
   two worst sessions in the top 50 (−35 %, −32 %) are this, not missing data: on the −32 % one the
   attributed tokens reconcile with `contextTokens` **exactly**, at every request. The size of the
   effect is `carried · (newTokenPrice − cacheReadPrice) · new / (new + carried)` per request, so it
   grows with the write/read mix and cancels out against (1) over the whole corpus.

To tell the two apart on a session, compare Σ item tokens live at each request against that
request's `contextTokens`: if they agree, the residual is (2).

Gotchas:
- Context items are **appended after** the seq-sorted gap items in `TranscriptAttribution.items`,
  not merged into the seq order: callers index gap items positionally and whole-range items have no
  meaningful place in that order.
- Attribution ignores synthetic requests entirely; they never appear in `outputShares` and never act
  as a gap boundary.
- A single transcript line can carry **several** injections (a stop-hook summary, a multi-part
  attachment). `AttributedItem.ref` is the seq, so items are matched to injections *positionally*
  within a seq — see `SessionWriter.writeTranscript`.
- `RequestPriceIndex` must be built from the **whole** transcript, never a date slice; the carry
  prefix sums are meaningless otherwise.
- `computeInsights` re-prices what-if swaps at standard speed/geo/tier by design.

## Index (`core/db`)

```ts
openDatabase(path): DatabaseSync        // WAL, busy_timeout, foreign_keys, 0600; ':memory:' works
runIndex(opts: IndexerOptions & { pricing? }): Promise<IndexResult>
indexChangedFiles(paths, opts): Promise<IndexResult>
createStore(dbPath): Store              // implements every method of core/store.ts
compareReported(computed, computedUsd, reported): ReportedComparison   // core/cost/reported.ts
```

- `IndexerOptions.discover` / `.parse` are injectable; when absent the indexer lazily imports
  `discoverSessions` from `core/discover.ts` and `parseSession` from `core/parse/index.ts`.
- `runIndex` opens and closes its own connection, so `':memory:'` is useless there — index into a
  temp file. `createStore` keeps one long-lived connection.
- Incremental skip key is `(path, size, mtimeMs)` over the session's main + agent + workflow files.
  Any change re-parses the session and rewrites all of its rows in one transaction. Sessions that
  vanish from disk are deleted by `runIndex` (not by `indexChangedFiles`).
- `pricing` is only needed at index time for `charsPerToken` in attribution.
- Schema version lives in `PRAGMA user_version`. A mismatch **drops and recreates** every table —
  the DB is a rebuildable cache, so there are no data migrations.
- `openDatabase` probes FTS5 before anything else (a throwaway `fts5` table created and rolled
  back inside a transaction) and throws `SqliteFeatureError` when it is missing. Node 23's bundled
  SQLite has no FTS5; `server/cli.ts` turns the error into one plain sentence and exits 1.
- `Store.reopen()` closes and re-opens the connection. It exists for one case: a `full` rebuild
  runs in the indexing worker and drops every table underneath the reader's handle. Incremental
  and rescan runs rewrite rows only, and WAL visibility covers those. `reopen()` is idempotent and
  a no-op after `close()`.

### Table notes

- `context_items` holds the whole-context attribution facts (one row per `assistant_history`,
  `baseline` and `post_compaction_floor` item) in the same price-independent shape as `tool_calls`
  and `injections`: `tokens`, `estMethod`, `ingestRequestSeq`, `lastCarrySeq`. It is a separate
  table rather than extra `injections` rows so the session page's injection list, the hook cost
  roll-up and the harness analytics keep seeing exactly what they saw before. Adding it took
  `SCHEMA_VERSION` to 2, which drops and rebuilds the index on first open (no migration).

- `requests.cacheAssumed` holds cache-write tokens whose TTL the transcript never reported
  (`TokenUsage.assumedTtl`, SPEC §3.3); `cache5m` / `cache1h` then hold only the reported split.
  `usageOf(row, pricing)` folds `cacheAssumed` into the bucket
  `PricingConfig.assumeCacheWriteTtlWhenUnknown` names, at read time, so that setting behaves like
  every other pricing edit and needs no re-index. This took `SCHEMA_VERSION` to 3.
- `requests` has an `iterIndex` in its primary key. `iterIndex = 0` is the canonical request (top-level
  usage, which equals the last iteration); rows 1..n are the *extra* iterations of a fallback request,
  each at its own model, with `contextTokens = 0`. **Aggregate over all rows for cost; filter
  `iterIndex = 0` for request counts, context and display.**
- The main transcript uses `agentId = ''` (never NULL) so it can sit in a primary key.
- `messages` stores only a 240-char preview plus `(fileId, byteOffset, byteLength)`; full text lives
  in `messages_fts.text` and in the original JSONL.
- `messages_fts.rowid == messages.id`, so deleting a session's FTS rows is an indexed delete.
  `sessions_fts` is deleted by `sessionId` (a few hundred rows, a scan is fine).
- `dateLocal` is a local `YYYY-MM-DD` computed at index time; items without a timestamp inherit the
  session's start date so they are not silently dropped from range analytics.
- Usage coverage follows billable activity by date. `usageIncomplete` sessions with requests count as
  partial only on request dates; sessions with no requests count as unavailable only when an
  assistant message falls in the range. A prompt or session start date alone is not billable usage.

- `agents.description` falls back to the agent transcript's own cleaned first prompt, truncated to
  80 chars (`agentDescription` in `write-session.ts`), when `meta.json` has none. Every workflow
  agent on this machine (126 of 168) is in that case, and their rows used to read as the bare
  `agentType`. It is resolved at index time so `AgentNode.description` costs nothing to read.

- `HookAnalyticsRow.hookName` stays `'(unnamed)'` for back-compat when the transcript never named
  the hook (a bare `stop_hook_summary` carries only `command` + `durationMs`, no `hookName`);
  `displayName` (`displayNameOf` in `analytics.ts`) is the presentable label instead — the hook's
  own name when it has one, otherwise `hookEvent + ' · ' + commandLabel(command)` (e.g.
  `"Stop · notify-stop.sh"`, `commandLabel` takes the basename of the command's first token), or
  whichever of the two is present. `command` itself is optional on the row (`MIN(h.command)` per
  `(hookName, hookEvent)` group) and is only set when the transcript reported one.

### CSV export

`sessionsToCsv` is RFC 4180 **and** formula-safe: `csvText` runs every transcript-controlled cell
(session id, title, project path, timestamps, entrypoint, models) through `neutralizeFormula`
first, which prefixes a single quote to anything opening with `=`, `+`, `-`, `@`, a tab or a CR.
Numbers go through `csvField` untouched. 294 of 475 real session titles start with one of those
characters, so this is the common case, not the exotic one.

### Comparison against Claude Code's tally

`core/cost/reported.ts` turns a session's stored token counts (main + every agent) and its last
`cost-state` line into a `ReportedComparison`: four signed per-class deltas plus a USD delta, and
a `ReportedComparisonStatus`. `toSessionSummary` attaches the status to every `SessionSummary`
(`reportedStatus`) and `getSession` attaches the whole comparison to `SessionDetail.facts`
(`reportedComparison`); both derive it from the same row and the same cost bundle, so the list and
the detail page can never disagree. Deltas are `(computed − reported) / max(computed, reported)`,
bounded by ±100% and defined when one side is zero. A class under 10,000 tokens is reported but
does not decide the status — see `docs/dev/validation.md`.

### Query semantics

- Range: local dates, inclusive, defaulting to the last 30 days. An *item* is in range when its own
  `dateLocal` is; a *session* is in range when it has at least one request in range. `listSessions`
  and the CSV export are the exception — they filter on the session's **start** date.
- `OverviewResponse.topSessions` is range-scoped too: `loadSessionSummaries(..., range)` prices
  each summary over the window and reports the in-range `requestCount`, because the table is
  captioned "in the selected range" and whole-session costs there summed to 182 % of the range
  total on a one-day window. A range-scoped summary drops `reportedCostUsd` / `reportedStatus`:
  Claude Code's tally belongs to a whole process, so comparing a window against it says nothing.
  `listSessions`, the CSV export and `getSession` are unchanged — whole-session costs, full
  comparison.
- `listProjects` resolves the range like every analytics path (missing bounds → the last 30 days)
  and echoes it as `ProjectsResponse.range`. `sessionCount` and `totalCost` cover **only the
  requests inside it** — `loadSessionCosts(..., range)` adds the `dateLocal` filter — so
  `Σ overview.byProject.cost === overview.totals.cost.total` and
  `Σ byProject.sessions === totals.sessions`. It still lists *every* project, at zero when nothing
  fell in the window, so the rail never loses a navigation target; `overview.byProject` drops those
  zero rows because a spend table has no use for them. `firstActivity` / `lastActivity` stay
  all-time: they describe the project, not the window.
- `StoreStatus.scratchSessions` is the all-time count of sessions in a scratch project — what
  `hideScratchProjects` hides. It is always computed (one grouped scan over `sessions`), so
  `GET /api/status` no longer needs a second `listProjects` call with the setting forced off. That
  second call would now answer for the *range*, not for all time.
- `whatIf=fromKey>toKey,…` substitutes prices after the real model is identified, so unknown models
  are never silently re-priced. It comes from `QueryContext.whatIf` or the query string, and it
  reaches every read path that prices a request, `getTranscript` included.
- Search runs two queries. `countContentHits` counts hits per session over the **whole** match
  with no window — it skips `bm25()`, which is what makes ranking expensive, so it costs ~10 ms
  (85 ms for a stop word over 12.7k hits). That gives an exact `totalSessions` and an exact
  `hitCount` per group. `searchContent` then supplies the *order* and the snippets from a ranked
  window; `SearchSessionGroup.hits` is capped at 3 for display.
- The ranked window is measured in hits but paging is by session, so it **grows on demand**:
  starting at `max(limit × 20, 100)` it widens (×4, or straight to a projection from the
  hits-per-session it just measured) until it can either place the cursor and see a next page or
  prove there is none, capped at `MAX_HIT_SCAN` (20 000). Without that a query whose hits pile up
  in a few sessions filled the window on page one and returned `nextCursor: null` with most of the
  matches unreachable — `pricing` on this corpus showed 5 sessions of 28 and could not page.
  Session summaries are priced for the page's ids only, not for the whole window.
- `hideScratchProjects` is skipped when `q.project` targets a project and when loading one session by
  id, so a link to a scratch session always opens.
- Cursors are opaque base64url of the last row's session id; sorting and paging happen in JS after
  the SQL aggregation (a few hundred sessions, ~15 ms).
- Snippets use control characters as markers, are HTML-escaped, and only then become `<mark>`.
  Title search needs ≥3 characters for the trigram index and falls back to `LIKE` below that.
- **Requests per model = billed iterations attributed to that model.** `ModelCostRow.requests` (spend
  by model, models analytics) is `billedRequests` (`COUNT(*)` grouped by model), not the top-level
  request count: a fallback request bills its final iteration under one model and its earlier
  iteration(s) under the model(s) it fell back from, so each iteration counts as one request against
  its own model. Summing `requests` across the models of a fallback request is therefore `>= 1` while
  the session's actual request count stays exactly 1 — so `Σ byModel.requests` can land slightly above
  a range's total request count. Contexts that count *requests*, not *billed iterations by model*
  (`OverviewResponse.totals`, `listSessions`, the CSV export), filter `iterIndex = 0` instead.

## Measured against real data (`~/.claude/projects`, 645 files)

| | |
|---|---|
| index (parse included) | ~4 s / 477 sessions / 12.1k requests / 52k messages / 645 files |
| `overview` over 12.1k requests | 190–280 ms (over HTTP, whole-history range) |
| `listSessions` (475) | 12 ms · `getSession` 20 ms · `search` 18–32 ms |
| cost-state oracle | **0.0 % delta** on every session whose parsed token counts match cost-state |

Across the 53 sessions with a `cost-state` line the median |Δ USD| is ~30 %, and every one of those
gaps tracks a token-count difference, not a price difference: on the 6 sessions whose token counts
are *identical* the money is identical to the cent. `scripts/validate-cost-state.ts` classifies the
rest; `docs/dev/validation.md` records the last run.

## Tests

`tests/core/pricing/**`, `tests/core/cost/**`, `tests/core/db/**`.
`tests/core/cost/attribution.test.ts` has a reconciliation test that sums every item live at each
request and asserts it equals that request's `contextTokens`; keep it green when touching the model.
`tests/core/cost/builders.ts` builds `ParsedRequest` / `ParsedTranscript` / `ParsedSession` by hand;
`tests/core/db/fixture.ts` writes a synthetic JSONL to a temp dir and returns the matching
`ParsedSession`, so the db tests exercise real byte-range reads without touching the parser.
