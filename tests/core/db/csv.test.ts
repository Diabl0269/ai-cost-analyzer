import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../../core/types.js';
import { csvField, csvText, neutralizeFormula, sessionsToCsv } from '../../../core/db/csv.js';
import { emptyBreakdown, emptyTokenTotals } from '../../../core/pricing/money.js';

function summary(partial: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    projectId: '-Users-dev-widget',
    projectPath: '/Users/dev/widget',
    title: 'Rename the helper',
    titleSource: 'ai-title',
    firstPrompt: 'Rename the helper',
    startedAt: '2026-09-07T09:00:00.000Z',
    endedAt: '2026-09-07T09:30:00.000Z',
    durationMs: 1_800_000,
    activeMs: 42_000,
    models: ['claude-opus-5'],
    promptCount: 1,
    requestCount: 3,
    toolCallCount: 2,
    agentCount: 0,
    workflowRunCount: 0,
    compactionCount: 0,
    apiErrorCount: 0,
    hookRunCount: 0,
    tokens: emptyTokenTotals(),
    cost: emptyBreakdown(),
    costMain: 0,
    costAgents: 0,
    costWorkflows: 0,
    reportedCostUsd: null,
    pinned: false,
    unpriced: false,
    ...partial,
  };
}

/** Minimal RFC 4180 reader, so the assertions read the cell a spreadsheet would. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else inQuotes = false;
      } else cur += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') {
      cells.push(cur);
      cur = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      cells.push(cur);
      rows.push(cells);
      cells = [];
      cur = '';
      i += 1;
    } else cur += c;
  }
  if (cur.length > 0 || cells.length > 0) {
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

describe('RFC 4180 quoting', () => {
  it('quotes commas, quotes, CR and LF and leaves everything else bare', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField('two\rlines')).toBe('"two\rlines"');
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
    expect(csvField(42)).toBe('42');
  });
});

describe('spreadsheet formula injection', () => {
  it('prefixes every cell opener a spreadsheet would evaluate', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      expect(neutralizeFormula(`${lead}SUM(A1)`)).toBe(`'${lead}SUM(A1)`);
    }
    expect(neutralizeFormula('=cmd|\' /C calc\'!A0')).toBe("'=cmd|' /C calc'!A0");
  });

  it('leaves ordinary text and text with an inner trigger alone', () => {
    expect(neutralizeFormula('Rename the helper')).toBe('Rename the helper');
    expect(neutralizeFormula('a-b')).toBe('a-b');
    expect(neutralizeFormula('/Users/dev/widget')).toBe('/Users/dev/widget');
    expect(neutralizeFormula('')).toBe('');
  });

  it('neutralizes first, then quotes, so both defences survive together', () => {
    expect(csvText('=1+1,2')).toBe(`"'=1+1,2"`);
    expect(csvText('-"x"')).toBe(`"'-""x"""`);
  });

  it('neutralizes the session title and project path in the export', () => {
    const csv = sessionsToCsv([
      summary({ id: 's1', title: '=1+1', projectPath: '@/tmp/evil' }),
      summary({ id: 's2', title: '-rf, everything', projectPath: '/Users/dev/widget' }),
      summary({ id: 's3', title: '\tleading tab', projectPath: '+plus' }),
      summary({ id: 's4', title: 'Rename the helper', projectPath: '/Users/dev/widget' }),
    ]);
    const rows = parseCsv(csv);
    const header = rows[0] ?? [];
    const title = header.indexOf('title');
    const project = header.indexOf('project');
    expect(rows[1]?.[title]).toBe(`'=1+1`);
    expect(rows[1]?.[project]).toBe(`'@/tmp/evil`);
    expect(rows[2]?.[title]).toBe(`'-rf, everything`);
    expect(rows[3]?.[title]).toBe(`'\tleading tab`);
    expect(rows[3]?.[project]).toBe(`'+plus`);
    // ordinary text is untouched, so the common case still round-trips exactly
    expect(rows[4]?.[title]).toBe('Rename the helper');
    expect(rows[4]?.[project]).toBe('/Users/dev/widget');
  });

  it('never touches a numeric cell', () => {
    const csv = sessionsToCsv([summary({ durationMs: 1_800_000, requestCount: 3 })]);
    const rows = parseCsv(csv);
    const header = rows[0] ?? [];
    expect(rows[1]?.[header.indexOf('durationMs')]).toBe('1800000');
    expect(rows[1]?.[header.indexOf('costTotalUsd')]).toBe('0.000000');
    expect(rows[1]?.[header.indexOf('reportedCostUsd')]).toBe('');
  });

  it('keeps one row per session and CRLF line ends', () => {
    const csv = sessionsToCsv([summary({ id: 'a' }), summary({ id: 'b' })]);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.trimEnd().split('\r\n')).toHaveLength(3);
  });
});


describe('export cost quality', () => {
  it('distinguishes recorded zero, missing usage, unknown prices, and known partial subtotals', () => {
    const partial = { ...emptyBreakdown(), input: 0.25, total: 0.25 };
    const rows = parseCsv(sessionsToCsv([
      summary({ id: 'recorded' }),
      summary({ id: 'missing', provider: 'codex', requestCount: 0, usageIncomplete: true }),
      summary({ id: 'unknown', models: ['gpt-future'], unpriced: true }),
      summary({ id: 'partial-usage', usageIncomplete: true, cost: partial, costMain: 0.25 }),
      summary({ id: 'partial-prices', unpriced: true, cost: partial, costMain: 0.25 }),
    ]));
    const header = rows[0]!;
    const cell = (row: number, field: string) => rows[row]![header.indexOf(field)];
    expect(cell(1, 'costStatus')).toBe('recorded');
    expect(cell(1, 'costTotalUsd')).toBe('0.000000');
    expect(cell(1, 'usageIncomplete')).toBe('false');
    expect(cell(1, 'unpriced')).toBe('false');
    expect(cell(2, 'costStatus')).toBe('unavailable');
    expect(cell(2, 'usageIncomplete')).toBe('true');
    expect(cell(3, 'costStatus')).toBe('unpriced');
    expect(cell(3, 'unpriced')).toBe('true');
    const calculatedFields = header.filter((field) => field.startsWith('cost') && field.endsWith('Usd'));
    for (const field of calculatedFields) {
      expect(cell(2, field)).toBe('');
      expect(cell(3, field)).toBe('');
    }
    expect(cell(4, 'costStatus')).toBe('partial');
    expect(cell(5, 'costStatus')).toBe('partial');
    expect(cell(4, 'costTotalUsd')).toBe('0.250000');
    expect(cell(5, 'costTotalUsd')).toBe('0.250000');
    expect(cell(5, 'costMainUsd')).toBe('0.250000');
  });
});
