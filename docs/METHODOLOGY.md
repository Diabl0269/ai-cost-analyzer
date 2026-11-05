# How AI Cost Analyzer computes costs

Every number in the app is one of two kinds, and the UI always says which:

- **Exact** — derived directly from the token counts Claude Code writes into each transcript line and the
  public list prices. Request cost, session cost, per-model cost, cache read/write split.
- **Estimated (marked "est.")** — an allocation of exact costs to the things that filled the context window:
  a tool result, a hook's injected text, a system reminder, your prompt. Anthropic bills per request, not
  per tool call, so any per-tool number is an attribution model. Ours is documented below so you can
  judge it.

## 1. Where the data comes from

Claude Code stores each conversation as a JSONL file under `~/.claude/projects/<project>/<session>.jsonl`.
Subagents (the `Agent` tool) and workflow agents (the `Workflow` tool) get their own files under
`<session>/subagents/`. Every assistant line carries the API response's `usage` block:

```
input_tokens, output_tokens, cache_read_input_tokens,
cache_creation.ephemeral_5m_input_tokens, cache_creation.ephemeral_1h_input_tokens,
output_tokens_details.thinking_tokens, server_tool_use.web_search_requests, speed, inference_geo, service_tier
```

Two traps we handle:

1. **One response, many lines.** Claude Code writes one line per content block (thinking, text, each
   tool call), all sharing `message.id`. The first line often carries a placeholder `output_tokens` of
   5; a later line has the final count. We group by `message.id` and bill the line with the largest
   `output_tokens`. Counting every line would inflate spend by roughly 2.3× on this machine.
2. **Fallback iterations.** When a model falls back mid-request (for example Fable 5 → Opus 4.8), the
   `usage.iterations` array has two entries and the top-level usage reflects only the last. We bill each
   iteration at its own model. A consequence: spend-by-model's request count is *billed iterations
   attributed to that model*, not top-level requests, so a fallback request adds one to the count of
   every model it touched — the counts by model can therefore sum to slightly more than the range's
   total request count.

Client-side synthetic messages (`model: "<synthetic>"`, e.g. "Request interrupted") carry zero tokens and
are excluded from request counts.

## 2. Request cost (exact)

For one billed request with per-token prices `P` for its model:

```
cost = input·P.input + output·P.output
     + cache5m·P.cacheWrite5m + cache1h·P.cacheWrite1h + cacheRead·P.cacheRead
     + webSearchRequests · $10 / 1000
```

Prices default to Anthropic's published list (platform.claude.com, September 2026) and are editable in
Settings. Modifiers: fast mode (`speed: "fast"`) uses the model's fast-mode prices where defined;
US-only inference (`inference_geo: "us"`) multiplies token prices by 1.1 on Claude 4.6 and later; batch
tier halves them. Long-context requests (>200K) are billed at standard rates on 4.6 and later, so no
surcharge is applied. Output tokens already include thinking tokens.

Cache writes are billed by how long they are kept: a 5-minute write costs 1.25× the input price, a
1-hour write 2×. Current Claude Code records the split on every line. Older versions reported only a
total, and for those the **"assume unknown cache TTL"** setting decides which bucket the write lands
in. Those tokens are stored separately from the reported split, so flipping the setting re-prices
immediately — like every other pricing edit, it never needs a re-index.

A model the pricing table cannot match is shown as **unpriced**: its tokens are counted, its cost is zero,
and it is listed in Settings so you can add a price.

### Cross-check

Claude Code keeps its own running tally in `cost-state` lines (`totalCostUSD` and per-model `costUSD`).
Where present, the session page shows it next to our computed total. `npm run validate` compares the two
across every session that has one. Haiku 4.5 anchors match to the cent; multi-model sessions agree within a
few percent, the residual coming from cache-TTL mix assumptions Claude Code makes internally.

The two numbers are not measuring quite the same thing, so the session page labels each session with
how they line up rather than with a pass/fail delta. `match` means every billed token class — input,
output, cache reads, cache writes — agrees within 5%; on those sessions the money agrees too, and where
the token counts are identical it agrees exactly. `tally-includes-earlier-process` means Claude Code
reported more than the file contains: its tally is an in-memory counter belonging to one process, and a
`/fork`, a continuation or a resumed-then-continued session starts that counter with a parent's total
already in it. `file-covers-more-than-tally` is the mirror image: the counter reset when the session was
resumed while the transcript kept the whole history, so our number is the complete one.
`hidden-calls-only` marks sessions where the file bills nothing at all but the tally holds a few
thousand cold input tokens — background calls such as title generation, which Anthropic bills and Claude
Code never writes to disk. `mixed` is what is left: classes that disagree in both directions at once.
Run `npm run validate` for the current breakdown; `docs/dev/validation.md` records the last one.

## 3. Attribution (estimated)

A request's input side is the whole context window: system prompt, every earlier message, every tool
result, every hook injection. The question "what did this tool call cost me?" therefore has three parts:

1. **Generation.** The request that emitted the tool call paid output tokens for the call's JSON. Thinking
   tokens (reported exactly) go to the thinking block; the remaining output tokens are split across the
   text and tool-call blocks in proportion to their character counts.
2. **Ingest.** The tool's result enters the context in the *next* request. We estimate its token count
   (below) and price it at that request's blended new-token price — the average of what that request paid
   per fresh token across plain input and 5-minute / 1-hour cache writes.
3. **Carry.** From then on the result is re-sent with every later request until the conversation is
   compacted or ends. Mostly this is a cache read at a tenth of the input price, but not always: after an
   idle gap the cache expires and the whole context is re-written. We therefore price each later request
   at its own *average context price* (what it actually paid per context token) and sum those over the
   carry range.

**Tool call (est.) = generation + ingest + carry**, plus, for `Agent` and `Workflow` calls, the exact
cost of the child transcripts, shown separately so nothing is counted twice.

### Estimating tokens from text

Claude Code does not record the token count of an individual tool result. Between two consecutive requests
we know exactly how many tokens were added to the context:

```
Δ = context(R_next) − context(R_prev) − output(R_prev)
```

where `context = input + cacheRead + cache5m + cache1h`. We compute a character-based guess for every item
added in that gap (tool results, your prompt, hook text, system reminders; images count as 1,600 tokens),
using 3.1 characters per token for Claude 4.7-and-later tokenizers and 4.0 for earlier models. If Δ is
positive and within 0.4–2.5× of the guess, we scale the guesses so they sum to Δ exactly (method
**delta**). Otherwise, or across a compaction, we keep the raw guess (method **heuristic**). Each
estimate carries its method so you can see how firm it is.

### Re-sent history and baseline context

Tool results and injections are only part of what a request pays for. Two more things fill the
context window on every request, and both are now attributed:

**The assistant's own replies.** Everything Claude writes — its text, its thinking, the JSON of each
tool call — comes back as conversation history on the next request and is re-sent from then on.
The output tokens themselves are billed exactly at the moment they are generated (that is the
`assistantOutput` category), but their *ingest and carry* cost is a separate, and much larger, bill.
We take it straight from the reported `output_tokens` of each request, so no character estimate is
involved: it enters the context at the next request and is carried like any other item. Thinking
tokens are split off and carried only to the end of the turn that produced them, because the API
needs them back with each tool result inside a turn but they are dropped once the next turn starts.
A reply that a compaction swallows before the next request is skipped — the summary stands in for it.

**The baseline.** The first request of a conversation already pays for a full context: the system
prompt, every tool definition, `CLAUDE.md` and memory files, skill listings, MCP instructions. None
of that appears as an item anywhere in the transcript. We measure it instead: it is the context of
the first request minus the estimated tokens of everything that request was already carrying, and
it is carried over the whole session because a compaction never drops it. "First request" means the
first one that plausibly carried the conversation — a resumed or forked session often opens with a
tiny background call whose context is smaller than the summary it is supposed to contain, and
anchoring there would measure nothing. After a compaction we add a floor item for whatever the
compaction left behind on top of the baseline and the summary, carried to the next boundary.

With those two in place the estimated split adds up to the exact context cost — input, cache writes
and cache reads — up to estimation noise. What is left over is shown as **not attributed** rather
than folded into a category, so you can see how much of the split is measured and how much is
guessed. Over the whole history on this machine it is under 2 %; per session it is
usually under 10 % and can be much larger when the context holds things the transcript never
recorded — a tool result written out to a file, an attachment with no rendered text, or the parent
conversation of a forked session. In those gaps the Δ scaling below is rejected and the missing
tokens belong to nobody, which is exactly what "not attributed" is there to show.

### Why the split can also overshoot

The residual has a second, smaller cause, and it runs the other way. A request that both writes
fresh content into the cache and reads the rest back pays two very different prices per token, but
the carry step prices *every* carried token at that request's average context price. The average
sits above the cache-read price whenever the request also wrote, so the carried history is priced a
little high and the split lands above the exact cost. The UI labels that case **estimation
overshoot** instead of "not attributed". It is a property of the attribution model, not an
arithmetic error: on a session whose token estimates reconcile exactly with the reported context,
the money can still be around 30 % over. Whole-history it nets out to about −2 %, because the
under-attributed sessions are larger.

## 4. Hooks and harness overhead

Hooks do not call the model. They cost you in two ways: wall time (recorded per run) and, when they inject
text — `additionalContext`, blocking errors, or stdout from `SessionStart`/`UserPromptSubmit` hooks — the
ingest and carry cost of that text, estimated as above.

"Harness overhead" is everything Claude Code itself injects: token-budget reminders, skill and tool
listings, MCP instructions, sandbox notes, task reminders. Each is recorded as an attachment; we count the
characters that actually rendered into context and attribute them the same way. This is usually a small
share of a session, but it is the share you have the least control over, so we show it.

## 5. Compaction

When a conversation is compacted, the summary replaces the history and the cache is cold: the next request
re-writes the whole context as cache creation. The session timeline marks each compaction with the tokens
dropped, the time it took, and the re-warm cost taken exactly from the following request.

## 6. Subscription comparison and forecast

The Overview compares, per calendar month, what the same usage would cost at API list prices against the
subscription price you configure (Pro $20, Max 5x $100, Max 20x $200, Team Premium $125/seat, or custom).
The month-end forecast is linear: spend so far ÷ days elapsed × days in month.

## 7. What is not modeled

- Anthropic's tool-use system-prompt overhead (a few hundred tokens per request) is inside `input_tokens`
  already and is not separated out. It is part of the measured baseline, not a category of its own.
- The baseline is measured as a single block, so it cannot say how much of it is the system prompt,
  how much is tool definitions and how much is your memory files.
- Web search is billed per search from `server_tool_use`; web fetch has no surcharge.
- Volume discounts, credits, and enterprise contracts. Enter your effective prices in Settings if yours
  differ from list.
- Conversations whose transcripts were deleted or trimmed by Claude Code cleanup are gone from the data.

## Codex rollout accounting

Codex is normalized to the same token, request, tool, transcript, search, and export contracts.
A Codex input total includes cached tokens: uncached input is `input_tokens - cached_input_tokens`
(clamped at zero). Reasoning tokens are a subset of output and are never billed a second time.
Repeated cumulative token-count notifications do not create another billed request. Prices are
read-time API list-price estimates, not the amount charged by a ChatGPT subscription. Missing
usage and unknown models must not be filled with guessed costs. OpenAI default price entries cite
[official OpenAI pricing](https://developers.openai.com/api/docs/pricing); user overrides still win.

Provider filtering applies before aggregation. A project represents an exact reported working
folder across Claude Code and Codex; provider-specific session IDs prevent cross-tool collisions.
Claude hook/workflow and reported-tally features rely on Claude metadata and do not imply that
Codex records those same facts.

Published GPT-6 long-context premiums apply per request above 272,000 input tokens (cached
input included): input/cache rates double and output rates multiply by 1.5. Aggregation preserves
each request's context size before pricing, so many short requests never trigger a long-context
premium. Unsupported tariffs/models remain unpriced; hidden service charges and inherited fork
history are not inferred from rollout content. For those cases the recorded-token view is not a
complete billing ledger.

A rollout may preserve assistant/tool text without recording token usage. Such a session is
readable and searchable but does not establish a zero-dollar bill: its cost is unavailable.
Historical activity can also lie outside the default 30-day view; select All to inspect it.
