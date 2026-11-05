/**
 * RFC 4180 CSV for the sessions export. Fields containing a comma, quote, CR or LF are wrapped in
 * double quotes with inner quotes doubled; rows end with CRLF.
 *
 * Session titles and project paths are transcript-controlled text, and a spreadsheet evaluates a
 * cell that opens with `=`, `+`, `-`, `@`, a tab or a CR as a formula (`=1+1`, `@SUM(…)`, `=cmd|…`).
 * Every text cell therefore goes through {@link neutralizeFormula} before it is quoted: a leading
 * apostrophe, which spreadsheets strip on display and CSV parsers treat as ordinary text.
 */
import type { SessionSummary } from '../types.js';

const HEADER = [
  'sessionId',
  'title',
  'project',
  'startedAt',
  'endedAt',
  'durationMs',
  'entrypoint',
  'models',
  'prompts',
  'requests',
  'toolCalls',
  'agents',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'contextTokens',
  'costInputUsd',
  'costOutputUsd',
  'costCacheWriteUsd',
  'costCacheReadUsd',
  'costWebSearchUsd',
  'costTotalUsd',
  'costMainUsd',
  'costAgentsUsd',
  'costWorkflowsUsd',
  'reportedCostUsd',
  'provider',
  'costStatus',
  'usageIncomplete',
  'unpriced',
];

/** Cell openers a spreadsheet reads as the start of a formula rather than as text. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Neutralizes spreadsheet formula injection by prefixing a single quote. Applied to every
 * user-controlled text cell (titles, project paths, model ids), never to numbers.
 */
export function neutralizeFormula(text: string): string {
  return FORMULA_LEAD.test(text) ? `'${text}` : text;
}

export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** `csvField` for transcript-controlled text: formula-neutralized, then RFC 4180 quoted. */
export function csvText(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return csvField(neutralizeFormula(String(value)));
}

function money(value: number): string {
  return value.toFixed(6);
}

export function sessionsToCsv(sessions: readonly SessionSummary[]): string {
  const lines = [HEADER.join(',')];
  for (const s of sessions) {
    const unavailable = s.usageIncomplete === true && s.requestCount === 0;
    const whollyUnpriced = s.unpriced && s.cost.total === 0;
    const costStatus = unavailable ? 'unavailable' : whollyUnpriced ? 'unpriced'
      : s.usageIncomplete || s.unpriced ? 'partial' : 'recorded';
    // Preserve known partial subtotals, but never turn an absent price or usage into free usage.
    const calculatedMoney = (value: number): string => unavailable || whollyUnpriced ? '' : money(value);
    lines.push(
      [
        csvText(s.id),
        csvText(s.title),
        csvText(s.projectPath),
        csvText(s.startedAt),
        csvText(s.endedAt),
        csvField(s.durationMs),
        csvText(s.entrypoint ?? ''),
        csvText(s.models.join(' ')),
        csvField(s.promptCount),
        csvField(s.requestCount),
        csvField(s.toolCallCount),
        csvField(s.agentCount),
        csvField(s.tokens.input),
        csvField(s.tokens.output),
        csvField(s.tokens.cacheRead),
        csvField(s.tokens.cache5m + s.tokens.cache1h),
        csvField(s.tokens.context),
        csvField(calculatedMoney(s.cost.input)),
        csvField(calculatedMoney(s.cost.output)),
        csvField(calculatedMoney(s.cost.cacheWrite)),
        csvField(calculatedMoney(s.cost.cacheRead)),
        csvField(calculatedMoney(s.cost.webSearch)),
        csvField(calculatedMoney(s.cost.total)),
        csvField(calculatedMoney(s.costMain)),
        csvField(calculatedMoney(s.costAgents)),
        csvField(calculatedMoney(s.costWorkflows)),
        csvField(s.reportedCostUsd === null ? '' : money(s.reportedCostUsd)),
        csvText(s.provider ?? 'claude'),
        csvText(costStatus),
        csvField(String(s.usageIncomplete === true)),
        csvField(String(s.unpriced)),
      ].join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
