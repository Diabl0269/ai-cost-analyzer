# How this app works, end to end

A local reader over history that Claude Code, Codex, GitHub Copilot and OpenCode have already written
to disk. Nothing here talks to any of those vendors, and
there is no job to start: the index follows the transcripts, and the numbers are computed when you
ask for them.

## Where the numbers come from

Claude Code stores each conversation as a JSONL file under
`~/.claude/projects/<project>/<session>.jsonl`, and gives subagents (the `Agent` tool) and
workflow agents their own files under `<session>/subagents/`. Every assistant line carries the
`usage` block the API returned for that request: input, output, thinking, cache reads and cache
writes.

Codex, Copilot and OpenCode (a SQLite database) store comparable per-request token counts in their
own formats; the adapters under `core/` normalise each into the same shape. See the README for
the locations. This app reads those files and nothing else. No API key, no account, no network call. If a session
is on disk it can be priced; if it is not, no amount of re-indexing will find it. The directories
being read are listed in **Settings › Data**; a `--claude-dir` flag or `CCA_CLAUDE_DIR` overrides
the roots in `~/.claude-cost-analyzer/config.json`.

## When the index updates

Automatically, in three steps.

1. **At startup**, the server compares every transcript file's size and modification time against
   what the index recorded, and re-parses only the sessions whose files differ. A first run differs
   in everything, so the first index is the slow one; later starts are quick.
2. **While it runs**, a recursive watcher (`fs.watch`) sits on each root and notices writes to
   `.jsonl`, `.meta.json` and `custom-title.json` files (and OpenCode's `opencode.db`). A file is left alone until it has been
   quiet for **3 seconds**, so a session being written to right now is not parsed mid-write; the
   settled files are then batched and re-parsed. Indexing happens on a worker thread, one run at a
   time, and requests that arrive during a run are coalesced into the next one.
3. **The browser is told over a server-sent events stream** (`/api/events`): index progress, then
   an `indexed` event that makes the UI drop its cached answers and refetch. The pill in the top
   bar is the visible half of this. **Up to date · hh:mm** is the clock time at which the last
   index run finished — not the time of the last transcript write — and the dot beside it is the
   state of the event stream. `Indexing 12/240` counts files.

A root the operating system refuses to watch is skipped with a warning instead of crashing the
server; changes under it are picked up on the next start or manual re-index.

Manual re-indexing covers what automation cannot: **Settings › Data** offers *Re-scan all
roots* and *Rebuild from scratch*, the command palette has the same two, and
`npm run reindex` (the built server with `--reindex`) rebuilds from the terminal and exits. Reach for it after pointing
the app at a different transcript root, or if a session on disk never appears. A schema change
needs nothing — the index is a cache keyed by a schema version, and a mismatch rebuilds it on the
next start. In normal use: never.

## What is computed, and when

The database stores token counts only — integers. Every dollar figure is
`tokens × the current price table`, computed at read time on each request, which is why editing a
price in Settings or running a what-if swap re-prices the whole history immediately with no
re-index.

Request, session and per-model costs are exact. Splitting a request's cost across the things that
filled its context — a tool result, a hook's output, a system reminder, your prompt — is an
allocation rather than a billed figure, and always carries an **est.** badge; the rules are in
[Methodology](/methodology).

## How insights are generated

The Insights page runs a fixed set of deterministic rules over the index for exactly the date
range and project filter you are looking at:

- **Tool-output carry** — which tool's results cost the most just to stay in context.
- **Compaction re-warm** — what the first request after each compaction paid in cache writes.
- **Cold-cache requests** — large prompts that paid full write price with no cache read.
- **Idle-gap expiry** — cold requests that follow a gap longer than the cache TTL.
- **Long-context sessions** — sessions averaging above 150K context per request.
- **Model-mix price swaps** — the same tokens re-priced at a cheaper model's list prices.
- **Subagent model mix** — what delegated work cost, and on which models.
- **Harness overhead** and **hook overhead** — estimated cost of injected context.
- **Slow hooks** — the hook that spent the most wall time blocking turns.
- **Cost per prompt by project** — the project with the highest cost per prompt.

No AI model is involved. Nothing is sent anywhere, and reading this page consumes none of your
Claude usage. There is nothing to run or schedule: change the range or the project filter and the
findings are recomputed from the index, in the same request that draws the page.

## What you can do about it

Each finding points at one lever: which model ran the work, how long a session grew before a
`/clear` or compaction, how much tool output was pulled into context, and which hooks inject text
or block turns. The list is ranked by money, so the top one is where to start.

For deciding rather than fixing: what-if pricing re-prices a range at other models or prices
without touching the index, **Settings › Plan** compares the same usage against a subscription, and
**Settings › Budget** drives the forecast on the overview.

## Privacy

The server listens on `127.0.0.1` only, checks the `Host` and `Origin` of every request, and
requires a session cookie it hands to the page that loaded it. The index is a rebuildable cache in
`~/.claude-cost-analyzer`, directory mode `0700` and files `0600`. Transcripts are read where they
are and never copied. There is no telemetry and no outbound request of any kind.
