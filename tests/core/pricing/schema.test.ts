import { describe, expect, it } from 'vitest';
import { defaultPricing } from '../../../core/pricing/defaults.js';
import { modelPriceSchema, parsePricingConfig, pricingConfigSchema } from '../../../core/pricing/schema.js';
import { PLAN_PRESETS, applyPlanPreset, defaultSettings, parseUserSettings } from '../../../core/settings.js';

describe('pricingConfigSchema', () => {
  it('accepts the shipped defaults', () => {
    expect(() => parsePricingConfig(defaultPricing())).not.toThrow();
  });

  it('rejects negative and non-finite prices', () => {
    const config = defaultPricing();
    const first = config.models[0];
    expect(first).toBeDefined();
    if (first) first.input = -1;
    expect(pricingConfigSchema.safeParse(config).success).toBe(false);

    const infinite = defaultPricing();
    const model = infinite.models[0];
    if (model) model.output = Number.POSITIVE_INFINITY;
    expect(pricingConfigSchema.safeParse(infinite).success).toBe(false);
  });

  it('rejects duplicate model keys', () => {
    const config = defaultPricing();
    const first = config.models[0];
    const second = config.models[1];
    if (first && second) second.key = first.key;
    const result = pricingConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('duplicate model key'))).toBe(true);
    }
  });

  it('requires a non-empty match list and a positive charsPerToken', () => {
    const base = defaultPricing().models[0];
    expect(base).toBeDefined();
    if (!base) return;
    expect(modelPriceSchema.safeParse({ ...base, match: [] }).success).toBe(false);
    expect(modelPriceSchema.safeParse({ ...base, match: [''] }).success).toBe(false);
    expect(modelPriceSchema.safeParse({ ...base, charsPerToken: 0 }).success).toBe(false);
  });

  it('requires fallbackModelKey to name a configured model', () => {
    const config = { ...defaultPricing(), unknownModelPolicy: 'fallbackModel' as const };
    expect(pricingConfigSchema.safeParse(config).success).toBe(false);
    expect(pricingConfigSchema.safeParse({ ...config, fallbackModelKey: 'sonnet-5' }).success).toBe(true);
  });
});

describe('settings', () => {
  it('ships sensible defaults', () => {
    const settings = defaultSettings();
    expect(settings.roots).toEqual(['~/.claude/projects', '~/.codex/sessions', '~/.codex/archived_sessions']);
    expect(settings.theme).toBe('system');
    expect(settings.plan.preset).toBe('none');
    expect(settings.hideScratchProjects).toBe(true);
    expect(settings.pinnedSessionIds).toEqual([]);
    expect(() => parseUserSettings(settings)).not.toThrow();
  });

  it('exposes the documented plan prices', () => {
    expect(PLAN_PRESETS.pro.monthlyUsd).toBe(20);
    expect(PLAN_PRESETS.max5.monthlyUsd).toBe(100);
    expect(PLAN_PRESETS.max20.monthlyUsd).toBe(200);
    expect(PLAN_PRESETS['team-premium'].monthlyUsd).toBe(125);
    expect(PLAN_PRESETS.custom.monthlyUsd).toBe(0);
  });

  it('keeps a custom plan price when applying the custom preset', () => {
    const custom = applyPlanPreset({ ...defaultSettings(), plan: { preset: 'custom', monthlyUsd: 42, label: 'x' } }, 'custom');
    expect(custom.plan.monthlyUsd).toBe(42);
    expect(applyPlanPreset(defaultSettings(), 'max20').plan.monthlyUsd).toBe(200);
  });

  it('rejects an empty roots list and a non-positive currency rate', () => {
    expect(() => parseUserSettings({ ...defaultSettings(), roots: [] })).toThrow();
    expect(() => parseUserSettings({ ...defaultSettings(), currency: { code: 'USD', rate: 0 } })).toThrow();
  });
});
