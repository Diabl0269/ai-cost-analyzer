/**
 * Insights engine (SPEC §10.3). Pure: the store gathers aggregates with SQL, this file turns them
 * into ranked findings with a money impact and up to five example sessions each.
 */
import type { QueryContext } from '../store.js';
import type { Insight, ModelFamily, TokenUsage } from '../types.js';
import { costOfUsage } from '../pricing/money.js';
import { STANDARD_FLAGS, resolvePrice } from '../pricing/resolve.js';
import { formatDuration, formatMoney, formatPercent, formatTokens, plural, pluralNoun } from '../pricing/format.js';
import { displayNameOf } from '../db/projects.js';

const MAX_SESSIONS_PER_INSIGHT = 5;
const LONG_CONTEXT_TOKENS = 150_000;
const INPUT_HEAVY_RATIO = 50;
const INPUT_HEAVY_MIN_INPUT_TOKENS = 100_000;

/** What `core/db/analytics.ts` calls a hook run with no `hookName` in the transcript. */
const UNNAMED_HOOK = '(unnamed)';

/**
 * Present-tense verb agreement for a counted subject: `1 compaction costs`, `4 compactions cost`.
 * Only used for the regular verbs in these titles — a count of one used to read "1 compactions
 * cost", and fixing the noun alone would have left "1 compaction cost".
 */
function agrees(n: number, verb: string): string {
  return n === 1 ? `${verb}s` : verb;
}

/**
 * A hook the way a sentence should name it. `(unnamed)` is a placeholder from the query, not a
 * name — a title reading "(unnamed) spent 16m 22s blocking turns" says nothing a reader can act
 * on, where "An unnamed Stop hook" at least says which event to go and look at.
 */
function hookPhrase(hookName: string, hookEvent: string | undefined, capitalised: boolean): string {
  if (hookName !== UNNAMED_HOOK) return hookName;
  const article = capitalised ? 'An' : 'an';
  return hookEvent ? `${article} unnamed ${hookEvent} hook` : `${article} unnamed hook`;
}

export interface InsightSessionRef {
  sessionId: string;
  title: string;
  amount: number;
}

export interface InsightSessionRow {
  sessionId: string;
  title: string;
  projectId: string;
  projectPath: string;
  cost: number;
  promptCount: number;
  requestCount: number;
  /** Σ contextTokens over the session's requests, for the average-context insight */
  contextTokensTotal: number;
  compactionCount: number;
  rewarmCost: number;
  coldCacheRequests: number;
  coldCacheCost: number;
  /** cold-cache requests that follow an idle gap longer than the cache TTL */
  idleGapExpiries: number;
  idleGapCost: number;
  /** source tool; absent means unknown and gets generic advice */
  provider?: 'claude' | 'codex' | 'copilot' | 'opencode';
}

/** One (session, model) bucket, split by whether the spend happened in a subagent. */
export interface InsightModelRow {
  sessionId: string;
  title: string;
  model: string;
  family: ModelFamily;
  isAgent: boolean;
  requests: number;
  cost: number;
  usage: TokenUsage;
  /** the model has no price: `cost` excludes it */
  unpriced?: boolean;
  /** labeled `estimateAs` USD for an unpriced model; never part of `cost` */
  estimatedCost?: number;
}

export interface InsightToolRow {
  name: string;
  calls: number;
  genCost: number;
  ingestCost: number;
  carryCost: number;
  topSessions: InsightSessionRef[];
}

export interface InsightHookRow {
  hookName: string;
  /** the lifecycle event the hook is registered on, e.g. `Stop`, `PostToolUse:Edit` */
  hookEvent?: string;
  runs: number;
  failures: number;
  totalDurationMs: number;
  estCost: number;
}

export interface InsightsInput {
  totalCost: number;
  sessions: InsightSessionRow[];
  sessionModels: InsightModelRow[];
  tools: InsightToolRow[];
  hooks: InsightHookRow[];
  /** estimated ingest+carry cost of non-hook attachments */
  harnessCost: number;
  /** estimated ingest+carry cost of hook-injected context */
  hookCost: number;
}

function topSessions(refs: InsightSessionRef[]): InsightSessionRef[] {
  return [...refs].sort((a, b) => b.amount - a.amount).slice(0, MAX_SESSIONS_PER_INSIGHT);
}

function share(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/**
 * Re-prices a bucket of usage at a substitute model, at standard speed/geo/tier.
 * Modifier-heavy requests (fast, us-geo, batch) are re-priced as standard, which is the honest
 * reading of "what if I had used model X instead".
 */
function costAtModel(usage: TokenUsage, targetKey: string, ctx: QueryContext): number | null {
  const target = ctx.pricing.models.find((m) => m.key === targetKey);
  if (!target) return null;
  const match = target.match[0];
  if (!match) return null;
  const resolved = resolvePrice(match, STANDARD_FLAGS, ctx.pricing);
  if (resolved.unpriced) return null;
  return costOfUsage(usage, resolved, ctx.pricing.webSearchPer1000).total;
}

function familySwapInsight(
  input: InsightsInput,
  ctx: QueryContext,
  args: { id: string; fromFamilies: ModelFamily[]; toKey: string; toLabel: string },
): Insight | null {
  const rows = input.sessionModels.filter((r) => args.fromFamilies.includes(r.family));
  if (rows.length === 0) return null;
  let current = 0;
  let swapped = 0;
  const bySession = new Map<string, InsightSessionRef>();
  for (const row of rows) {
    const alternative = costAtModel(row.usage, args.toKey, ctx);
    if (alternative === null) return null;
    current += row.cost;
    swapped += alternative;
    const saving = row.cost - alternative;
    const existing = bySession.get(row.sessionId);
    if (existing) existing.amount += saving;
    else bySession.set(row.sessionId, { sessionId: row.sessionId, title: row.title, amount: saving });
  }
  const saving = current - swapped;
  if (Math.abs(saving) < 0.005) return null;
  const families = args.fromFamilies.join('/');
  return {
    id: args.id,
    title:
      saving > 0
        ? `Running ${families} work on ${args.toLabel} would have cost ${formatMoney(swapped)}`
        : `${args.toLabel} would have been more expensive for ${families} work`,
    explanation:
      `${formatMoney(current)} of ${families} spend re-priced at ${args.toLabel} list prices comes to ` +
      `${formatMoney(swapped)} for the same tokens. Token counts would differ in practice; this is a price swap only.`,
    impactUsd: Math.abs(saving),
    kind: saving > 0 ? 'saving' : 'info',
    sessions: topSessions([...bySession.values()]),
    metric: { label: `share of range spend`, value: formatPercent(share(current, input.totalCost)) },
  };
}

export function computeInsights(input: InsightsInput, ctx: QueryContext): Insight[] {
  const out: Insight[] = [];
  const total = input.totalCost;

  // 1. Tool results that keep being re-sent.
  const byCarry = [...input.tools].sort((a, b) => b.carryCost - a.carryCost);
  const worstTool = byCarry[0];
  if (worstTool && worstTool.carryCost > 0) {
    const carryTotal = byCarry.reduce((sum, t) => sum + t.carryCost, 0);
    out.push({
      id: 'tool-carry-cost',
      title: `${worstTool.name} results cost ${formatMoney(worstTool.carryCost)} just to stay in context`,
      explanation:
        `Tool results are re-sent with every later request until a compaction. ${worstTool.name} accounts for ` +
        `${formatMoney(worstTool.carryCost)} of the ${formatMoney(carryTotal)} spent carrying tool output across ` +
        `${plural(worstTool.calls, 'call')}. Trimming or persisting large outputs cuts this directly.`,
      impactUsd: worstTool.carryCost,
      kind: 'waste',
      sessions: topSessions(worstTool.topSessions),
      metric: { label: 'carry share of tool cost', value: formatPercent(share(worstTool.carryCost, carryTotal)) },
    });
  }

  // 2. Compaction rewarm.
  const compacted = input.sessions.filter((s) => s.compactionCount > 0);
  if (compacted.length > 0) {
    const rewarm = compacted.reduce((sum, s) => sum + s.rewarmCost, 0);
    const compactions = compacted.reduce((sum, s) => sum + s.compactionCount, 0);
    out.push({
      id: 'compaction-rewarm',
      title: `${plural(compactions, 'compaction')} ${agrees(compactions, 'cost')} ${formatMoney(rewarm)} to re-warm the cache`,
      explanation:
        `After a compaction the whole context is written again at cache-write prices. ` +
        `${plural(compacted.length, 'session')} compacted in this range; the first request after each boundary cost ` +
        `${formatMoney(rewarm)} in cache writes. Shorter sessions or earlier /clear avoid most of it.`,
      impactUsd: rewarm,
      kind: 'waste',
      sessions: topSessions(
        compacted.map((s) => ({ sessionId: s.sessionId, title: s.title, amount: s.rewarmCost })),
      ),
      metric: { label: `${pluralNoun(compacted.length, 'session')} affected`, value: String(compacted.length) },
    });
  }

  // 3. Cold-cache requests.
  const coldCost = input.sessions.reduce((sum, s) => sum + s.coldCacheCost, 0);
  const coldRequests = input.sessions.reduce((sum, s) => sum + s.coldCacheRequests, 0);
  if (coldRequests > 0) {
    out.push({
      id: 'cold-cache',
      title: `${plural(coldRequests, 'cold-cache request')} ${agrees(coldRequests, 'cost')} ${formatMoney(coldCost)}`,
      explanation:
        `A request with more than 20K context and no cache read paid full write price for the entire prompt. ` +
        `These are the first request of a session, a resume after the cache expired, or a prompt-prefix change.`,
      impactUsd: coldCost,
      kind: 'waste',
      sessions: topSessions(
        input.sessions
          .filter((s) => s.coldCacheRequests > 0)
          .map((s) => ({ sessionId: s.sessionId, title: s.title, amount: s.coldCacheCost })),
      ),
      metric: { label: 'share of range spend', value: formatPercent(share(coldCost, total)) },
    });
  }

  // 4. Harness overhead.
  if (input.harnessCost > 0) {
    out.push({
      id: 'harness-overhead',
      title: `Harness injections account for an estimated ${formatMoney(input.harnessCost)}`,
      explanation:
        `System reminders, tool listings, skill listings and other harness attachments are text you never wrote ` +
        `but still paid to send and re-send. This is ${formatPercent(share(input.harnessCost, total))} of range spend.`,
      impactUsd: input.harnessCost,
      kind: 'info',
      sessions: [],
      metric: { label: 'share of range spend', value: formatPercent(share(input.harnessCost, total)) },
    });
  }

  // 5. Hook overhead + slowest hooks.
  if (input.hookCost > 0) {
    out.push({
      id: 'hook-overhead',
      title: `Hook output added an estimated ${formatMoney(input.hookCost)} of context`,
      explanation:
        `Hooks that write to stdout on UserPromptSubmit/SessionStart, add context, or block with a message put ` +
        `text into the model's context. That text is billed on ingest and on every later request until compaction.`,
      impactUsd: input.hookCost,
      kind: 'waste',
      sessions: [],
      metric: { label: 'share of range spend', value: formatPercent(share(input.hookCost, total)) },
    });
  }
  const slowest = [...input.hooks].sort((a, b) => b.totalDurationMs - a.totalDurationMs)[0];
  if (slowest && slowest.totalDurationMs > 0) {
    out.push({
      id: 'slow-hooks',
      title: `${hookPhrase(slowest.hookName, slowest.hookEvent, true)} spent ${formatDuration(
        slowest.totalDurationMs,
      )} blocking turns`,
      explanation:
        `Hooks cost wall time as well as tokens. ${hookPhrase(slowest.hookName, slowest.hookEvent, false)} ran ` +
        `${plural(slowest.runs, 'time')} (${formatDuration(slowest.totalDurationMs / Math.max(1, slowest.runs))} average` +
        `${slowest.failures > 0 ? `, ${plural(slowest.failures, 'failure')}` : ''}).`,
      impactUsd: slowest.estCost,
      kind: 'info',
      sessions: [],
      metric: { label: 'total hook time', value: formatDuration(slowest.totalDurationMs) },
    });
  }

  // 6. Model-mix what-ifs.
  const fableSwap = familySwapInsight(input, ctx, {
    id: 'model-mix-fable-to-opus',
    fromFamilies: ['fable', 'mythos'],
    toKey: 'opus-5',
    toLabel: 'Opus 5',
  });
  if (fableSwap) out.push(fableSwap);
  const opusSwap = familySwapInsight(input, ctx, {
    id: 'model-mix-opus-to-sonnet',
    fromFamilies: ['opus'],
    toKey: 'sonnet-5',
    toLabel: 'Sonnet 5',
  });
  if (opusSwap) out.push(opusSwap);

  // 7. Long-context sessions.
  const longSessions = input.sessions.filter(
    (s) => s.requestCount > 0 && s.contextTokensTotal / s.requestCount > LONG_CONTEXT_TOKENS,
  );
  if (longSessions.length > 0) {
    const cost = longSessions.reduce((sum, s) => sum + s.cost, 0);
    const avg =
      longSessions.reduce((sum, s) => sum + s.contextTokensTotal, 0) /
      Math.max(1, longSessions.reduce((sum, s) => sum + s.requestCount, 0));
    // Rough: if each session's average context had stayed at the threshold, cost scales with it.
    const estSaving = longSessions.reduce((sum, s) => {
      const sessionAvg = s.contextTokensTotal / s.requestCount;
      return sum + s.cost * (1 - LONG_CONTEXT_TOKENS / sessionAvg);
    }, 0);
    const providers = new Set(longSessions.map((s) => s.provider ?? 'unknown'));
    const only = providers.size === 1 ? [...providers][0] : undefined;
    const advice =
      only === 'claude'
        ? 'Run /compact (or /clear between tasks) before the context grows this large.'
        : only === 'codex'
          ? 'Start a new Codex thread for the next task instead of continuing this one.'
          : providers.has('claude') || providers.has('codex')
            ? 'Run /compact in Claude Code sessions and start a new thread in Codex.'
            : 'Splitting the work into fresh sessions keeps the per-request context, and the bill, flat.';
    const carry = byCarry[0];
    const carryNote =
      carry && carry.carryCost > 0
        ? ` The largest carried tool output in range is ${carry.name} (${formatMoney(carry.carryCost)}).`
        : '';
    out.push({
      id: 'long-context-sessions',
      title: `${plural(longSessions.length, 'session')} ran above ${formatTokens(LONG_CONTEXT_TOKENS)} average context`,
      explanation:
        `Every request in a long session re-sends the whole conversation. These sessions cost ` +
        `${formatMoney(cost)} at an average context of ${formatTokens(avg)}. ${advice}` +
        (estSaving > 0.005
          ? ` Holding context near ${formatTokens(LONG_CONTEXT_TOKENS)} would save roughly ${formatMoney(estSaving)} (estimate).`
          : '') +
        carryNote,
      impactUsd: cost,
      kind: 'waste',
      sessions: topSessions(
        longSessions.map((s) => ({ sessionId: s.sessionId, title: s.title, amount: s.cost })),
      ),
      metric: { label: 'average context', value: formatTokens(avg) },
    });
  }

  // 7b. Unpriced models that are almost all input.
  const unpricedByModel = new Map<
    string,
    { input: number; output: number; estimate: number; hasEstimate: boolean; sessions: Map<string, InsightSessionRef> }
  >();
  for (const row of input.sessionModels) {
    if (!row.unpriced) continue;
    const entry = unpricedByModel.get(row.model) ?? {
      input: 0,
      output: 0,
      estimate: 0,
      hasEstimate: false,
      sessions: new Map<string, InsightSessionRef>(),
    };
    const inputTokens = row.usage.input + row.usage.cacheRead + row.usage.cache5m + row.usage.cache1h;
    entry.input += inputTokens;
    entry.output += row.usage.output;
    if (row.estimatedCost !== undefined) {
      entry.hasEstimate = true;
      entry.estimate += row.estimatedCost;
    }
    const ref = entry.sessions.get(row.sessionId) ?? { sessionId: row.sessionId, title: row.title, amount: 0 };
    ref.amount += row.estimatedCost ?? 0;
    entry.sessions.set(row.sessionId, ref);
    unpricedByModel.set(row.model, entry);
  }
  const heavy = [...unpricedByModel.entries()]
    .filter(([, e]) => e.input >= INPUT_HEAVY_MIN_INPUT_TOKENS && (e.output === 0 || e.input / e.output > INPUT_HEAVY_RATIO))
    .sort((a, b) => b[1].input - a[1].input)[0];
  if (heavy) {
    const [model, entry] = heavy;
    const ratio = entry.output > 0 ? `${Math.round(entry.input / entry.output)}:1` : 'no output';
    out.push({
      id: 'input-heavy-unpriced',
      title: `${model} read ${formatTokens(entry.input)} input tokens for ${formatTokens(entry.output)} output (${ratio})`,
      explanation:
        `This model has no published price, so its spend is not in the totals. Input-to-output this lopsided ` +
        `usually means a reviewer or classifier re-reading context, which is cheap per token but adds up.` +
        (entry.hasEstimate
          ? ` Billed as its estimate target it would cost about ${formatMoney(entry.estimate)} (estimate).`
          : ` Set an estimate in Settings to see a dollar figure.`),
      impactUsd: entry.hasEstimate ? entry.estimate : 0,
      kind: 'info',
      sessions: topSessions([...entry.sessions.values()]),
      metric: { label: 'input tokens', value: formatTokens(entry.input) },
    });
  }

  // 8. Subagent model mix.
  const agentRows = input.sessionModels.filter((r) => r.isAgent);
  if (agentRows.length > 0) {
    const agentCost = agentRows.reduce((sum, r) => sum + r.cost, 0);
    const byModel = new Map<string, number>();
    for (const row of agentRows) byModel.set(row.model, (byModel.get(row.model) ?? 0) + row.cost);
    const ranked = [...byModel.entries()].sort((a, b) => b[1] - a[1]);
    const leader = ranked[0];
    const bySession = new Map<string, InsightSessionRef>();
    for (const row of agentRows) {
      const existing = bySession.get(row.sessionId);
      if (existing) existing.amount += row.cost;
      else bySession.set(row.sessionId, { sessionId: row.sessionId, title: row.title, amount: row.cost });
    }
    out.push({
      id: 'subagent-model-mix',
      title: `Subagents cost ${formatMoney(agentCost)}, mostly on ${leader ? leader[0] : 'unknown models'}`,
      explanation:
        `Delegated work is ${formatPercent(share(agentCost, total))} of range spend across ${plural(ranked.length, 'model')}. ` +
        `Subagents inherit the parent model unless the caller passes one, so a cheaper explicit model is usually free money.`,
      impactUsd: agentCost,
      kind: 'info',
      sessions: topSessions([...bySession.values()]),
      metric: leader
        ? { label: 'top subagent model', value: `${leader[0]} · ${formatMoney(leader[1])}` }
        : { label: pluralNoun(ranked.length, 'model'), value: String(ranked.length) },
    });
  }

  // 9. Cost per prompt by project.
  const perProject = new Map<string, { path: string; name: string; cost: number; prompts: number }>();
  for (const s of input.sessions) {
    const entry =
      perProject.get(s.projectId) ?? { path: s.projectPath, name: displayNameOf(s.projectPath), cost: 0, prompts: 0 };
    entry.cost += s.cost;
    entry.prompts += s.promptCount;
    perProject.set(s.projectId, entry);
  }
  const rankedProjects = [...perProject.values()]
    .filter((p) => p.prompts >= 5)
    .sort((a, b) => b.cost / b.prompts - a.cost / a.prompts);
  const worstProject = rankedProjects[0];
  if (worstProject) {
    out.push({
      id: 'cost-per-prompt-by-project',
      // The project's name, not its absolute path: "/Users/dev/work/lumen-web costs $1.07 per
      // prompt" spends its first forty characters saying nothing the reader needs.
      title: `${worstProject.name} costs ${formatMoney(worstProject.cost / worstProject.prompts)} per prompt`,
      explanation:
        `Across ${plural(worstProject.prompts, 'prompt')} this project spent ${formatMoney(worstProject.cost)} — the highest ` +
        `cost per prompt of any project in range. Large repos, big reads and long-running sessions all push this up.`,
      impactUsd: worstProject.cost,
      kind: 'info',
      sessions: topSessions(
        input.sessions
          .filter((s) => s.projectPath === worstProject.path)
          .map((s) => ({ sessionId: s.sessionId, title: s.title, amount: s.cost })),
      ),
      metric: { label: 'cost per prompt', value: formatMoney(worstProject.cost / worstProject.prompts) },
    });
  }

  // 10. Idle-gap cache expiries.
  const idleCost = input.sessions.reduce((sum, s) => sum + s.idleGapCost, 0);
  const idleCount = input.sessions.reduce((sum, s) => sum + s.idleGapExpiries, 0);
  if (idleCount > 0) {
    out.push({
      id: 'idle-gap-expiry',
      title: `${plural(idleCount, 'cache expiry', 'cache expiries')} after idle gaps ${agrees(
        idleCount,
        'cost',
      )} ${formatMoney(idleCost)}`,
      explanation:
        `Walking away for longer than the cache TTL means the next request re-writes the whole context. ` +
        `Finishing a train of thought, or using the 1-hour cache TTL, avoids paying for the same prompt twice.`,
      impactUsd: idleCost,
      kind: 'waste',
      sessions: topSessions(
        input.sessions
          .filter((s) => s.idleGapExpiries > 0)
          .map((s) => ({ sessionId: s.sessionId, title: s.title, amount: s.idleGapCost })),
      ),
      metric: { label: pluralNoun(idleCount, 'expiry', 'expiries'), value: String(idleCount) },
    });
  }

  return out.sort((a, b) => {
    const infoA = a.kind === 'info' ? 1 : 0;
    const infoB = b.kind === 'info' ? 1 : 0;
    if (infoA !== infoB) return infoA - infoB;
    return b.impactUsd - a.impactUsd;
  });
}
