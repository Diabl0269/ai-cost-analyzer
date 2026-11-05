import { describe, expect, it } from 'vitest';
import {
  ALL_TIME_FROM,
  MAX_DENSE_DAYS,
  dayCount,
  eachDay,
  fillDailySeries,
  formatRangeSentence,
  matchPreset,
  presetRange,
  rangeLabel,
  sessionBounds,
} from '../../web/src/lib/range.js';

// The 20th of the month, so that `7d` and `month` are different windows: on the 7th they
// coincide and `matchPreset` can only return the first of the two.
const NOW = new Date(2026, 8, 20); // 2026-09-20, local

describe('presetRange', () => {
  it('resolves every window to inclusive local days', () => {
    expect(presetRange('today', NOW)).toEqual({ from: '2026-09-20', to: '2026-09-20' });
    expect(presetRange('7d', NOW)).toEqual({ from: '2026-09-14', to: '2026-09-20' });
    expect(presetRange('30d', NOW)).toEqual({ from: '2026-08-22', to: '2026-09-20' });
    expect(presetRange('month', NOW)).toEqual({ from: '2026-09-01', to: '2026-09-20' });
    expect(presetRange('lastMonth', NOW)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  });

  it('gives `all` explicit bounds, because the server fills a missing one with 30 days', () => {
    expect(presetRange('all', NOW)).toEqual({ from: ALL_TIME_FROM, to: '2026-09-20' });
    expect(presetRange('custom', NOW)).toEqual({});
  });
});

describe('matchPreset', () => {
  it('reads an empty window as the server default, not as all time', () => {
    expect(matchPreset(undefined, undefined, NOW)).toBe('30d');
  });

  it('round-trips every preset', () => {
    for (const id of ['today', '7d', '30d', 'month', 'lastMonth', 'all'] as const) {
      const bounds = presetRange(id, NOW);
      expect(matchPreset(bounds.from, bounds.to, NOW), id).toBe(id);
    }
  });

  it('falls back to custom for a hand-picked window', () => {
    expect(matchPreset('2026-01-01', '2026-02-03', NOW)).toBe('custom');
  });
});

describe('rangeLabel', () => {
  it('names a preset and spells out a custom window', () => {
    expect(rangeLabel({ preset: '30d' })).toBe('30 days');
    expect(rangeLabel({ preset: 'all', from: ALL_TIME_FROM, to: '2026-09-20' })).toBe('All');
    expect(rangeLabel({ preset: 'custom', from: '2026-01-01', to: '2026-02-03' })).toBe('Jan 1 – Feb 3');
  });
});

describe('formatRangeSentence', () => {
  it('is the one prose form of a window', () => {
    expect(formatRangeSentence('2026-08-11', '2026-09-09')).toBe('Aug 11 – Sep 9, 2026');
    expect(formatRangeSentence('2025-12-28', '2026-01-04')).toBe('Dec 28, 2025 – Jan 4, 2026');
  });

  it('names a single day once', () => {
    expect(formatRangeSentence('2026-09-09', '2026-09-09')).toBe('Sep 9, 2026');
  });

  it('says "all time" instead of printing the year 2000', () => {
    expect(formatRangeSentence(ALL_TIME_FROM, '2026-09-09')).toBe('All time through Sep 9, 2026');
  });

  it('names the window the server would default to when a bound is missing', () => {
    expect(formatRangeSentence(undefined, '2026-09-09')).toBe('the last 30 days');
    expect(formatRangeSentence(undefined, undefined)).toBe('the last 30 days');
  });
});

describe('dayCount and eachDay', () => {
  it('counts and enumerates inclusive local days', () => {
    expect(dayCount('2026-09-01', '2026-09-30')).toBe(30);
    expect(dayCount('2026-09-09', '2026-09-09')).toBe(1);
    expect(eachDay('2026-08-30', '2026-09-02')).toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
  });

  it('treats a backwards or unparseable window as empty', () => {
    expect(dayCount('2026-09-09', '2026-09-01')).toBe(0);
    expect(eachDay('nope', '2026-09-01')).toEqual([]);
  });
});

describe('fillDailySeries', () => {
  const empty = (date: string) => ({ date, cost: 0 });

  it('gives every day in the window a row, in date order', () => {
    const rows = [
      { date: '2026-09-03', cost: 4 },
      { date: '2026-09-01', cost: 2 },
    ];
    expect(fillDailySeries(rows, '2026-09-01', '2026-09-04', empty)).toEqual([
      { date: '2026-09-01', cost: 2 },
      { date: '2026-09-02', cost: 0 },
      { date: '2026-09-03', cost: 4 },
      { date: '2026-09-04', cost: 0 },
    ]);
  });

  /** `all` asks for 2000-01-01 → today: ~9,700 cells is not a strip anyone can read. */
  it('falls back to the extent of the data when the window is absurdly wide', () => {
    const rows = [
      { date: '2026-09-01', cost: 2 },
      { date: '2026-09-03', cost: 4 },
    ];
    const filled = fillDailySeries(rows, ALL_TIME_FROM, '2026-09-20', empty);
    expect(filled.map((row) => row.date)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
  });

  it('leaves the rows alone when even the data extent is too wide', () => {
    const rows = [
      { date: '2000-01-01', cost: 1 },
      { date: '2026-09-01', cost: 2 },
    ];
    expect(fillDailySeries(rows, undefined, undefined, empty)).toEqual(rows);
    expect(MAX_DENSE_DAYS).toBeGreaterThan(365);
  });

  it('survives an empty series', () => {
    expect(fillDailySeries([], undefined, undefined, empty)).toEqual([]);
  });
});


describe('session list date defaults', () => {
  it('matches the advertised 30 days while respecting explicit history bounds', () => {
    expect(sessionBounds(undefined, undefined, NOW)).toEqual({ from: '2026-08-22', to: '2026-09-20' });
    expect(sessionBounds('2000-01-01', '2026-09-20', NOW)).toEqual({ from: '2000-01-01', to: '2026-09-20' });
    expect(sessionBounds('2026-09-01', undefined, NOW)).toEqual({ from: '2026-09-01', to: '2026-09-20' });
  });
});
