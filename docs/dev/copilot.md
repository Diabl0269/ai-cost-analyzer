# Copilot local sources

`core/copilot/` adapts local GitHub Copilot sessions. CLI and the Copilot app share
`~/.copilot/session-state/<session>/events.jsonl` ([GitHub session data docs](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/session-data)).
The importer opens only these event files, never auth/config files or the duplicate session-store database.

VS Code, Code Insiders and VSCodium stores are detected when present, including local
`.vscode-server` stores. Workspace `chatSessions` and `globalStorage/emptyWindowChatSessions`
snapshots (`.json`) and mutation journals (`.jsonl`) are reconstructed using the
[VS Code mutation log format](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/model/objectMutationLog.ts).
Only sessions with explicit GitHub Copilot agent/model identities are imported.
Use `--copilot-dir` / `CCA_COPILOT_DIR` for a Copilot home, session-state directory,
single CLI session folder, VS Code User/workspaceStorage/chatSessions directory, or mounted editor store.
`COPILOT_HOME` changes the default CLI/app home. Explicit sources replace automatic defaults.
Existing default Claude/Codex settings upgrade to include Copilot; custom roots stay unchanged.

## Usage and estimates

[GitHub documents](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing)
per-call `assistant.usage` events as ephemeral. Durable shutdown modelMetrics and newer
usage-checkpoint accountingSnapshot modelMetrics are cumulative per-model totals, including
resumes. The parser reconciles these against captured per-call records and prior snapshots;
it does not add mirrored totals twice. The adapter treats input as including cache buckets and reasoning as within output. Cache inclusion is an estimation assumption: [upstream issue #2834](https://github.com/github/copilot-sdk/issues/2834) leaves runtime confirmation open; do not present this normalization as a verified billing fact. Counter decreases across older resumed processes are marked partial rather than silently summed.
Missing telemetry is unavailable, never an exact zero. A recorded zero is retained as zero.

Aggregate rows are accounting buckets, not recovered API calls. These buckets are excluded from API request counts, so a session with only aggregate telemetry has zero recorded individual calls while retaining its tokens and costs. Cost timelines are unavailable for aggregate-only histories. We do not invent per-turn/per-tool allocation, request context sizes or long-context
surcharges; aggregate prices use configured base API rates. These limits are stated in session
headers and exported receipts. All monetary amounts are API list-price estimates; premium request
multipliers and AI credits are not USD and are never priced as money.

VS Code saved chat context counters do not establish total billed API usage. These chats retain
prompts, responses, tools, titles and models, but costs remain unavailable. Journal display uses
virtual sequence numbers and reconstruction from the original file, rather than invalid byte ranges.

GitHub-hosted cloud-only sessions, other IDE-specific stores (JetBrains/Visual Studio/Xcode),
inline completion history and unavailable/deleted local records are not imported. Remote VS Code
stores require an explicit mounted transcript root; no SSH, GitHub API or account billing calls occur.

## Checks

Synthetic fixtures live under `tests/fixtures/copilot` and `tests/fixtures/copilot-vscode`.
Parser, store, pricing and source-selection tests run with `npm test`. For mixed-provider browser
checks set `CCA_E2E_CODEX_DIR=tests/fixtures/codex` and
`CCA_E2E_COPILOT_DIR=tests/fixtures/copilot`, then run `npm run test:e2e`.
