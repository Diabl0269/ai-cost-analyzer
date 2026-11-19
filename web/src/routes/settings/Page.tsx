import { useEffect, useState } from 'react';
import type { PlanPreset, UserSettings } from '@core/types';
import { PLAN_PRESETS, applyPlanPreset } from '@core/settings';
import { Button, Callout, NumberField, SegmentedControl, Select, Skeleton, Switch, useToast } from '@/components';
import { PROVIDERS } from '@/lib/provider';
import { useCurrency } from '@/lib/currency';
import { formatMoney } from '@/lib/format';
import { applyMotionPreference, type MotionPreference } from '@/lib/motion';
import { PageHeader, QueryError, Section } from '@/lib/page';
import { useSettings, useUpdateSettings } from '@/lib/queries';
import { useTheme, type ThemeChoice } from '@/lib/theme';
import { DataSection, PricingSection } from './components';
import styles from './Settings.module.css';

const NAV = [
  { id: 'pricing', label: 'Pricing' },
  { id: 'plan', label: 'Plan' },
  { id: 'budget', label: 'Budget' },
  { id: 'currency', label: 'Currency' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'data', label: 'Data' },
];

const PLAN_ORDER: PlanPreset[] = ['none', 'pro', 'max5', 'max20', 'team-premium', 'custom'];

/** Everything the app lets you change, on one page with an in-page contents list. */
export default function SettingsPage() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const currency = useCurrency();
  const theme = useTheme();
  const { toast } = useToast();

  const [draft, setDraft] = useState<UserSettings | null>(null);
  const current = draft ?? settings.data ?? null;
  const dirty = draft !== null && settings.data !== undefined && JSON.stringify(draft) !== JSON.stringify(settings.data);

  // Live preview of the draft while this page is open. `App.tsx` applies the *saved* preference
  // at boot, so this only has to cover the unsaved edit.
  useEffect(() => {
    if (current) applyMotionPreference(current.reducedMotion);
  }, [current]);

  const commit = (next: UserSettings, message: string): void => {
    setDraft(next);
    update.mutate(next, {
      onSuccess: () => {
        setDraft(null);
        toast({ title: message, tone: 'save' });
      },
      onError: () => toast({ title: 'Could not save settings', tone: 'cost' }),
    });
  };

  const edit = (next: UserSettings): void => setDraft(next);

  return (
    <div className="stack stack-lg">
      <PageHeader
        title="Settings"
        lead="Prices, plan, budget and how the index is built. Everything here is stored in ~/.claude-cost-analyzer/config.json and never leaves this machine."
      />

      <div className={styles.layout}>
        <nav className={styles.nav} aria-labelledby="settings-nav-heading">
          <h2 id="settings-nav-heading" className="eyebrow" style={{ marginBottom: 'var(--s2)' }}>
            Sections
          </h2>
          <ul className={styles.navList}>
            {NAV.map((entry) => (
              <li key={entry.id}>
                <a className={styles.navLink} href={`#${entry.id}`}>
                  {entry.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="stack stack-lg">
          <PricingSection />

          {settings.isError ? (
            <QueryError error={settings.error} what="your settings" onRetry={() => void settings.refetch()} />
          ) : null}
          {settings.isPending ? <Skeleton height={200} label="Loading settings" /> : null}

          {current ? (
            <>
              <Section id="plan" title="Plan" note="what the same usage would cost on a subscription">
                <div className={`${styles.card} ${styles.fields}`}>
                  <Select
                    label="Subscription"
                    value={current.plan.preset}
                    onChange={(value) => commit(applyPlanPreset(current, value as PlanPreset), 'Plan updated')}
                    options={PLAN_ORDER.map((preset) => ({
                      value: preset,
                      label:
                        preset === 'none' || preset === 'custom'
                          ? PLAN_PRESETS[preset].label
                          : `${PLAN_PRESETS[preset].label} — ${formatMoney(PLAN_PRESETS[preset].monthlyUsd)}/mo`,
                    }))}
                  />
                  <NumberField
                    label="Monthly price"
                    value={current.plan.monthlyUsd}
                    onChange={(value) => edit({ ...current, plan: { ...current.plan, monthlyUsd: value ?? 0 } })}
                    min={0}
                    step={5}
                    prefix="$"
                    suffix="/ month"
                    width={200}
                    disabled={current.plan.preset !== 'custom'}
                    hint={current.plan.preset === 'custom' ? 'Team seats: enter your per-seat price.' : 'Choose “Custom” to edit.'}
                  />
                </div>
              </Section>

              <Section id="budget" title="Budget" note="drives the forecast on the overview">
                <div className={`${styles.card} ${styles.fields}`}>
                  <NumberField
                    label="Monthly budget"
                    value={current.monthlyBudgetUsd}
                    onChange={(value) => edit({ ...current, monthlyBudgetUsd: value })}
                    min={0}
                    step={10}
                    prefix="$"
                    suffix="/ month"
                    width={220}
                    placeholder="No budget"
                    hint="Leave empty for no budget. The forecast is spend so far ÷ days elapsed × days in month."
                  />
                </div>
              </Section>

              <Section id="currency" title="Currency" note="display only — every figure is computed in USD">
                <div className={`${styles.card} ${styles.fields}`}>
                  <label className={styles.textField} style={{ width: 120 }}>
                    <span className={styles.textLabel}>Code</span>
                    <input
                      className={styles.textInput}
                      value={current.currency.code}
                      maxLength={3}
                      aria-describedby="currency-hint"
                      onChange={(event) =>
                        edit({ ...current, currency: { ...current.currency, code: event.target.value.toUpperCase() } })
                      }
                    />
                  </label>
                  <NumberField
                    label="Rate per USD"
                    value={current.currency.rate}
                    onChange={(value) => edit({ ...current, currency: { ...current.currency, rate: value ?? 1 } })}
                    min={0.000001}
                    step={0.01}
                    width={200}
                  />
                  <p id="currency-hint" className="ui-xs muted-2" style={{ alignSelf: 'flex-end' }}>
                    A manual rate: nothing is fetched. {formatMoney(1)} shows as {formatMoney(1, currency)}.
                  </p>
                </div>
              </Section>

              <Section id="appearance" title="Appearance">
                <div className={`${styles.card} ${styles.stackFields}`}>
                  {/* Both controls are sized to their own content: a three-way switch and a
                      three-option select stretched across the card read as unfinished. */}
                  <div className={styles.control}>
                    <SegmentedControl
                      label="Theme"
                      value={current.theme}
                      onChange={(value) => {
                        theme.setTheme(value as ThemeChoice);
                        commit({ ...current, theme: value as UserSettings['theme'] }, 'Theme saved');
                      }}
                      options={[
                        { value: 'system', label: 'System' },
                        { value: 'paper', label: 'Paper', icon: 'sun' },
                        { value: 'slate', label: 'Slate', icon: 'moon' },
                      ]}
                    />
                  </div>
                  <div className={styles.control}>
                    <Select
                      label="Reduced motion"
                      value={current.reducedMotion}
                      onChange={(value) => {
                        applyMotionPreference(value as MotionPreference);
                        commit({ ...current, reducedMotion: value as UserSettings['reducedMotion'] }, 'Motion preference saved');
                      }}
                      options={[
                        { value: 'system', label: 'Follow the system setting' },
                        { value: 'on', label: 'Always reduce motion' },
                        { value: 'off', label: 'Always animate' },
                      ]}
                    />
                  </div>
                  <Switch
                    checked={current.hideScratchProjects}
                    onChange={(checked) => commit({ ...current, hideScratchProjects: checked }, 'Preference saved')}
                    label="Hide scratch projects"
                    description="Projects whose working directory sits under /tmp or /private/var/folders — throwaway sessions that would otherwise crowd the project tree."
                  />
                  {PROVIDERS.map((provider) => (
                    <Switch
                      key={provider.value}
                      checked={!current.hiddenProviders.includes(provider.value)}
                      onChange={(checked) => commit({
                        ...current,
                        hiddenProviders: checked
                          ? current.hiddenProviders.filter((hidden) => hidden !== provider.value)
                          : [...current.hiddenProviders, provider.value],
                      }, 'Preference saved')}
                      label={`Show ${provider.label}`}
                      description={`Offer ${provider.label} in the provider filter and the menu-bar summary. Its sessions stay indexed.`}
                    />
                  ))}
                </div>
              </Section>

              <DataSection />

              {dirty ? (
                <div className={styles.saveBar} role="status">
                  <span className={styles.saveBarText}>You have unsaved changes.</span>
                  <Button variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={update.isPending}>
                    Discard
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={update.isPending}
                    onClick={() => {
                      if (draft) commit(draft, 'Settings saved');
                    }}
                  >
                    Save changes
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}

          {settings.data && settings.data.roots.length === 0 ? (
            <Callout tone="warn" title="No transcript root configured">
              Add one to <code>~/.claude-cost-analyzer/config.json</code> and re-index.
            </Callout>
          ) : null}
        </div>
      </div>
    </div>
  );
}
