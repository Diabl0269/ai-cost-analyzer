/**
 * Default list-price table (SPEC §5.2).
 * Source: platform.claude.com/docs/en/about-claude/pricing, captured 2026-09-07.
 * All money here is USD per million tokens; conversion to USD/token happens in resolve.ts.
 */
import type { ModelPrice, PricingConfig, TokenPrices } from '../types.js';

export const OPENAI_PRICING_SOURCE = 'https://developers.openai.com/api/docs/pricing (2026-11-05)';
export const PRICING_SOURCE = `platform.claude.com/docs/en/about-claude/pricing (2026-09-07); ${OPENAI_PRICING_SOURCE}`;

const CPT_MODERN = 3.1;
const CPT_LEGACY = 4.0;

function prices(input: number, output: number, w5: number, w1: number, read: number): TokenPrices {
  return { input, output, cacheWrite5m: w5, cacheWrite1h: w1, cacheRead: read };
}

/** Fast mode on Opus-class models is billed at the Fable/Mythos rate card. */
const FAST_OPUS: TokenPrices = prices(10, 50, 12.5, 20, 1);

/** Published standard API prices only. Exact IDs prevent future variants inheriting a guessed price.
 * Codex usage has no cache-write buckets; reasoning tokens are already included in output.
 * The shared cache-write TTL fields are Claude-specific and stay zero for OpenAI.
 */
export function defaultOpenAIModels(): ModelPrice[] {
  const rows: [string, number, number, number, number?, number?, number?][] = [
    ['gpt-6-astra', 10, 50, 1, 20, 100, 2],
    ['gpt-6.1-sol', 2, 10, 0.1, 4, 20, 0.2],
    ['gpt-6.1-terra', 1, 5, 0.05, 2, 10, 0.1],
    ['gpt-6-luna', 0.1, 0.5, 0.01, 0.2, 1, 0.02],
    ['gpt-6-sol', 2, 10, 0.2, 4, 20, 0.4],
    ['gpt-5.3-codex', 1.75, 14, 0.175, 3.5, 28, 0.35],
    ['gpt-5.2', 1.75, 14, 0.175, 3.5, 28, 0.35],
    ['gpt-5.1', 1.25, 10, 0.125, 2.5, 20, 0.25],
    ['gpt-5', 1.25, 10, 0.125, 2.5, 20, 0.25],
    ['gpt-5-mini', 0.25, 2, 0.025, 0.45, 3.6, 0.045],
    ['gpt-5-nano', 0.05, 0.4, 0.005],
    ['gpt-4.1', 2, 8, 0.5, 3.5, 14, 0.875],
    ['gpt-4.1-mini', 0.4, 1.6, 0.1, 0.7, 2.8, 0.175],
    ['gpt-4o', 2.5, 10, 1.25, 4.25, 17, 2.125],
    ['gpt-4o-mini', 0.15, 0.6, 0.075, 0.25, 1, 0.125],
    ['o3', 2, 8, 0.5, 3.5, 14, 0.875],
  ];
  return rows.map(([id, input, output, cached, fastInput, fastOutput, fastCached]) => ({
    key: id,
    label: id,
    match: [id],
    exact: true,
    ...prices(input, output, 0, 0, cached),
    ...(fastInput !== undefined && fastOutput !== undefined && fastCached !== undefined
      ? { fast: prices(fastInput, fastOutput, 0, 0, fastCached) } : {}),
    // GPT-6 model pages explicitly document a full-request >272K premium, including cache.
    ...(id.startsWith('gpt-6') ? {
      longContext: { threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    } : {}),
    supportsUsGeo: false,
    charsPerToken: CPT_LEGACY,
    family: 'other',
  }));
}

/** Add newly shipped OpenAI rows without replacing any saved prices or custom matches. */
export function withDefaultOpenAIModels(config: PricingConfig): PricingConfig {
  const additions = defaultOpenAIModels().filter((model) => !config.models.some((saved) =>
    saved.key === model.key || saved.match.some((match) => model.match.includes(match))));
  return additions.length ? { ...config, models: [...config.models, ...additions] } : config;
}

function defaultModels(): ModelPrice[] {
  return [
    {
      key: 'fable-5.1',
      label: 'Claude Fable 5.1',
      match: ['claude-fable-5-1'],
      ...prices(10, 50, 12.5, 20, 0.25),
      supportsUsGeo: true,
      charsPerToken: CPT_MODERN,
      family: 'fable',
    },
    {
      key: 'mythos-5.1',
      label: 'Claude Mythos 5.1',
      match: ['claude-mythos-5-1'],
      ...prices(10, 50, 12.5, 20, 0.25),
      supportsUsGeo: true,
      charsPerToken: CPT_MODERN,
      family: 'mythos',
    },
    {
      key: 'fable-5',
      label: 'Claude Fable 5',
      match: ['claude-fable-5'],
      ...prices(10, 50, 12.5, 20, 1),
      supportsUsGeo: true,
      charsPerToken: CPT_MODERN,
      family: 'fable',
    },
    {
      key: 'mythos-5',
      label: 'Claude Mythos 5',
      match: ['claude-mythos-5'],
      ...prices(10, 50, 12.5, 20, 1),
      supportsUsGeo: true,
      charsPerToken: CPT_MODERN,
      family: 'mythos',
    },
    {
      key: 'opus-5',
      label: 'Claude Opus 5',
      match: ['claude-opus-5'],
      ...prices(5, 25, 6.25, 10, 0.5),
      fast: FAST_OPUS,
      supportsUsGeo: true,
      charsPerToken: CPT_MODERN,
      family: 'opus',
    },
    {
      key: 'opus-4.8',
      label: 'Claude Opus 4.8',
      match: ['claude-opus-4-8'],
      ...prices(5, 25, 6.25, 10, 0.5),
      fast: FAST_OPUS,
      supportsUsGeo: true,
      charsPerToken: CPT_MODERN,
      family: 'opus',
    },
    {
      key: 'opus-4.7',
      label: 'Claude Opus 4.7',
      match: ['claude-opus-4-7'],
      ...prices(5, 25, 6.25, 10, 0.5),
      supportsUsGeo: true,
      charsPerToken: CPT_MODERN,
      family: 'opus',
    },
    {
      key: 'opus-4.6',
      label: 'Claude Opus 4.6',
      match: ['claude-opus-4-6'],
      ...prices(5, 25, 6.25, 10, 0.5),
      supportsUsGeo: true,
      charsPerToken: CPT_LEGACY,
      family: 'opus',
    },
    {
      key: 'opus-4.5',
      label: 'Claude Opus 4.5',
      match: ['claude-opus-4-5'],
      ...prices(5, 25, 6.25, 10, 0.5),
      supportsUsGeo: false,
      charsPerToken: CPT_LEGACY,
      family: 'opus',
    },
    {
      key: 'opus-4.1',
      label: 'Claude Opus 4.1',
      match: ['claude-opus-4-1'],
      ...prices(15, 75, 18.75, 30, 1.5),
      supportsUsGeo: false,
      charsPerToken: CPT_LEGACY,
      family: 'opus',
    },
    {
      key: 'opus-4',
      label: 'Claude Opus 4',
      match: ['claude-opus-4-2', 'claude-opus-4'],
      exact: true,
      ...prices(15, 75, 18.75, 30, 1.5),
      supportsUsGeo: false,
      charsPerToken: CPT_LEGACY,
      family: 'opus',
    },
    {
      key: 'sonnet-5',
      label: 'Claude Sonnet 5',
      match: ['claude-sonnet-5'],
      ...prices(2, 10, 2.5, 4, 0.2),
      supportsUsGeo: true,
      charsPerToken: CPT_MODERN,
      family: 'sonnet',
    },
    {
      key: 'sonnet-4.6',
      label: 'Claude Sonnet 4.6',
      match: ['claude-sonnet-4-6'],
      ...prices(3, 15, 3.75, 6, 0.3),
      supportsUsGeo: true,
      charsPerToken: CPT_LEGACY,
      family: 'sonnet',
    },
    {
      key: 'sonnet-4.5',
      label: 'Claude Sonnet 4.5',
      match: ['claude-sonnet-4-5'],
      ...prices(3, 15, 3.75, 6, 0.3),
      supportsUsGeo: false,
      charsPerToken: CPT_LEGACY,
      family: 'sonnet',
    },
    {
      key: 'sonnet-4',
      label: 'Claude Sonnet 4',
      match: ['claude-sonnet-4-2', 'claude-sonnet-4'],
      exact: true,
      ...prices(3, 15, 3.75, 6, 0.3),
      supportsUsGeo: false,
      charsPerToken: CPT_LEGACY,
      family: 'sonnet',
    },
    {
      key: 'sonnet-3.7',
      label: 'Claude Sonnet 3.7',
      match: ['claude-3-7-sonnet'],
      ...prices(3, 15, 3.75, 6, 0.3),
      supportsUsGeo: false,
      charsPerToken: CPT_LEGACY,
      family: 'sonnet',
    },
    {
      key: 'haiku-4.5',
      label: 'Claude Haiku 4.5',
      match: ['claude-haiku-4-5'],
      ...prices(1, 5, 1.25, 2, 0.1),
      supportsUsGeo: false,
      charsPerToken: CPT_LEGACY,
      family: 'haiku',
    },
    {
      key: 'haiku-3.5',
      label: 'Claude Haiku 3.5',
      match: ['claude-3-5-haiku'],
      ...prices(0.8, 4, 1, 1.6, 0.08),
      supportsUsGeo: false,
      charsPerToken: CPT_LEGACY,
      family: 'haiku',
    },
    ...defaultOpenAIModels(),
    {
      key: 'synthetic',
      label: '(synthetic)',
      match: ['<synthetic>'],
      ...prices(0, 0, 0, 0, 0),
      supportsUsGeo: false,
      charsPerToken: CPT_LEGACY,
      family: 'synthetic',
    },
  ];
}

/** Fresh, mutable copy of the shipped pricing table. */
export function defaultPricing(): PricingConfig {
  return {
    version: 1,
    updatedAt: '2026-11-05T00:00:00.000Z',
    source: PRICING_SOURCE,
    models: defaultModels(),
    webSearchPer1000: 10,
    usGeoMultiplier: 1.1,
    batchMultiplier: 0.5,
    unknownModelPolicy: 'zero',
    assumeCacheWriteTtlWhenUnknown: '5m',
  };
}

/** Characters-per-token used when no model price is known. */
export const FALLBACK_CHARS_PER_TOKEN = CPT_LEGACY;

/** Tokens charged for one image in a tool result (SPEC §5.3). */
export const IMAGE_TOKENS = 1600;
