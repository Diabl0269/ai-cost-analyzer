import { useEffect, useState } from 'react';
import type { MenubarSettings, PlanPreset, Provider, UserSettings } from '@core/types';
import { ALL_PROVIDERS, PLAN_PRESETS, applyPlanPreset, defaultMenubarSettings } from '@core/settings';
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
  { id: 'menubar', label: 'Menu bar' },
  { id: 'currency', label: 'Currency' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'data', label: 'Data' },
];

const PROVIDER_COLORS: Record<Provider, string> = {
  claude: '#d9754f',
  codex: '#29b580',
  copilot: '#4085f5',
  opencode: '#1aadca',
  gemini: '#8f66f5',
};

function MiniPiePreview({ slices, size = 16 }: { slices: { color: string; fraction: number }[]; size?: number }) {
  const r = size / 2 - 1;
  const cx = size / 2;
  const cy = size / 2;
  let angle = -Math.PI / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx={cx} cy={cy} r={r} fill="var(--paper-3)" stroke="var(--rule-strong)" strokeWidth="1" />
      {slices.map((slice, i) => {
        const clamped = Math.min(1, Math.max(0, slice.fraction));
        if (clamped <= 0) return null;
        if (clamped >= 0.999) {
          return <circle key={i} cx={cx} cy={cy} r={r} fill={slice.color} />;
        }
        const start = angle;
        const end = angle + clamped * Math.PI * 2;
        angle = end;
        const x1 = cx + r * Math.cos(start);
        const y1 = cy + r * Math.sin(start);
        const x2 = cx + r * Math.cos(end);
        const y2 = cy + r * Math.sin(end);
        const largeArc = clamped > 0.5 ? 1 : 0;
        return (
          <path
            key={i}
            d={`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`}
            fill={slice.color}
          />
        );
      })}
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--ink-3)" strokeOpacity="0.4" strokeWidth="0.9" />
    </svg>
  );
}

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

              <Section id="budget" title="Budget" note="drives the forecast on the overview and the menu-bar pie charts">
                <div className={`${styles.card} ${styles.budgetCard}`}>
                  <div className={styles.fields}>
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
                      hint="Leave empty for no shared budget. The forecast is spend so far ÷ days elapsed × days in month."
                    />
                  </div>

                  <fieldset className={styles.budgetGroup}>
                    <legend className={styles.budgetLegend}>Tools counted in monthly budget</legend>
                    <p className="ui-xs muted-2">
                      Unchecked tools are treated as unlimited and excluded from the shared monthly budget.
                    </p>
                    <div className={styles.providerPills}>
                      {PROVIDERS.map((provider) => {
                        const included =
                          current.budgetProviders == null
                            ? true
                            : current.budgetProviders.includes(provider.value);
                        return (
                          <label
                            key={provider.value}
                            className={[styles.providerPill, included ? styles.providerPillOn : null]
                              .filter(Boolean)
                              .join(' ')}
                          >
                            <input
                              type="checkbox"
                              checked={included}
                              onChange={(event) => {
                                const base = current.budgetProviders ?? [...ALL_PROVIDERS];
                                const nextList = event.target.checked
                                  ? [...new Set([...base, provider.value])]
                                  : base.filter((p) => p !== provider.value);
                                const normalized =
                                  nextList.length === ALL_PROVIDERS.length ? null : nextList;
                                edit({ ...current, budgetProviders: normalized });
                              }}
                            />
                            <span
                              className={styles.providerDot}
                              style={{ background: PROVIDER_COLORS[provider.value] }}
                              aria-hidden="true"
                            />
                            <span>{provider.label}</span>
                            {!included ? <span className={styles.unlimitedTag}>unlimited</span> : null}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>

                  <fieldset className={styles.budgetGroup}>
                    <legend className={styles.budgetLegend}>Per-tool monthly caps (optional)</legend>
                    <p className="ui-xs muted-2">
                      Set an individual monthly cap for specific tools to show their own pie chart, or leave empty for unlimited.
                    </p>
                    <div className={styles.providerBudgetGrid}>
                      {PROVIDERS.map((provider) => {
                        const val = current.providerBudgets?.[provider.value] ?? null;
                        return (
                          <NumberField
                            key={provider.value}
                            label={`${provider.label} cap`}
                            value={val}
                            onChange={(value) => {
                              const nextBudgets = { ...(current.providerBudgets ?? {}) };
                              if (value === null || value <= 0) {
                                delete nextBudgets[provider.value];
                              } else {
                                nextBudgets[provider.value] = value;
                              }
                              edit({ ...current, providerBudgets: nextBudgets });
                            }}
                            min={0}
                            step={10}
                            prefix="$"
                            placeholder="Unlimited"
                            width={160}
                          />
                        );
                      })}
                    </div>
                  </fieldset>
                </div>
              </Section>

              <Section id="menubar" title="Menu bar" note="how monthly budget pie charts appear in the macOS widget">
                {(() => {
                  const menubar: MenubarSettings = {
                    ...defaultMenubarSettings(),
                    ...(current.menubar ?? {}),
                  };
                  const updateMenubar = (patch: Partial<MenubarSettings>) => {
                    commit({ ...current, menubar: { ...menubar, ...patch } }, 'Menu-bar preference saved');
                  };
                  const activeCounted = current.budgetProviders ?? [...ALL_PROVIDERS];
                  const sharedSlices = activeCounted.slice(0, 3).map((p, i, arr) => ({
                    color: PROVIDER_COLORS[p],
                    fraction: 0.62 / Math.max(1, arr.length) * (i === 0 ? 1.2 : 0.9),
                  }));
                  const perToolEntries = PROVIDERS.filter(
                    (p) => (current.providerBudgets?.[p.value] ?? 0) > 0,
                  );
                  const showSharedPreview = menubar.showBudgetPie && (current.monthlyBudgetUsd ?? 0) > 0;
                  const showToolPreviews = menubar.showProviderPies && perToolEntries.length > 0;
                  return (
                    <div className={`${styles.card} ${styles.stackFields}`}>
                      <div className={styles.menubarPreview} aria-label="Menu bar preview">
                        <span className="ui-xs muted-2">Preview</span>
                        <div className={styles.menubarPill}>
                          {showSharedPreview ? (
                            <MiniPiePreview slices={sharedSlices} size={16} />
                          ) : null}
                          {showToolPreviews
                            ? perToolEntries.map((p) => (
                                <MiniPiePreview
                                  key={p.value}
                                  slices={[{ color: PROVIDER_COLORS[p.value], fraction: 0.45 }]}
                                  size={16}
                                />
                              ))
                            : null}
                          {menubar.showTodayCost || (!showSharedPreview && !showToolPreviews) ? (
                            <span className={styles.menubarPreviewText}>$4.20 today</span>
                          ) : null}
                        </div>
                        {!showSharedPreview && !showToolPreviews ? (
                          <span className="ui-xs muted-2">Set a monthly budget above to show a pie chart.</span>
                        ) : null}
                      </div>
                      <Switch
                        checked={menubar.showBudgetPie}
                        onChange={(checked) => updateMenubar({ showBudgetPie: checked })}
                        label="Shared budget pie chart in menu bar"
                        description="Displays a small color-coded pie chart in the macOS menu bar showing how much of your shared budget has been used this month."
                      />
                      <Switch
                        checked={menubar.showProviderPies}
                        onChange={(checked) => updateMenubar({ showProviderPies: checked })}
                        label="Per-tool pie charts in menu bar"
                        description="Adds a small pie chart for each tool that has its own monthly cap set above."
                      />
                      <Switch
                        checked={menubar.showMenuPie}
                        onChange={(checked) => updateMenubar({ showMenuPie: checked })}
                        label="Budget pie chart in opened menu"
                        description="Displays an expanded pie chart with per-tool breakdown and forecast at the top of the widget menu."
                      />
                      <Switch
                        checked={menubar.showTodayCost}
                        onChange={(checked) => updateMenubar({ showTodayCost: checked })}
                        label="Today’s spend in menu bar"
                        description="Turn off to show only the pie chart(s) in the menu bar when a budget is active."
                      />
                    </div>
                  );
                })()}
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
