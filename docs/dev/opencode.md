# OpenCode local source

`core/opencode/` adapts [OpenCode](https://opencode.ai) sessions. OpenCode stores everything in one
SQLite file, `opencode.db`, under `$XDG_DATA_HOME/opencode` (default `~/.local/share/opencode`, also
on macOS and Windows). `server/opencode-paths.ts` resolves that location; the database is only
auto-detected when it exists. `--opencode-dir` / `CCA_OPENCODE_DIR` accept the data directory or the
`.db` file, and an explicit selection replaces the automatic defaults.

The directory also holds `auth.json`, logs, repositories and snapshots. Nothing but the database is
opened (read-only, with a busy timeout, so a running OpenCode is not disturbed), and only the
session, message and part tables are queried — never the credential, account or config tables.

## Storage layouts

Both are read; if a session id exists in both, the newer layout wins.

| | legacy | newer |
|---|---|---|
| sessions | `session` | `session_v2` |
| messages | `message` (JSON `data`, ordered by time) | `session_message` (JSON `data`, ordered by `seq`, typed `user`/`assistant`/`system`/`idle`/`synthetic`) |
| content | `part` rows (`text`, `reasoning`, `tool`) | inline in the assistant message's `content` array |

Child sessions (`parent_id`) are subagent runs: discovery folds them into their top-level ancestor
as `subagent` files, exactly like Codex threads.

## Mapping

- **Session id** `opencode-<id>`; project = exact `directory`, so it merges with the same folder
  from other tools.
- **File identity** — many sessions share one database, so each gets a virtual path
  `<db>#opencode:<id>`. Its `size` is the stored message/part byte count and `mtimeMs` the latest
  update time, so only changed sessions re-parse. The watcher listens for `opencode.db` and
  `opencode.db-wal` (non-recursively) and `indexChangedFiles` maps both to the owning sessions.
- **Transcript lines** are rebuilt as Claude-shaped lines; seq is the array index (no byte ranges).
  `readOpenCodeSessionLines` serves the transcript viewer.
- **Tokens** — `input` excludes cache; `output` excludes `reasoning`. Output = output + reasoning,
  thinking = reasoning, cache read/write map to the cache buckets. (Checked against stored costs:
  OpenCode prices reasoning at the output rate on top of `output`.)
- **Models** — the bare model id; gateway prefixes (`anthropic/`, `copilot/`) are stripped when
  resolving prices. Unknown models stay unpriced.
- **Cost** — OpenCode's own `cost` is not used. Amounts are API-price estimates.
- **Missing telemetry** — an assistant message with content but no `tokens` marks the session
  `usageIncomplete`; messages with no content and no tokens (for example errors) add nothing.
- **Titles** — OpenCode's generated title is used unless it is the `New session - …` /
  `Child session - …` placeholder.
- **Not available** — hooks, skills, workflows, reported-cost tallies, tool→child-agent links.

## Tests

`tests/helpers/opencode-db.ts` builds synthetic databases in both layouts; tests never touch a real
`opencode.db`. For browser coverage set `CCA_E2E_OPENCODE_DIR` to a directory containing a synthetic
database.
