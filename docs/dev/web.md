# web — React UI ("The Ledger")

Owns: `web/**`, `tests/web/**`. Vite + React 19, CSS Modules, no UI framework.
Aliases: `@/` → `web/src`, `@core/` → `core` (no file extensions in web code).
Run `npx vite` (5173, proxies `/api` → 4141) or `npm run dev`. `/design` is the live gallery of
every component with invented data; it needs no API and is the fastest way to check a change.

## Layout

```
web/src/design/     tokens.css (both palettes) · base.css (reset/focus/print) · typography.css · utilities.css · contrast.ts
web/src/components/ one folder per component: Name.tsx + Name.module.css + index.ts; barrel in components/index.ts
web/src/app/        App.tsx (providers + boot-time motion preference) · routes.tsx (router) · shell/ (TopBar, LeftRail, IndexStatusPill, GlobalSearch, ThemeToggle, AppCommands, RouteError)
web/src/lib/        api.ts · queries.ts · format.ts · range.ts · whatif.ts · keyboard.ts · a11y.ts · theme.ts · chart.ts · fuzzy.ts
web/src/routes/     <page>/Page.tsx — default-exported component per route
```

## Components

Import from `@/components`. Every one is keyboard-operable and passes axe in both themes.

| Component | Key props | Example |
|---|---|---|
| `Money` | `usd`, `delta`, `tone: 'auto'\|'cost'\|'save'\|'none'`, `display`, `invert`, `currency`, `decimals`, `fractionDigits` | `<Money usd={143.5062} />` |
| `Tokens` | `value`, `unit` | `<Tokens value={12482} unit="tok" />` |
| `Duration` | `ms` | `<Duration ms={750_000} />` |
| `RelativeTime` | `value`, `live` | `<RelativeTime value={s.startedAt} />` |
| `ModelChip` | `model` (raw id or pricing key), `glyphOnly`, `size`, `label`, `family` | `<ModelChip model="claude-opus-5[1m]" />` |
| `EstimateBadge` | `method: EstMethod`, `detail`, `size` | `<EstimateBadge method="delta" />` |
| `Button` / `LinkButton` | `variant: primary\|secondary\|ghost\|danger`, `size`, `iconStart`, `iconEnd`, `loading`, `fullWidth`; `LinkButton` adds `to` | `<Button variant="secondary" iconStart="download">Export CSV</Button>` |
| `IconButton` | `icon`, `label` (required), `variant: ghost\|outline`, `active`, `rotate` | `<IconButton icon="pin" label="Pin session" />` |
| `Icon` | `name: IconName`, `size`, `rotate`, `weight` (`ICON_NAMES` lists all) | `<Icon name="tools" size={14} />` |
| `SegmentedControl` | `options`, `value`, `onChange`, `label`, `size`, `fullWidth` (ARIA radiogroup) | `<SegmentedControl label="Sort by" value={s} onChange={setS} options={o} />` |
| `Switch` | `checked`, `onChange`, `label`, `description`, `leading` | `<Switch checked={v} onChange={setV} label="Hide scratch projects" />` |
| `Select` | `label`, `value`, `onChange`, `options`, `groups`, `hideLabel` (native `<select>`) | `<Select label="Model" value={m} onChange={setM} options={opts} />` |
| `NumberField` | `label`, `value: number\|null`, `onChange`, `min`, `max`, `step`, `prefix`, `suffix`, `precision`, `error` | `<NumberField label="Input $/MTok" value={p} onChange={setP} prefix="$" />` |
| `DateRange` | `value`, `onPreset`, `onBounds`, `compact` — drive from `useDateRange()` | `<DateRange value={r.value} onPreset={r.setPreset} onBounds={r.setBounds} />` |
| `Tabs` | `items` (`{id,label,count?,to?}`), `value`, `onChange` **or** `to` per item, `label`, `panelId` | `<Tabs label="Session sections" items={items} value={active} />` |
| `TreeNav` | `nodes: TreeNode[]`, `label`, `selectedId`, `onSelect`, `defaultExpandedIds`, `dense` | `<TreeNav nodes={tree} label="Projects" onSelect={pick} />` |
| `LedgerTable` | `columns: LedgerColumn<Row>[]`, `rows`, `rowKey`, `caption`, `defaultSort`/`sort`+`onSortChange`, `manualSort`, `autoSort`, `columnGroups`, `onActivateRow`, `activateLabel`, `rowActions`, `rowTabStops: 'roving'\|'natural'`, `selectedKey`, `selectedKeys`+`onSelectionChange`, `loading`+`skeletonRows`, `empty`, `dense`, `footer`, `maxHeight`, `virtualizeThreshold` | see below |
| `CountCell` | `value`, `tone: 'warn'\|'cost'`, `noun` — zero dims to `--ink-3`, non-zero gets colour + a glyph | `<CountCell value={row.failures} noun="failure" />` |
| `Receipt` | `rows: {id,label,value,indent?,emphasis?: 'muted'\|'subtotal'\|'total'}[]`, `caption`, `footer`, `dense` | `<Receipt caption={title} rows={rows} />` |
| `Kpi` | `label`, `value`, `sub`, `delta: {fraction, label?, good?: 'up'\|'down'\|'none'}`, `note`, `hint`, `size` | `<Kpi label="Spend" value={<Money usd={324.6} display />} />` |
| `CostWaterfall` | `data: WaterfallDatum[]`, `selectedSeq`, `onSelect`, `onBrush`, `height`, `title` | `<CostWaterfall data={reqs} onSelect={pick} />` |
| `ContextStrip` | `segments`, `total`, `onSelect`, `selectedId`, `height` | `<ContextStrip segments={segs} />` |
| `HeatStrip` | `days: {date,cost,requests,sessions}[]`, `selectedDate`, `onSelect`, `height`, `showLegend`, `showAxis` | `<HeatStrip days={days} onSelect={pick} />` |
| `TokenBar` | `tokens: {input,output,cache5m,cache1h,cacheRead}`, `label`, `showLegend`, `height`, `fraction` | `<TokenBar label="Opus 5" tokens={row.tokens} fraction={0.8} />` |
| `PlanGauge` | `planLabel`, `planUsd`, `apiUsd`, `forecastUsd`, `month` | `<PlanGauge planLabel="Max 20×" planUsd={200} apiUsd={324.6} />` |
| `Sparkline` | `values`, `ariaLabel` (required), `width`, `height`, `tone`, `fill`, `marker` | `<Sparkline values={v} ariaLabel="Spend rose…" />` |
| `ChartFrame` | `summary` (required), `title`, `table`, `toolbar`, `legend`, `defaultView` | wrap any custom chart in it |
| `Dialog` | `open`, `onClose`, `title`, `description`, `footer`, `size`, `alert`, `bare`, `initialFocusRef` | `<Dialog open={o} onClose={close} title="Rebuild?" alert />` |
| `Popover` | `trigger(props)`, `label`, `children`, `placement`, `width`, `open`/`onOpenChange` | `<Popover label="Columns" trigger={(p) => <button {...p}>Columns</button>}>…</Popover>` |
| `Tooltip` | `content`, `children` (one focusable element), `placement`, `delay`, `maxWidth` | `<Tooltip content="…"><button …/></Tooltip>` |
| `CommandPalette` | `open`, `onOpenChange`, `commands: Command[]` (`{id, title, run, …, keys?}`), `recentKey` — the shell already renders one | — |
| `ShortcutsDialog` | `open`, `shortcuts`, `onClose`, `extra` — the shell already renders one | — |
| `Toast` | `useToast().toast({title, description?, tone?, duration?})` | `toast({ title: 'Copied', tone: 'save' })` |
| `Callout` | `tone: info\|warn\|cost\|save`, `title`, `icon`, `action` | `<Callout tone="warn" title="Unpriced model">…</Callout>` |
| `EmptyState` | `title`, `description`, `icon`, `action`, `inline` | `<EmptyState title="No sessions in this range" />` |
| `Skeleton` | `width`, `height`, `lines`, `radius`, `label` | `<Skeleton lines={3} height={10} />` |

`LedgerTable` example — `columns` is the whole API:

```tsx
const columns: LedgerColumn<SessionSummary>[] = [
  { id: 'title', header: 'Session', width: '38%', sortValue: (r) => r.title, cell: (r) => r.title },
  { id: 'cost', header: 'Cost', numeric: true, sortValue: (r) => r.cost.total, cell: (r) => <Money usd={r.cost.total} /> },
];
<LedgerTable columns={columns} rows={sessions} rowKey={(r) => r.id} caption="Sessions in range"
  defaultSort={{ columnId: 'cost', direction: 'desc' }} onActivateRow={(r) => navigate(`/sessions/${r.id}`)} />
```

`numeric` right-aligns and sets tabular mono; `secondary` hides the column under 900px;
`sortValue` makes the header a sort button with `aria-sort`; rows above `virtualizeThreshold`
(200) are virtualized **when `maxHeight` is set** — without one the scroller is the page's own
height and never scrolls, so the virtualizer would render every row anyway while `aria-rowcount`
promised a window that was not there. Long lists must pass `maxHeight` (the analytics pages use
`rows.length > n ? 640 : undefined`); `/sessions` deliberately does not, and holds ~475 rows at
a steady 60 fps. Server-side sorting: pass `sort` + `onSortChange` + `manualSort`.

- **`sortValue`** is a reader (`(row) => …`) **or a dotted path into the row**
  (`sortValue: 'cost.total'` reads the same as `(row) => row.cost.total`, via `resolvePath` in
  `columns.ts`). `autoSort` marks every column whose own `id` is itself a readable field of the
  row as sortable by that field, without writing an accessor at all — set it once on the table
  instead of a `sortValue` per column that already matches its `id`.
- **`columnGroups`** draws a spanning label above two or more adjacent columns in their own header
  row (`5m` + `1h` under "Cache write"); each group's `columns` must be contiguous in `columns`.
- **`headerAside`** sits beside a column's header label, outside the sort button — an
  `<EstimateBadge>`, a unit. **`moneyValue`** names the amount a column prints when that is not
  what its `sortValue` reads; the table derives one decimal-alignment slot per column from every
  value in it (a custom property, `--money-frac`) and hands it to `<Money>` automatically, so a
  `$0.06` / `$0.0070` / `$0.27` column lines up its decimal points without a `fractionDigits` prop
  on any one cell.
- **One tab stop per table.** A pin button, a title link and a chain link in every row would be
  three extra tab stops per row — a thousand of them on `/sessions`. So `rowTabStops: 'roving'`
  (the default) takes a row's own controls out of the tab order and reaches them from the focused
  row instead: Enter runs `onActivateRow` (described to screen readers as `activateLabel`),
  `rowActions` keys act on the row, and → or F2 moves focus into its controls (Escape or ←
  returns to the row). A control that must stay in the natural tab order opts back in with
  `data-ledger-tabbable`. `rowTabStops: 'natural'` leaves every control tabbable — for a table
  that is really a form grid, like the pricing editor.

**Bars that compare.** `TokenBar`'s split is normalised, so a row of them all reach the right
edge and look identical. Pass `fraction` (0–1) wherever the rows are meant to be compared — the
overview's "Spend by model" passes each model's share of spend, so Opus 5 at 80% draws a bar
four fifths of the track while the token classes still split its inside.

**KPI deltas.** `good` defaults to `'none'` (neutral ink): a count going up is neither good nor
bad, and only cost-like metrics earn red/green — spend and cost per prompt are `'down'`, cache
hit ratio is `'up'`. When the previous window holds under a tenth of the current value
(`priorTooSmall` in `routes/overview/previous.ts`) the overview drops the percentage and passes
`note` instead: "▲ 1,428%" in red against an almost empty prior month is a statement about
coverage, not about spend. `Kpi` is a 3-row grid (label row, value, footer) and the footer row is
**always rendered**, even empty — it is what keeps the footer lines of six KPIs in a row on one
horizontal, so a `<Kpi>` with no `delta`/`note`/`sub` still reserves the line the others use for
theirs. The overview's six-KPI row uses the `grid-kpis-6` utility (`design/utilities.css`), which
also folds the layout down for narrower widths.

**HeatStrip** draws a dense day list, one cell per day in the range, not a bar chart: cells are a
fixed 24px wide (`--day-w`) and left-aligned, so they shrink — never grow — to fit a narrow column,
and a five-day window draws five cells rather than five wide bars. A day that billed nothing (`cost
<= 0`) still gets a cell, drawn as bare paper inside a permanent hairline, so the gap in the
calendar stays visible instead of vanishing. `showAxis` (default on) prints the first and last
date under the strip; `showLegend` (default on) prints the "less…more" ramp key.

**DateRange `compact`** collapses the whole control (presets + the two bound inputs) to one
button reading the active window, with everything else inside a popover — the top bar switches to
it at 1180px and under, where the full row no longer fits.

**CommandPalette** commands take an explicit `Command.keys` (`'g s'`, `'mod+k'`) shown as kbd
chips; when a command omits it, the palette falls back to `findShortcutKeys` against the
registered `Shortcut[]` (matched by title) rather than showing no chip at all.

**Dialog** puts initial focus on the dialog's own heading, not its first control (typically
Close) — the first thing a screen reader announces is what the dialog is, not how to leave it —
unless the caller passes `initialFocusRef` (the command palette does, to keep focus on its search
field) or the dialog is `bare` (no heading to land on).

**The `/sessions` ledger** picks one of four column sets from the viewport width
(`routes/sessions/viewport.ts`, `useLedgerWidth()`): `full` (every column, from 1,440px), `rich`
(drops tool calls and agents, 1,220–1,439px), `mid` (title/started/duration/requests/cost,
701–1,219px), `narrow` (title and cost only, the rest folded into a meta line, up to 700px).
`LedgerTable`'s own `secondary` flag only has one step (drop under 900px), which is not enough for
an eleven-numeral-column table beside a 264px rail on top of a phone-width viewport.

## Data hooks (`lib/queries.ts`)

One hook per endpoint, all returning TanStack `UseQueryResult`:
`useStatus`, `useProjects(range)`, `useSessions(query)` / `useSessionsInfinite(query)`,
`useSession(id, whatIf?)`, `useTranscript(id, {agentId, fromSeq, limit, whatIf})`,
`useAgentTree(id, whatIf?)`, `useSearch(query)`, `useOverview(range)`, `useToolsAnalytics`,
`useModelsAnalytics`, `useHooksAnalytics`, `useAttributionAnalytics`, `useInsights`,
`usePricing`, `useSettings`. Mutations: `useUpdatePricing`, `useResetPricing`,
`useUpdateSettings`, `usePinSession` (takes a session id — the server *toggles*), `useReindex`.

Query keys come from `queryKeys.*`; never hand-roll one. Retries are transport-only
(`ApiError.retryable`), there is no background polling except `useStatus` while indexing.

**Invalidation.** The shell mounts exactly one `useIndexEventStream`, which subscribes to
`GET /api/events` and, per event, invalidates: `indexed` → everything; `sessionsChanged` →
`sessions`, `session`, `overview`, `projects`, `analytics`. `progress`/`error` only feed the
status pill. `server/sse.ts` emits **named** SSE frames, so `api.ts` registers one listener per
`IndexEvent['type']` (`EventSource.onmessage` alone never fires). The stream reconnects with
capped exponential backoff (1s → 15s), re-issuing the auth cookie each time; the backoff only
resets after a stream that stayed open ≥ 10s.

## URL state

- **Range** — `useDateRange()` reads/writes `?from&to&project` (local `YYYY-MM-DD`, the exact
  format the API wants). `.value` drives `<DateRange>`, `.query` is a `RangeQuery` for the hooks,
  `.setPreset/.setBounds/.setProject` write the URL with `replace: true`.
  Two rules follow from the server rather than from the UI, and both live in `lib/range.ts`:
  **an empty window is `30d`, not `all`** (`matchPreset(undefined, undefined) === '30d'`), because
  `DEFAULT_RANGE_DAYS` in `core/db/filters.ts` fills a missing bound with the last 30 days — the
  top bar used to highlight "All" over 30 days of data; and **`presetRange('all')` writes explicit
  bounds** (`ALL_TIME_FROM` = `2000-01-01` → today), because clearing `from`/`to` asks for the
  default, not for everything. Anything that *labels* a window should prefer the range the server
  echoed back (`overview.data.range`) over the URL.
- **What-if** — `useWhatIf()` reads/writes `?whatIf=opus-5>sonnet-5,fable-5-1>opus-5` and exposes
  `.param` (pass as `RangeQuery.whatIf`), `.map`, `.substitute(from, to)`, `.clear()`.
  Note: the server currently only threads `whatIf` on routes that parse `RangeQuery` — session
  detail / transcript / agents ignore it (see "Server patches needed" in the handover).

## Adding a page

1. `web/src/routes/<name>/Page.tsx` with a **default export** (plus `Page.module.css` if needed).
2. Register it in `web/src/app/routes.tsx`: `{ path: 'x', handle: { title: 'X' }, lazy: lazyPage(() => import('@/routes/x/Page')) }`.
   `handle.title` becomes `document.title` (`"X · AI Cost Analyzer"`).
3. Render exactly one `<h1>` — the shell moves focus to it after every navigation.
4. Loading → `<Skeleton>` or `<LedgerTable loading>`. Empty → `<EmptyState>`. Error → let it throw
   (the route `errorElement` is `RouteError`) or render a `<Callout tone="warn">` for a partial failure.
5. Need a project/agent tree in the rail? `useRailSlot(<TreeNav …/>, [deps])`.
6. Page-local shortcuts: `useShortcuts([{ id, keys: 'g x', description, group, run }])` — they show
   up in the `?` sheet automatically. Global `g <key>` bindings and the matching palette command
   live in `shell/AppCommands.tsx`; the rail entry is `NAV` in `shell/LeftRail.tsx`, and a new
   route also belongs in `STATIC_PAGES` (`scripts/screenshot.ts`) and `ROUTES`
   (`tests/e2e/helpers.ts`, which feeds both the smoke and the a11y suites).

### The prose pages

`/methodology` and `/how-it-works` are Markdown files the repo ships, rendered by
`components/DocPage`:

- `docs/METHODOLOGY.md` — how each number is computed, and which are estimates.
- `docs/HOW-IT-WORKS.md` — where the data comes from, when the index updates (startup rescan,
  the 3-second watcher quiet period, the SSE refresh), what is automatic, and that insights are
  deterministic rules computed per request.

`DocPage` takes `{ title, source, fallbackLead, sourcePath }`, where `source` is the file imported
with `?raw`, and owns everything both pages share: `splitTitle` (the doc's own `# Title` becomes
the page's lead so there is only one `<h1>`), the contents list built from the level-2 headings,
the prose styles (`DocPage.module.css`) and the renderer. `DocPage/markdown.tsx` is that renderer
— a small Markdown subset built entirely from React elements, no `dangerouslySetInnerHTML`, so an
angle bracket in a document is text and never markup. Links to an in-app path (`/methodology`)
become `<Link>`s and route client-side; everything else is a plain `<a>`, and a non-http(s) href
is dropped to literal text by `safeHref`. `splitTitle` lives in its own import-free module so
`tests/web/doc-page.test.ts` can reach it without aliases; the parser is unit-tested in
`tests/web/methodology-markdown.test.ts`. Adding a third prose page is a two-line `Page.tsx`.

## Conventions

- **Money is always `<Money>`**, tokens always `<Tokens>`, durations `<Duration>`. Never format a
  number inline: `lib/format.ts` re-exports `core/pricing/format.ts` so the UI and the CSV/JSON
  exports cannot disagree. Web-only additions: null tolerance, an optional display currency,
  `relativeTime`, `toIsoDay`/`fromIsoDay`, `truncate`, `truncateMiddle(text, max)` (keeps both
  ends, elides the middle — used for filesystem paths, e.g. `FirstRun`'s roots list), padded
  `formatDuration`, and a `formatPercent` that renders `<0.1%` instead of `0.0%`. `plural`/
  `pluralNoun` (a count-aware noun, and just the noun for a sentence that already prints the
  number) live in `core/pricing/format.ts` itself, imported with `@core/…` rather than through
  `lib/format.ts`.
  `formatDuration` rounds to the precision it is about to print **before** splitting into units,
  so a remainder cannot carry into an impossible digit (`239_600 ms` is `4m 00s`, never `3m 60s`).
  `lib/range.ts` adds day-grained range helpers beyond `useDateRange()` itself:
  `formatRangeSentence(from, to)` (the sentence form used in captions and empty states),
  `dayCount(from, to)`, `eachDay(from, to)` and `fillDailySeries(rows, from, to, empty, maxDays?)`
  — which zero-fills a sparse `{date}[]` (the API returns one entry per non-empty day) to one row
  per day across the window, so a strip never silently drops a day that billed nothing. Past
  `MAX_DENSE_DAYS` (400 — the point past which a daily strip stops being readable at any width,
  and the `all` preset's ~9,700-day span would otherwise materialize) it falls back to the extent
  of the data actually present, unfilled, instead of the requested window.
  `lib/format.ts` and `lib/range.ts` are imported by `tests/web/*`, which typechecks under
  NodeNext — keep their imports relative with an explicit `.js`, never `@core/…`.
- **`<EstimateBadge>` next to every attributed number** (tool/hook/injection cost). Request costs,
  the category split and session totals are exact and must not carry it.
- **Every chart goes through `ChartFrame`** with a one-sentence `summary` and a `table` prop
  rendering the same numbers in a `LedgerTable`. Focusable marks need an `aria-label` each.
- **Colour is never the only channel**: `ModelChip` pairs a hue with a glyph, chart fills pair a
  hue with a pattern (`TOKEN_CLASS_PATTERN`), status pills pair a dot with text.
- **Tokens, not literals.** Model hues `--m-opus|sonnet|haiku|fable|mythos|other` (or
  `MODEL_FAMILY_COLOR`), token classes `--t-output|input|cache-write|cache-read` (or
  `TOKEN_CLASS_COLOR`), heat ramp `--heat-0…4` (`heatStep()`). One red (`--cost`), one green
  (`--save`). Spacing `--s1…--s8`, radii `--r1…--r3`, type `--fs-12…--fs-56` — nothing off-scale.
  Hairlines (`--rule`, `--rule-strong`), no shadows except `--elevation` on dialogs/popovers.
- **CSS Modules**: `Name.module.css` beside the component, camelCase class names, one file per
  component. Global helpers live in `utilities.css` (`stack`, `cluster`, `truncate`, `panel`,
  `grid-kpis`, `visually-hidden`) and `typography.css` (`display`, `eyebrow`, `num`, `num-display`,
  `mono`, `muted`, `prose`). `num`/`num-display` are mandatory on anything numeric.
- **Theme**: `useTheme()` → `{theme, resolved, setTheme, cycleTheme}`, persisted at `cca.theme`,
  applied as `data-theme` on `<html>` before first paint. Never read a colour in JS except through
  `getComputedStyle` (see the gallery's swatch grid).
- **a11y primitives** in `lib/a11y.ts`: `useAnnounce`, `useRovingTabIndex`, `useFocusTrap`,
  `useBackgroundInert`, `useClickOutside`, `usePrefersReducedMotion`. In a modal, call
  `useBackgroundInert` *before* `useFocusTrap` — cleanups run in declaration order and focus
  cannot be restored into an inert subtree.
- **Never render transcript text into a `title`, a log or an error message.** `RouteError` prints
  error classes only. A session title, an agent's `description` and a turn preview are the
  exceptions: they are already the visible label, and truncate too hard to read without one.
- **Names, not identifiers.** `lib/tools.ts` turns `mcp__<server>__<tool>` into something a
  reader can use, and knows that a claude.ai connector's "server" is a UUID — those lead with
  the tool (`slack_send_message (connector)`), because a receipt row truncates and used to show
  the id and nothing else. `routes/session/labels.ts` does the same for a workflow run
  (`Workflow run 18830d24-fec`) and a subagent (its `description`, else its `agentType`).
- **Prompt text** goes through `routes/session/transcript/prompt.ts`: `cleanPromptText` strips
  the `<command-…>` and `<system-reminder>` wrappers (turn headers and the timeline both need
  it — the server's `promptPreview` is the raw line), and `commandOnlyPrompt` names a prompt
  that was nothing but a slash command, which the transcript draws as one muted mono line
  rather than a card.
- **Live regions say less than the screen.** The index pill's visible text counts files one by
  one; its `role="status"` copy moves in tenths, so a whole index is at most eleven sentences.
  Settings' index progress is a `role="progressbar"`, and `HeatStrip`'s readout is not a live
  region at all — every day is a button carrying its own label, so focusing one already says it.
- **Print** (`design/base.css`): the top bar, rail, session action buttons, tab strip and every
  chart's view toggle carry `data-print-hide`; sections, figures and panels are
  `break-inside: avoid`, so a session prints as the exact receipt on page one and the estimated
  split on page two.

## Shell behaviour worth knowing

- **The empty-index panel.** `shell/FirstRun.tsx` is what every data page shows in place of its
  own content when the index is empty (SPEC §8.4) — otherwise each page said "no rows match your
  filters," blaming the reader's own filters for a missing transcript directory. `Shell.tsx`'s
  `needsIndex(pathname)` swaps it in for `/`, `/sessions`, `/search`, `/analytics*`, `/insights`
  and `/compare`; Settings, the two prose pages (`/methodology`, `/how-it-works`) and the design
  gallery still render their own page — those work with nothing indexed, so they stay in
  `INDEX_FREE_ROUTES`. It lists the roots the server actually resolved
  (`StatusResponse.roots`, truncated with `truncateMiddle`) and a "Re-index now" button.
- **Boot-time settings.** `App.tsx` renders a tiny `MotionPreference` component that applies
  `settings.reducedMotion` through `lib/motion.ts` on every page. The Settings page still calls
  `applyMotionPreference` on its *draft*, for a live preview before saving.
- **Session bootstrap.** `lib/api.ts` awaits `ensureSession()` (`POST /api/auth/session`) before
  the first request rather than eating a 401 and retrying. The retry is still there as a fallback,
  but reaching it is a defect: `tests/e2e/helpers.ts` fails any 4xx, 401 included.
- **The bar under 720px.** The search field refuses to shrink past 160px, so below 720px it is
  hidden (it used to spill over the wordmark and push the theme toggle off-screen at 320px) and
  the wordmark truncates. `/` then opens `/search` instead of focusing an element that is not
  laid out; the rail's Search entry and ⌘K are unaffected.
- **The rail drawer** (below 1024px) closes on Escape and hands focus back to its toggle
  (`[data-rail-toggle]`), like every other overlay.
- **`/` on the search page.** The top bar owns the global `/`. On `/search` the page owns a field
  of its own, so `GlobalSearch` forwards focus to `[data-page-search]` when
  `location.pathname === '/search'` instead of stealing the keystroke.
- **Navigation shortcuts** live in `shell/AppCommands.tsx`, not `lib/keyboard.ts` (which owns the
  matching engine, `?` and `⌘K`): `g o s f a i c , m`. `g c` is Compare, which is also a rail
  entry between Insights and Settings.
- **Rail project rows** show the session count in `--ink-2` mono and then the cost. The count is
  `aria-hidden`, with a spelled-out "N sessions with requests in range," beside it — a tree item's
  accessible name is its contents, and bare digits ran into the money.
- **Counts that disagree on purpose.** The overview KPI is labelled "Sessions with requests" and
  the `/sessions` list counts by start date; `hideScratchProjects` hides a further slice, reported
  as `StatusResponse.scratchSessions` and printed in the index-status tooltip, Settings › Data and
  the sessions footer. See `docs/dev/integration.md` for the two semantics.
- **Transcript turns.** `[` / `]` resolve the anchor from the live `scrollTop`
  (`virtualizer.getVirtualItemForOffset`), not `getVirtualItems()[0]` — that list starts above the
  viewport by `overscan`, so the jump used to stick after one press. The turn header carries
  `tabIndex={-1}` + `data-turn` and takes focus, so the jump is announced and Tab carries on.
- **Contrast on tinted rows.** A row is not always drawn on bare paper: hover mixes 3.5% ink into
  it and the current row mixes in `--info`. In the dark theme that *lightens* the row. `--ink-3`
  is `#948D80` in slate and `LedgerTable`'s current-row tint is 8% (not 10%) so the secondary
  text under a session title clears 4.5:1 on both; `tests/web/tokens.test.ts` checks both tints.
  `TreeNav`'s `.meta` is `--ink-2`: `--ink-3` measures 4.32:1 on the selected row's tint and fails AA. `Kpi`'s label row reserves two lines so a long label does not
  push its numeral out of line with the rest of a KPI row.

## Checks

`npx tsc -p tsconfig.web.json --noEmit` · `npx vite build` · `npx vitest run tests/web`.
`scripts/screenshot.ts` also writes `hero-overview.paper.png` and `hero-session.paper.png` for
the executive summary; run it against the **built** server, not the vite dev server.
`tests/web/tokens.test.ts` parses `tokens.css` directly: keep both palette blocks the same size,
one `--name: value;` per line, and the `prefers-color-scheme: dark` copy identical to
`[data-theme='slate']`. Axe on `/design` is clean in both themes, including the dialog, palette,
shortcuts sheet, popover, tooltip, toast and every chart's table view.

## The estimated split: baseline and re-sent history

`CategoryShare.estimated` now carries two more buckets, and both receipts name them
(`docs/METHODOLOGY.md` §3):

- **`baseline`** — "Baseline context (system prompt, tools, memory)": the floor every request
  carries from the first one on, plus the post-compaction floor.
- **`assistantHistory`** — "Assistant replies re-sent as history": the ingest + carry of Claude's
  own earlier replies. Distinct from `assistantOutput`, which is the exact cost of *generating*
  them and is not part of the context split.

Both are optional on the type, so read them as `est.baseline ?? 0`.

`web/src/routes/session/receipt.ts` is the single source for the session's on-screen receipt and
its Markdown clipboard copy: `estimatedAmounts()` builds the rows in context order (baseline,
assistant output, prompts, tool results by tool, re-sent history, hooks, harness, system prompt,
compaction summaries, other), `estimatedResidual()` reconciles them to the exact total, and both
receipts end on that exact total row. The residual is labelled **Not attributed**, or **Estimation
overshoot** when it is negative because the token estimates placed more money than the session
cost; either way the label is a `Tooltip` trigger carrying `RESIDUAL_EXPLANATION`. `ESTIMATE_DETAIL`
is the one sentence naming the two new categories — pass it as `EstimateBadge detail` and reuse it
in any copy that explains the estimate, so the overview and the session page stay in step.
The overview's `CategorySplit` lays the same categories out differently (tool subtotal, indented
tools, percentage notes) but imports those two constants rather than restating them.

With the real `~/.claude/projects` indexed, the whole-history residual is now −0.65 % of spend
(an overshoot), and a large single session lands around 10–13 %.
