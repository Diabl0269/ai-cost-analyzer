/**
 * User settings: defaults, validation, and the subscription plan presets (SPEC §10.1).
 * Persisted in `~/.claude-cost-analyzer/config.json` by the server, never in the DB.
 */
import { z } from 'zod';
import type { MenubarSettings, PlanPreset, Provider, UserSettings } from './types.js';

export const ALL_PROVIDERS: readonly Provider[] = ['claude', 'codex', 'copilot', 'opencode', 'gemini'];

export function defaultMenubarSettings(): MenubarSettings {
  return {
    showBudgetPie: true,
    showProviderPies: true,
    showMenuPie: true,
    showTodayCost: true,
  };
}

export interface PlanPresetInfo {
  preset: PlanPreset;
  label: string;
  monthlyUsd: number;
}

export const PLAN_PRESETS: Record<PlanPreset, PlanPresetInfo> = {
  none: { preset: 'none', label: 'No subscription', monthlyUsd: 0 },
  pro: { preset: 'pro', label: 'Pro', monthlyUsd: 20 },
  max5: { preset: 'max5', label: 'Max 5×', monthlyUsd: 100 },
  max20: { preset: 'max20', label: 'Max 20×', monthlyUsd: 200 },
  'team-premium': { preset: 'team-premium', label: 'Team Premium (per seat)', monthlyUsd: 125 },
  custom: { preset: 'custom', label: 'Custom', monthlyUsd: 0 },
};

export const DEFAULT_ROOT = '~/.claude/projects';

export function defaultSettings(): UserSettings {
  return {
    version: 1,
    roots: [DEFAULT_ROOT, '~/.codex/sessions', '~/.codex/archived_sessions', '~/.copilot/session-state'],
    theme: 'system',
    plan: { preset: 'none', monthlyUsd: 0, label: PLAN_PRESETS.none.label },
    monthlyBudgetUsd: null,
    budgetProviders: null,
    providerBudgets: {},
    menubar: defaultMenubarSettings(),
    currency: { code: 'USD', rate: 1 },
    pinnedSessionIds: [],
    hideScratchProjects: true,
    hiddenProviders: [],
    reducedMotion: 'system',
  };
}

const planPresetSchema = z.enum(['none', 'pro', 'max5', 'max20', 'team-premium', 'custom']);
const providerSchema = z.enum(['claude', 'codex', 'copilot', 'opencode', 'gemini']);

const providerBudgetsSchema = z
  .object({
    claude: z.number().min(0).optional(),
    codex: z.number().min(0).optional(),
    copilot: z.number().min(0).optional(),
    opencode: z.number().min(0).optional(),
    gemini: z.number().min(0).optional(),
  })
  .optional()
  .default({});

const menubarSettingsSchema = z
  .object({
    showBudgetPie: z.boolean().default(true),
    showProviderPies: z.boolean().default(true),
    showMenuPie: z.boolean().default(true),
    showTodayCost: z.boolean().default(true),
  })
  .optional()
  .default(() => defaultMenubarSettings());

export const userSettingsSchema = z.object({
  version: z.literal(1),
  roots: z.array(z.string().trim().min(1)).min(1),
  theme: z.enum(['system', 'paper', 'slate']),
  plan: z.object({
    preset: planPresetSchema,
    monthlyUsd: z.number().min(0),
    label: z.string(),
  }),
  monthlyBudgetUsd: z.number().min(0).nullable(),
  budgetProviders: z.array(providerSchema).nullable().optional().default(null),
  providerBudgets: providerBudgetsSchema,
  menubar: menubarSettingsSchema,
  currency: z.object({
    code: z.string().trim().length(3).toUpperCase(),
    rate: z.number().gt(0),
  }),
  pinnedSessionIds: z.array(z.string().min(1)),
  hideScratchProjects: z.boolean(),
  hiddenProviders: z.array(providerSchema).default([]),
  reducedMotion: z.enum(['system', 'on', 'off']),
});

/** Throws a ZodError with a field path when the body is invalid. */
export function parseUserSettings(input: unknown): UserSettings {
  return userSettingsSchema.parse(input);
}

/** Applies a preset's price/label, leaving `custom` amounts untouched. */
export function applyPlanPreset(settings: UserSettings, preset: PlanPreset): UserSettings {
  const info = PLAN_PRESETS[preset];
  return {
    ...settings,
    plan: {
      preset,
      label: info.label,
      monthlyUsd: preset === 'custom' ? settings.plan.monthlyUsd : info.monthlyUsd,
    },
  };
}
