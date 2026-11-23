# Gemini CLI & Google Antigravity local sources

`core/gemini/` adapts both [Gemini CLI](https://github.com/google-gemini/gemini-cli) and
[Google Antigravity](https://antigravity.google) (`agy`, Antigravity Desktop / 2.0, and Antigravity IDE)
into the `gemini` provider.

## Storage locations

`server/gemini-paths.ts` resolves the transcript roots under `~/.gemini` (or `$GEMINI_CLI_HOME/.gemini`):

- **Gemini CLI** — `~/.gemini/tmp/<project>/chats/session-*.jsonl` and legacy `session-*.json`
- **Google Antigravity** — `~/.gemini/antigravity/brain`, `~/.gemini/antigravity-cli/brain`, and
  `~/.gemini/antigravity-ide/brain` (`<conversation-id>/.system_generated/logs/transcript_full.jsonl`
  with fallback to `transcript.jsonl`)

Existing directories among those roots are auto-detected on default configurations. `--gemini-dir` /
`CCA_GEMINI_DIR` accept `~/.gemini`, an Antigravity app folder, a `brain` directory, a `tmp` or
`chats` directory, or a synthetic fixture folder. `~/.gemini` itself and `antigravity*` parent
directories remain in `rootsPolicy.ts` sensitive paths because they hold `oauth_creds.json`,
`google_accounts.json`, `mcp_config.json`, and `settings.json`; only the `tmp` and `brain` subtrees
are allowed, and `conversation_summaries.db` / `projects.json` are read selectively for metadata only.

## Mapping & accounting

- **Session IDs & projects** — Antigravity conversations use `antigravity-<uuid>` (`entrypoint`:
  `antigravity` or `antigravity-cli`); Gemini CLI sessions use `gemini-<id>` (`entrypoint`:
  `gemini-cli`). Antigravity `cwd` comes from `workspace_uris` (`file://` URIs) in read-only
  `conversation_summaries.db`; Gemini CLI `cwd` comes from `<project>/.project_root` or
  `~/.gemini/projects.json`. Exact `cwd` paths merge into the same project folder as Claude Code,
  Codex, Copilot, and OpenCode.
- **Subagents** — Antigravity child conversations (`parent_conversation_id` / `conversation_parents`
  and `invoke_subagent` tool calls) and Gemini CLI `parentSessionId` sessions are folded into their
  top-level ancestor's `agentFiles` so delegated spend lands in `costAgents`.
- **Prompts** — `core/gemini/prompts.ts` unwraps `<USER_REQUEST>` envelopes and strips trailing
  `<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`, `<SYSTEM_MESSAGE>`, and `<EPHEMERAL_MESSAGE>`
  blocks, attributing envelope characters to `antigravity_context` and marking pure system wakeups
  `isMeta: true` so they never inflate human prompt counts.
- **Token normalization**:
  - *Antigravity* `PLANNER_RESPONSE` steps report `input_tokens` already net of `cache_read_tokens`,
    and `output_tokens` already inclusive of thinking tokens.
  - *Gemini CLI* `tokens` records Gemini API `UsageMetadata`: `input` (`promptTokenCount`) includes
    `cached` (`cachedContentTokenCount`), `tool` is `toolUsePromptTokenCount`, and `thoughts` is
    separate from `output` (`candidatesTokenCount`). Uncached input is `(input + tool) - cached`,
    and billed output is `output + thoughts` (with `thoughts` preserved as `thinking`).
- **Models & pricing** — `defaultGoogleModels()` (`core/pricing/defaults.ts`) ships published Google
  AI Studio / Gemini API paid-tier rates across Gemini 4 (`carbon`, `argon`, `neon`, `hydrogen`),
  Gemini 3 (`3.8-flash`, `3.7-flash`, `3.6-flash`, `3.5-flash`, `3.5-flash-lite`, `3.1-pro`,
  `3.1-flash-lite`, `3-pro`, `3-flash`), Gemini 2.5 (`2.5-pro`, `2.5-flash`, `2.5-flash-lite`), and
  retired `2.0-flash`, including `>200K` context multipliers on Gemini 3 / 3.1 / 2.5 Pro.
  `resolve.ts` maps Antigravity thinking-tier suffixes (`-minimal`, `-low`, `-medium`, `-high`,
  `-xhigh`) and `google/` / `models/` prefixes to the underlying model while keeping router aliases
  such as `gemini-pro-orchestrator` unpriced unless configured by the user.
- **Missing telemetry** — assistant messages or steps without token counters mark `usageIncomplete`
  and record `recordedModels` rather than reporting `$0.00`.

## Tests

Synthetic builders live in `tests/helpers/gemini-fixture.ts` and `tests/fixtures/gemini`. Unit and
store tests live in `tests/core/pricing/gemini.test.ts`, `tests/core/parse/gemini.test.ts`, and
`tests/core/db/gemini.test.ts`. Set `CCA_E2E_GEMINI_DIR=tests/fixtures/gemini` for browser E2E checks.
