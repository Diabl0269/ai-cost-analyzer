# Synthetic fixtures

Everything here is invented. No line was copied from a real transcript; the *shapes* follow
SPEC §3, the *content* does not exist anywhere. Two roots:

| root | used for |
|---|---|
| `tests/fixtures/projects` | the main `~/.claude/projects` stand-in (unit tests, e2e via `CCA_CLAUDE_DIR`) |
| `tests/fixtures/legacy-projects` | older on-disk shapes: project-level `agent-*.jsonl`, embedded sidechains, a malformed line, an unknown attachment type |

`projects/` is a shared asset: other modules assert against the numbers below, so **adding lines to
it changes their expected totals**. Put new edge cases in `legacy-projects/` (or a temp file) unless
the case genuinely belongs to the shared tree.

Prices used throughout are the SPEC §5.2 defaults (USD per MTok):

| model | in | out | write 5m | write 1h | read |
|---|---|---|---|---|---|
| `claude-opus-5`, `claude-opus-4-8` | 5 | 25 | 6.25 | 10 | 0.5 |
| `claude-sonnet-5` | 2 | 10 | 2.5 | 4 | 0.2 |
| `claude-haiku-4-5-20251001` | 1 | 5 | 1.25 | 2 | 0.1 |
| `claude-fable-5-1` | 10 | 50 | 12.5 | 20 | 0.25 |
| `<synthetic>` | 0 | 0 | 0 | 0 | 0 |

---

## `projects/` layout

```
-Users-dev-projects-alpha/                              cwd /Users/dev/projects/alpha
  a1111111-…111.jsonl                                   session A1
  a2222222-…222.jsonl                                   session A2
  a2222222-…222/subagents/agent-b1000000000000001.jsonl + .meta.json   (sync Agent, model "sonnet")
  a2222222-…222/subagents/agent-b2000000000000002.jsonl + .meta.json   (async Agent, model "haiku")
  a2222222-…222/subagents/agent-b3000000000000003.jsonl + .meta.json   (nested, spawnDepth 2, parent b1…)
  a2222222-…222/subagents/workflows/wf_test1/agent-c1000000000000001.jsonl + .meta.json
  a2222222-…222/subagents/workflows/wf_test1/agent-c2000000000000002.jsonl + .meta.json
  a2222222-…222/subagents/workflows/wf_test1/journal.jsonl
  a2222222-…222/tool-results/ignored.txt                MUST be skipped by discovery
  a2222222-…222/workflows/scripts/review.js             MUST be skipped by discovery
  a3333333-…333.jsonl                                   session A3
  a3333333-…333/custom-title.json                       {"customTitle":"Compaction and fallback"}
  sessions-index.json                                   entries for A1, A2, A3
  memory/notes.md                                       MUST be skipped by discovery
-Users-dev-projects-alpha--claude-worktrees-feature-x/  cwd …/alpha/.claude/worktrees/feature-x
  b1111111-…111.jsonl                                   session W1
-private-var-folders-zz-T/                              cwd /private/var/folders/zz/T (scratch)
  c1111111-…111.jsonl                                   session S1
```

Discovery yields 5 sessions, 10 transcript files, 0 warnings.

---

## Session A1 — `a1111111-1111-4111-8111-111111111111`

Title `Rename the utils helper` (source `ai-title`). 30 lines, 23 messages, 3 human turns,
7 assistant lines → **4 requests**, 3 tool calls, 5 hook runs, 10 injections, 0 parse errors.

Exercises: streaming placeholder dedup (`output_tokens: 5` first line), `apiBlockIndex` block
merging written out of order, a `SessionStart` hook whose stdout is injected, a
`UserPromptSubmit` `hook_additional_context`, a `hook_blocking_error`, a `stop_hook_summary` with
two `hookInfos`, `total_tokens_reminder` (no `rendered`) vs `skill_listing` (with `rendered`),
`task_reminder`, `turn_duration`, `local_command`, `ai-title`, `pr-link`, `cost-state`, `mode`,
`permission-mode`, `queue-operation`, and an ignored `last-prompt`.

| request | seq | lines | turn | model | input | write 5m | read | output | thinking | context | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `msg_a1r1` | 4 | 2 | 1 | opus-5 | 10 | 20 000 | 0 | 200 | 50 | 20 010 | $0.130050 |
| `msg_a1r2` | 9 | 1 | 2 | opus-5 | 6 | 1 000 | 20 000 | 300 | 0 | 21 006 | $0.023780 |
| `msg_a1r3` | 11 | 3 | 2 | opus-5 | 4 | 500 | 21 000 | 400 | 100 | 21 504 | $0.023645 |
| `msg_a1r4` | 20 | 1 | 3 | haiku-4.5 | 6 735 | 0 | 0 | 18 | 0 | 6 735 | $0.006825 |

`msg_a1r4` is the SPEC §5.2 sanity anchor: 6 735 in + 18 out = exactly $0.006825.
`msg_a1r3` merges to blocks `thinking, text, tool_use` even though the file order is
`thinking, tool_use, text`.

- opus-5 subtotal **$0.177475** — 20 in, 900 out (150 thinking), 21 500 write 5m, 41 000 read
- haiku-4.5 subtotal **$0.006825**
- **session total $0.184300**, which equals the `cost-state` line exactly (`totalCostUSD: 0.1843`).
  The `cost-state` model key is `claude-opus-5[1m]` on purpose: the `[1m]` suffix must survive
  parsing and be stripped only at price-matching time.

Tool calls: `Bash` (req 4 → result 6, 1 200-char string result), `Read` (req 9 → result 10,
54-char `text` result), `Edit` (req 11 → result 14, 30-char string result). All three answered.

Injections (392 chars total):

| seq | kind | name | chars | source |
|---|---|---|---|---|
| 0 | `hook_stdout` | `SessionStart:startup` | 30 | content |
| 1 | `attachment` | `total_tokens_reminder` | 47 | content |
| 2 | `user_prompt` | `prompt` | 48 | content |
| 3 | `hook_context` | `UserPromptSubmit` | 39 | content |
| 7 | `attachment` | `task_reminder` | 33 | content |
| 8 | `user_prompt` | `prompt` | 41 | content |
| 15 | `hook_blocking` | `PostToolUse:Edit` | 41 | content |
| 16 | `hook_context` | `stop_hook_summary` | 11 | content |
| 19 | `user_prompt` | `prompt` | 24 | content |
| 21 | `attachment` | `skill_listing` | 78 | rendered |

`skill_listing` carries both `content` (41 chars) and `rendered` (78 chars); `rendered` wins.

Hook runs: `success` (seq 0, 42 ms), `additional_context` (seq 3), `blocking_error` (seq 15),
and two `stop_summary` runs from one line (seq 16, `./scripts/lint.sh` 120 ms and
`./scripts/notify.sh` 30 ms). The 11 injected chars are attributed to the first of the two.

Facts: `pr-link` #42 on `dev/alpha`, `localCommands ["/status"]`, `queuedOperations 1`,
`turnDurationsMs [45000, 12000]`, `mode normal`, `permissionMode auto`.

---

## Session A2 — `a2222222-2222-4222-8222-222222222222`

Title `Build failure triage` (source `custom-title`). Delegation session: 21 lines across
6 transcripts, 20 messages, 10 requests, 4 tool calls, 6 injections (186 chars), no hooks.

Main transcript (4 opus-5 requests, all in turn 1):

| request | seq | input | write 5m | read | output | context | cost |
|---|---|---|---|---|---|---|---|
| `msg_a2r1` | 1 | 8 | 10 000 | 0 | 150 | 10 008 | $0.066290 |
| `msg_a2r2` | 3 | 4 | 500 | 10 000 | 100 | 10 504 | $0.010645 |
| `msg_a2r3` | 5 | 4 | 400 | 10 500 | 90 | 10 904 | $0.010020 |
| `msg_a2r4` | 7 | 4 | 300 | 10 900 | 60 | 11 204 | $0.008845 |

Main subtotal **$0.095800**.

Children (never added into the main transcript's own totals):

| agent | file | model | requests | tokens (in / w5m / read / out) | cost |
|---|---|---|---|---|---|
| `b1000000000000001` | `subagents/` | sonnet-5 | 2 | 6 / 6 200 / 6 000 / 350 | $0.020212 |
| `b2000000000000002` | `subagents/` | haiku-4.5 | 1 | 3 / 2 000 / 0 / 80 | $0.002903 |
| `b3000000000000003` | `subagents/` (nested) | haiku-4.5 | 1 | 2 / 1 000 / 0 / 40 | $0.001452 |
| `c1000000000000001` | `workflows/wf_test1/` | sonnet-5 | 1 | 3 / 3 000 / 0 / 120 | $0.008706 |
| `c2000000000000002` | `workflows/wf_test1/` | haiku-4.5 | 1 | 3 / 1 500 / 0 / 60 | $0.002178 |

**Session total $0.131251** (main $0.095800 + agents $0.024567 + workflow $0.010884).

Links to assert:

- `toolu_a2_agent_sync` → `childAgentId b1000000000000001`, `childDescription "Trace build failure"`,
  `durationMs 90014` (sync result, no `resolvedModel`).
- `toolu_a2_agent_async` → `childAgentId b2000000000000002`,
  `childModel claude-haiku-4-5-20251001` (async `resolvedModel`).
- `toolu_a2_workflow` → `childRunId wf_test1`, no `childAgentId`.
- `agent-b1000000000000001` has one `Bash` tool call of its own (4 tool calls in the session).
- `agent-b3000000000000003.meta.json` has `parentAgentId b1000000000000001`, `spawnDepth 2`.
- `wf_test1/journal.jsonl` → `{ started: 2, result: 1, failed: 1 }`.

---

## Session A3 — `a3333333-3333-4333-8333-333333333333`

Title `Compaction and fallback` (source `custom-title-file`). `entrypoint claude-desktop`,
`sessionKind bg`. 9 lines, 8 messages, 1 turn, 4 requests (one of them synthetic), 1 compaction,
1 API error, 2 injections (191 chars: 39-char prompt + 152-char compact summary).

| request | seq | model | billed as | input | write 5m | read | output | cost |
|---|---|---|---|---|---|---|---|---|
| `msg_a3r1` | 1 | sonnet-5 | top-level usage | 5 | 8 000 | 0 | 250 | $0.022510 |
| `msg_a3r2` | 4 | opus-4.8 | iteration 1 — `claude-fable-5-1`, `message` | 2 | 0 | 30 000 | 100 | $0.012520 |
| | | | iteration 2 — `claude-opus-4-8`, `fallback_message` | 2 | 1 000 | 20 000 | 500 | $0.028760 |
| `msg_a3r3` | 5 | `<synthetic>` | excluded | 0 | 0 | 0 | 0 | $0 |
| `msg_a3r4` | 7 | sonnet-5 | top-level usage | 3 | 500 | 21 000 | 120 | $0.006656 |

`msg_a3r2` must bill **both** iterations ($0.041280 together), not the top-level usage alone —
the top-level usage equals only the last iteration. `isFallback` is true.

**Session total $0.070446.** Compaction: `trigger auto`, `preTokens 180 000`,
`postTokens 14 000`, `durationMs 9 000`, `cumulativeDroppedTokens 166 000`. API error: status 500,
retry 1 of 10. `continued-in` points at session A1.

---

## Session W1 — `b1111111-1111-4111-8111-111111111111` (worktree project)

Title from the first prompt. `cwd /Users/dev/projects/alpha/.claude/worktrees/feature-x`,
`gitBranch feature-x`, so the project must nest under `/Users/dev/projects/alpha`.
2 lines, 1 request: sonnet-5, 4 in / 5 000 write 5m / 60 out → **$0.013108**.

## Session S1 — `c1111111-1111-4111-8111-111111111111` (scratch project)

`cwd /private/var/folders/zz/T`, so it must be classified as a scratch project.
2 lines, 1 request: haiku-4.5, 12 in / 2 out → **$0.000022**.

---

## Fixture totals (`projects/`)

| sessions | transcripts | lines | messages | assistant lines | requests | synthetic | tool calls | hook runs | injections | injected chars | compactions | API errors | parse errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 5 | 10 | 64 | 55 | 23 | 20 | 1 | 7 | 5 | 20 | 833 | 1 | 1 | 0 |

Per model, over billed units (a fallback request contributes one unit per iteration):

| model | units | input | output | thinking | write 5m | write 1h | read | cost |
|---|---|---|---|---|---|---|---|---|
| `claude-opus-5` | 7 | 40 | 1 300 | 150 | 32 700 | 0 | 72 400 | $0.273275 |
| `claude-sonnet-5` | 6 | 21 | 900 | 0 | 22 700 | 0 | 27 000 | $0.071192 |
| `claude-haiku-4-5-20251001` | 5 | 6 755 | 200 | 0 | 4 500 | 0 | 0 | $0.013380 |
| `claude-opus-4-8` | 1 | 2 | 500 | 0 | 1 000 | 0 | 20 000 | $0.028760 |
| `claude-fable-5-1` | 1 | 2 | 100 | 0 | 0 | 0 | 30 000 | $0.012520 |
| `<synthetic>` | 1 | 0 | 0 | 0 | 0 | 0 | 0 | $0 |
| **total** | **21** | **6 820** | **3 000** | **150** | **60 900** | **0** | **149 400** | **$0.399127** |

Dedup check: 23 assistant lines collapse to 20 requests (A1 `msg_a1r1` 2→1, A1 `msg_a1r3` 3→1).
`tests/core/parse/fixture-totals.test.ts` asserts this table, so if you change the tree the test
tells you exactly which number moved.

---

## `legacy-projects/` layout

```
-Users-dev-projects-legacy/
  d1111111-…111.jsonl                        main file; contains ONE malformed line and an
                                             embedded sidechain group (isSidechain + agentId
                                             e1000000000000001) plus an unknown attachment type
  agent-e2000000000000002.jsonl + .meta.json legacy project-level agent, sessionId in its lines
  agent-e3000000000000003.jsonl              orphan: no derivable sessionId → discovery warning
```

Expected: 1 session, `agentFiles = [e2000000000000002]`, exactly 1 discovery warning
(`legacy agent file has no derivable sessionId`), `main.meta.parseErrors === 1`,
`main.requests === [msg_d1r1]`, `main.embeddedAgents = { e1000000000000001 }` whose single request
sits at `seq 4` of the *main* file, and `deferred_tools_record` producing one injection with
`charsSource: 'json'`.

## Codex fixture

`codex/sessions/2026/09/07/rollout-2026-09-07-codex-demo.jsonl` is invented Codex data,
sharing `/Users/dev/projects/alpha` with Claude A1. It reports one usage increment: 1,000 input
including 400 cached, 100 output including 20 reasoning. The repeated usage event adds no spend.
At GPT-5.3-Codex standard API prices ($1.75 input, $0.175 cached, $14 output per million),
expected cost is `(600*1.75 + 400*0.175 + 100*14)/1e6 = $0.00252`.
This root is opt-in via `CCA_E2E_CODEX_DIR`, keeping the shared Claude fixture totals unchanged.
