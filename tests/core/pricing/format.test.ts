import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  formatDate,
  formatDateTime,
  formatDuration,
  formatModelLabel,
  formatMoney,
  formatMoneyCompact,
  formatMonthKey,
  formatPercent,
  formatTime,
  formatTokens,
  formatTokensFull,
} from '../../../core/pricing/format.js';

describe('formatMoney', () => {
  it('uses two decimals with grouping above a cent', () => {
    expect(formatMoney(1234.56)).toBe('$1,234.56');
    expect(formatMoney(0.01)).toBe('$0.01');
  });

  it('switches to four decimals below a cent', () => {
    expect(formatMoney(0.0099)).toBe('$0.0099');
    expect(formatMoney(0.0001)).toBe('$0.0001');
  });

  it('collapses below a hundredth of a cent', () => {
    expect(formatMoney(0.00009)).toBe('<$0.0001');
    expect(formatMoney(-0.00009)).toBe('-<$0.0001');
  });

  it('renders exact zero as $0.00', () => {
    expect(formatMoney(0)).toBe('$0.00');
  });

  it('honours forced decimals and signed deltas', () => {
    expect(formatMoney(2, { decimals: 0 })).toBe('$2');
    expect(formatMoney(2.5, { signed: true })).toBe('+$2.50');
    expect(formatMoney(-2.5)).toBe('-$2.50');
  });

  it('degrades gracefully on non-finite input', () => {
    expect(formatMoney(Number.NaN)).toBe('—');
  });
});

describe('formatMoneyCompact', () => {
  it('abbreviates thousands and millions', () => {
    expect(formatMoneyCompact(1234)).toBe('$1.2k');
    expect(formatMoneyCompact(3_400_000)).toBe('$3.4M');
    expect(formatMoneyCompact(9.5)).toBe('$9.50');
  });
});

describe('formatTokens', () => {
  it('groups below 10k and abbreviates above', () => {
    expect(formatTokens(1234)).toBe('1,234');
    expect(formatTokens(12_300)).toBe('12.3k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
    expect(formatTokensFull(1_234_567)).toBe('1,234,567 tokens');
  });
});

describe('formatPercent', () => {
  it('renders a 0..1 fraction', () => {
    expect(formatPercent(0.1234)).toBe('12.3%');
    expect(formatPercent(1)).toBe('100.0%');
    expect(formatPercent(0, 0)).toBe('0%');
  });
});

describe('formatDuration', () => {
  it('picks the right unit pair', () => {
    expect(formatDuration(820)).toBe('820ms');
    expect(formatDuration(4200)).toBe('4.2s');
    expect(formatDuration(185_000)).toBe('3m 5s');
    expect(formatDuration(4_320_000)).toBe('1h 12m');
    expect(formatDuration(183_600_000)).toBe('2d 3h');
    expect(formatDuration(-1)).toBe('—');
  });
});

describe('date helpers', () => {
  const at = new Date(2026, 8, 7, 14, 5);

  it('formats dates and times in en-US', () => {
    expect(formatDate(at)).toBe('Sep 7, 2026');
    expect(formatTime(at)).toBe('14:05');
    expect(formatDateTime(at)).toContain('Sep 7, 2026');
    expect(formatDate('not a date')).toBe('—');
  });

  it('renders month keys without shifting timezone', () => {
    expect(formatMonthKey('2026-09')).toBe('September 2026');
    expect(formatMonthKey('2026-01')).toBe('January 2026');
  });
});

describe('formatModelLabel', () => {
  it('turns model ids into human labels', () => {
    expect(formatModelLabel('claude-opus-5')).toBe('Opus 5');
    expect(formatModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(formatModelLabel('claude-3-5-haiku')).toBe('Haiku 3.5');
    expect(formatModelLabel('claude-opus-5[1m]')).toBe('Opus 5 (1M)');
    expect(formatModelLabel('<synthetic>')).toBe('Synthetic');
    expect(formatModelLabel('gpt-9')).toBe('gpt-9');
    expect(formatModelLabel('gemini-4-carbon-medium')).toBe('Gemini 4 Carbon (Medium)');
    expect(formatModelLabel('gemini-4-neon-xhigh')).toBe('Gemini 4 Neon (XHigh)');
    expect(formatModelLabel('gemini-2.5-flash-lite')).toBe('Gemini 2.5 Flash-Lite');
    expect(formatModelLabel('models/gemini-3.8-flash-high')).toBe('Gemini 3.8 Flash (High)');
  });
});

describe('escapeHtml', () => {
  it('escapes every character that could break out of text', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});
