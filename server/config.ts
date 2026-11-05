/**
 * Persisted app configuration: pricing table + user settings + pins, stored as one JSON file
 * in CCA_HOME (never in the DB — the DB is a rebuildable cache). Reads are served from an
 * in-memory cache; writes are atomic (write to a tmp file, then rename) and re-tighten file
 * permissions to 0600.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { PricingConfig, UserSettings } from '../core/types.js';
import { defaultPricing, withDefaultOpenAIModels } from '../core/pricing/defaults.js';
import { pricingConfigSchema } from '../core/pricing/schema.js';
import { defaultSettings, userSettingsSchema } from '../core/settings.js';
import { ensureFileMode, ensureHomeDir } from './paths.js';
import { dirname } from 'node:path';

export interface ConfigData {
  pricing: PricingConfig;
  settings: UserSettings;
}

/** Non-fatal problem found while loading config.json; the caller may want to surface it. */
export interface ConfigLoadWarning {
  message: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses config.json, narrowing the JSON.parse `unknown` result immediately. */
function parseConfigFile(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) throw new Error('config.json root is not an object');
  return parsed;
}

export class ConfigStore {
  private data: ConfigData;
  readonly warnings: ConfigLoadWarning[];

  private constructor(private readonly configPath: string, data: ConfigData, warnings: ConfigLoadWarning[]) {
    this.data = data;
    this.warnings = warnings;
  }

  /** Loads config.json, validating with zod; falls back to defaults (with a warning) on any
   * corruption so the server always has a usable configuration. */
  static load(configPath: string): ConfigStore {
    const warnings: ConfigLoadWarning[] = [];
    let upgraded = false;
    let pricing: PricingConfig = defaultPricing();
    let settings: UserSettings = defaultSettings();

    if (existsSync(configPath)) {
      try {
        const raw = parseConfigFile(readFileSync(configPath, 'utf8'));
        const pricingResult = pricingConfigSchema.safeParse(raw.pricing);
        if (pricingResult.success) {
          pricing = withDefaultOpenAIModels(pricingResult.data);
          upgraded = pricing !== pricingResult.data;
        } else {
          warnings.push({ message: 'config.json pricing section is invalid; using defaults' });
        }
        const settingsResult = userSettingsSchema.safeParse(raw.settings);
        if (settingsResult.success) {
          settings = settingsResult.data;
          if (settings.roots.length === 1 && settings.roots[0] === '~/.claude/projects') {
            settings = { ...settings, roots: defaultSettings().roots };
            upgraded = true;
          }
        } else {
          warnings.push({ message: 'config.json settings section is invalid; using defaults' });
        }
      } catch {
        warnings.push({ message: 'config.json is corrupt JSON; using defaults' });
      }
    }

    const store = new ConfigStore(configPath, { pricing, settings }, warnings);
    if (upgraded || warnings.length > 0 || !existsSync(configPath)) {
      store.persist();
    }
    return store;
  }

  /** Current in-memory config (never triggers disk I/O). */
  get(): ConfigData {
    return this.data;
  }

  updatePricing(pricing: PricingConfig): PricingConfig {
    this.data = { ...this.data, pricing };
    this.persist();
    return this.data.pricing;
  }

  resetPricing(): PricingConfig {
    return this.updatePricing(defaultPricing());
  }

  updateSettings(settings: UserSettings): UserSettings {
    this.data = { ...this.data, settings };
    this.persist();
    return this.data.settings;
  }

  /** Toggles a session's pin in settings.pinnedSessionIds; returns the new pinned state. */
  togglePin(sessionId: string): { pinned: boolean } {
    const current = this.data.settings.pinnedSessionIds;
    const isPinned = current.includes(sessionId);
    const pinnedSessionIds = isPinned ? current.filter((id) => id !== sessionId) : [...current, sessionId];
    this.updateSettings({ ...this.data.settings, pinnedSessionIds });
    return { pinned: !isPinned };
  }

  private persist(): void {
    ensureHomeDir(dirname(this.configPath));
    const tmpPath = `${this.configPath}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmpPath, this.configPath);
    ensureFileMode(this.configPath);
  }
}
