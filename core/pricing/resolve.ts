/**
 * Model-id normalization and price resolution (SPEC §5.1, §5.2).
 * `ResolvedPrice.perToken` is USD per single token, with every modifier already applied.
 */
import type {
  InferenceGeo,
  ModelFamily,
  ModelPrice,
  PricingConfig,
  ResolvedPrice,
  ServiceTier,
  Speed,
  TokenPrices,
} from '../types.js';
import { FALLBACK_CHARS_PER_TOKEN } from './defaults.js';

const PER_MTOK = 1_000_000;

export interface PriceFlags {
  contextTokens?: number;
  /** Positive write usage requires a configured write tariff for OpenAI models. */
  cacheWriteTokens?: number;
  speed: Speed;
  inferenceGeo: InferenceGeo;
  serviceTier: ServiceTier;
}

export const STANDARD_FLAGS: PriceFlags = {
  speed: 'standard',
  inferenceGeo: 'global',
  serviceTier: 'standard',
};

/** lowercase, drop the `[1m]` long-context marker and any `@version` suffix. */
export function normalizeModelId(id: string): string {
  let out = id.trim().toLowerCase();
  const at = out.indexOf('@');
  if (at >= 0) out = out.slice(0, at);
  while (out.endsWith('[1m]')) out = out.slice(0, -4);
  return out.trim();
}

const FAMILY_WORDS: { word: string; family: ModelFamily }[] = [
  { word: 'fable', family: 'fable' },
  { word: 'mythos', family: 'mythos' },
  { word: 'opus', family: 'opus' },
  { word: 'sonnet', family: 'sonnet' },
  { word: 'haiku', family: 'haiku' },
];

/** Family of a raw model id, independent of whether it has a price. */
export function modelFamily(id: string): ModelFamily {
  const norm = normalizeModelId(id);
  if (norm === '<synthetic>' || norm.includes('synthetic')) return 'synthetic';
  for (const { word, family } of FAMILY_WORDS) {
    if (norm.includes(word)) return family;
  }
  return 'other';
}

/**
 * Longest prefix wins. `exact: true` entries only participate when no prefix entry matched,
 * and then only on full equality.
 */
export function findModelPrice(id: string, pricing: PricingConfig): ModelPrice | null {
  const norm = normalizeModelId(id);
  let best: ModelPrice | null = null;
  let bestLen = -1;
  for (const model of pricing.models) {
    if (model.exact) continue;
    for (const prefix of model.match) {
      const p = prefix.toLowerCase();
      if (p.length > bestLen && norm.startsWith(p)) {
        best = model;
        bestLen = p.length;
      }
    }
  }
  if (best) return best;
  for (const model of pricing.models) {
    if (!model.exact) continue;
    for (const literal of model.match) {
      if (norm === literal.toLowerCase()) return model;
    }
  }
  // Copilot's provider prefix and dotted Claude versions identify the same underlying model.
  // Resolve literal/custom entries first so existing user pricing always wins.
  const canonical = norm.replace(/^copilot\//, '').replace(/^(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)(?=-|$)/, '$1-$2');
  return canonical !== norm ? findModelPrice(canonical, pricing) : null;
}

function scale(p: TokenPrices, factor: number): TokenPrices {
  return {
    input: p.input * factor,
    output: p.output * factor,
    cacheWrite5m: p.cacheWrite5m * factor,
    cacheWrite1h: p.cacheWrite1h * factor,
    cacheRead: p.cacheRead * factor,
  };
}

export const ZERO_TOKEN_PRICES: TokenPrices = {
  input: 0,
  output: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
};

function unpricedResult(model: string): ResolvedPrice {
  return {
    modelKey: null,
    label: model,
    family: modelFamily(model),
    perToken: ZERO_TOKEN_PRICES,
    charsPerToken: FALLBACK_CHARS_PER_TOKEN,
    unpriced: true,
    multipliers: { fast: false, usGeo: false, batch: false },
  };
}

function priceFor(model: ModelPrice, flags: PriceFlags, pricing: PricingConfig, unpriced: boolean): ResolvedPrice {
  const useFast = flags.speed === 'fast' && model.fast !== undefined;
  const base: TokenPrices = useFast && model.fast ? model.fast : model;
  const usGeo = flags.inferenceGeo === 'us' && model.supportsUsGeo;
  const batch = flags.serviceTier === 'batch';
  let factor = 1 / PER_MTOK;
  if (usGeo) factor *= pricing.usGeoMultiplier;
  if (batch) factor *= pricing.batchMultiplier;
  // OpenAI retention is not the shared Claude 5m/1h TTL. Preserve the known cost floor
  // when a rollout reports writes without a configured tariff, rather than implying free writes.
  const openAI = model.match.some((id) => /^(?:gpt-|o[1-9](?:-|$))/i.test(id));
  const unpricedWrites = openAI && (flags.cacheWriteTokens ?? 0) > 0
    && base.cacheWrite5m === 0 && base.cacheWrite1h === 0;
  const perToken = scale(base, factor);
  const longContext = model.longContext;
  if (longContext && (flags.contextTokens ?? 0) > longContext.threshold) {
    perToken.input *= longContext.inputMultiplier;
    perToken.cacheRead *= longContext.inputMultiplier;
    perToken.cacheWrite5m *= longContext.inputMultiplier;
    perToken.cacheWrite1h *= longContext.inputMultiplier;
    perToken.output *= longContext.outputMultiplier;
  }
  return {
    modelKey: model.key,
    label: model.label,
    family: model.family,
    perToken,
    charsPerToken: model.charsPerToken,
    unpriced: unpriced || unpricedWrites,
    multipliers: { fast: useFast, usGeo, batch },
  };
}

/**
 * Resolve USD-per-token prices for one billed unit.
 * Unknown models follow `pricing.unknownModelPolicy`; either way `unpriced` is true so the UI
 * can flag the number as not trustworthy.
 */
export function resolvePrice(model: string, flags: PriceFlags, pricing: PricingConfig): ResolvedPrice {
  const found = findModelPrice(model, pricing);
  if (found) return priceFor(found, flags, pricing, false);
  if (pricing.unknownModelPolicy === 'fallbackModel' && pricing.fallbackModelKey) {
    const fallback = pricing.models.find((m) => m.key === pricing.fallbackModelKey);
    if (fallback) return priceFor(fallback, flags, pricing, true);
  }
  return unpricedResult(model);
}

export type PriceResolver = (model: string, flags: PriceFlags) => ResolvedPrice;

/**
 * Memoized resolver for hot aggregation loops.
 * `whatIf` maps a model key to a substitute model key (SPEC §10.4); substitution happens after
 * the real model is identified, so unknown models are never silently re-priced.
 */
export function createPriceResolver(pricing: PricingConfig, whatIf?: ReadonlyMap<string, string>): PriceResolver {
  const cache = new Map<string, ResolvedPrice>();
  const byKey = new Map<string, ModelPrice>();
  for (const m of pricing.models) byKey.set(m.key, m);
  return (model, flags) => {
    const cacheKey = `${model}\u0000${flags.speed}\u0000${flags.inferenceGeo}\u0000${flags.serviceTier}\0${flags.contextTokens ?? 0}\0${(flags.cacheWriteTokens ?? 0) > 0 ? 1 : 0}`;
    const hit = cache.get(cacheKey);
    if (hit) return hit;
    let resolved = resolvePrice(model, flags, pricing);
    if (whatIf && whatIf.size > 0 && resolved.modelKey) {
      const targetKey = whatIf.get(resolved.modelKey);
      const target = targetKey ? byKey.get(targetKey) : undefined;
      if (target) resolved = priceFor(target, flags, pricing, resolved.unpriced);
    }
    cache.set(cacheKey, resolved);
    return resolved;
  };
}

/** Parse the `whatIf` query parameter: `fromKey>toKey,fromKey>toKey`. */
export function parseWhatIf(spec: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!spec) return out;
  for (const part of spec.split(',')) {
    const [from, to] = part.split('>');
    const f = from?.trim();
    const t = to?.trim();
    if (f && t) out.set(f, t);
  }
  return out;
}

/** charsPerToken for a model id, with the documented 4.0 fallback. */
export function charsPerTokenFor(model: string | undefined, pricing: PricingConfig): number {
  if (!model) return FALLBACK_CHARS_PER_TOKEN;
  const found = findModelPrice(model, pricing);
  return found ? found.charsPerToken : FALLBACK_CHARS_PER_TOKEN;
}
