import { useCallback, useMemo, useState } from 'react';
import type { ModelPrice, PricingConfig, TokenPrices } from '@core/types';
import { pricingConfigSchema } from '@core/pricing/schema';
import { plural } from '@core/pricing/format';
import {
  Button,
  Callout,
  Dialog,
  IconButton,
  LedgerTable,
  ModelChip,
  NumberField,
  Select,
  Skeleton,
  useToast,
  type LedgerColumn,
  type LedgerColumnGroup,
} from '@/components';
import { formatDate } from '@/lib/format';
import { QueryError, Section } from '@/lib/page';
import { usePricing, useResetPricing, useStatus, useUpdatePricing } from '@/lib/queries';
import { isSyntheticPriceRow } from '@/lib/tools';
import { AddPriceDialog } from './AddPriceDialog';
import styles from '../Settings.module.css';

type PriceField = 'input' | 'output' | 'cacheWrite5m' | 'cacheWrite1h' | 'cacheRead';

/**
 * One row of the editor. The index is the row's position in the *stored* table, which is what
 * the zod issue paths (`models.3.input`) and every patch are keyed by — the sentinel row is
 * filtered out of the view, so the rendered order and the stored order are not the same list.
 */
interface PriceRow {
  model: ModelPrice;
  index: number;
}

/**
 * Visible header, and the long form used for the input's accessible name. The section already
 * says "USD per million tokens", so the unit is not repeated in eight columns — but it stays in
 * the accessible name, which is the only label a screen reader reads for the cell.
 *
 * Widths are pixels, not percentages: a price is four or five characters and needs exactly that
 * much room, and the two spanning group labels above make percentage columns give up their space
 * to whichever one is widest — which is how `18.75` came to render as `18.`.
 */
const PRICE_COLUMNS: { field: PriceField; header: string; width: string; title: string }[] = [
  { field: 'input', header: 'Input', width: '64px', title: 'Input tokens, USD per million' },
  { field: 'output', header: 'Output', width: '64px', title: 'Output tokens, USD per million' },
  { field: 'cacheWrite5m', header: '5 min', width: '64px', title: '5-minute cache write, USD per million' },
  { field: 'cacheWrite1h', header: '1 hour', width: '64px', title: '1-hour cache write, USD per million' },
  { field: 'cacheRead', header: 'Cache read', width: '76px', title: 'Cache read, USD per million' },
];

/** Spanning labels: the two cache-write TTLs and the two fast-mode prices are each one idea. */
const COLUMN_GROUPS: LedgerColumnGroup[] = [
  { id: 'cacheWrite', label: 'Cache write', columns: ['cacheWrite5m', 'cacheWrite1h'] },
  { id: 'fast', label: 'Fast mode', columns: ['fastInput', 'fastOutput'] },
];

/** `models.3.input` → the message zod produced for that exact cell. */
function issueMap(config: PricingConfig): Map<string, string> {
  const result = pricingConfigSchema.safeParse(config);
  const map = new Map<string, string>();
  if (result.success) return map;
  for (const issue of result.error.issues) {
    map.set(issue.path.join('.'), issue.message);
  }
  return map;
}

function standardPrices(model: ModelPrice): TokenPrices {
  return {
    input: model.input,
    output: model.output,
    cacheWrite5m: model.cacheWrite5m,
    cacheWrite1h: model.cacheWrite1h,
    cacheRead: model.cacheRead,
  };
}

/**
 * The editable pricing table. Everything is edited against a local draft and validated with the
 * same zod schema the server uses, so an invalid table cannot even be sent.
 */
export function PricingSection() {
  const pricing = usePricing();
  const status = useStatus();
  const update = useUpdatePricing();
  const reset = useResetPricing();
  const { toast } = useToast();

  const [draft, setDraft] = useState<PricingConfig | null>(null);
  // Raw text per cell while it is being typed, so clearing a field does not snap it to 0.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [resetOpen, setResetOpen] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  const config = draft ?? pricing.data ?? null;
  const dirty = draft !== null && pricing.data !== undefined && JSON.stringify(draft) !== JSON.stringify(pricing.data);
  const issues = useMemo(() => (config ? issueMap(config) : new Map<string, string>()), [config]);
  const existingKeys = useMemo(() => new Set((config?.models ?? []).map((model) => model.key)), [config]);

  // `<synthetic>` is a sentinel the pricer matches internally, priced at zero by definition.
  // A row of zeros labelled "(synthetic)" in a price editor is an invitation to edit something
  // that means nothing, so it is not shown.
  const rows = useMemo<PriceRow[]>(
    () => (config?.models ?? []).map((model, index) => ({ model, index })).filter((row) => !isSyntheticPriceRow(row.model)),
    [config],
  );

  const patchModel = useCallback(
    (index: number, patch: Partial<ModelPrice>) => {
      setDraft((current) => {
        const base = current ?? pricing.data;
        if (!base) return current;
        const models = base.models.map((model, position) => (position === index ? { ...model, ...patch } : model));
        return { ...base, models };
      });
    },
    [pricing.data],
  );

  const patchConfig = useCallback(
    (patch: Partial<PricingConfig>) => {
      setDraft((current) => {
        const base = current ?? pricing.data;
        return base ? { ...base, ...patch } : current;
      });
    },
    [pricing.data],
  );

  const cellValue = (cellKey: string, value: number | undefined): string =>
    edits[cellKey] ?? (value === undefined ? '' : String(value));

  const onCellChange = (cellKey: string, raw: string, apply: (parsed: number | null) => void): void => {
    setEdits((current) => ({ ...current, [cellKey]: raw }));
    if (raw.trim() === '') {
      apply(null);
      return;
    }
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) apply(parsed);
  };

  const clearEdit = (cellKey: string): void =>
    setEdits((current) => {
      if (!(cellKey in current)) return current;
      const next = { ...current };
      delete next[cellKey];
      return next;
    });

  const save = (): void => {
    if (!config || issues.size > 0) return;
    update.mutate(
      { ...config, updatedAt: new Date().toISOString() },
      {
        onSuccess: () => {
          setDraft(null);
          setEdits({});
          toast({ title: 'Pricing saved', description: 'Every figure in the app was recalculated.', tone: 'save' });
        },
        onError: () => toast({ title: 'Could not save the pricing table', tone: 'cost' }),
      },
    );
  };

  const columns = useMemo<LedgerColumn<PriceRow>[]>(() => {
    const numberCell = (
      model: ModelPrice,
      index: number,
      field: string,
      value: number | undefined,
      label: string,
      apply: (parsed: number | null) => void,
      step = 0.1,
    ) => {
      const cellKey = `models.${index}.${field}`;
      const invalid = issues.has(cellKey);
      return (
        <input
          type="number"
          className={[styles.cellInput, invalid ? styles.cellInvalid : null].filter(Boolean).join(' ')}
          value={cellValue(cellKey, value)}
          min={0}
          step={step}
          placeholder="—"
          aria-label={`${label} for ${model.label}`}
          aria-invalid={invalid || undefined}
          onChange={(event) => onCellChange(cellKey, event.target.value, apply)}
          onBlur={() => clearEdit(cellKey)}
        />
      );
    };

    return [
      {
        id: 'label',
        header: 'Model',
        width: '176px',
        cell: ({ model, index }) => (
          <span className="cluster" style={{ gap: 'var(--s2)', flexWrap: 'nowrap' }}>
            <ModelChip model={model.key} family={model.family} glyphOnly />
            <input
              className={[styles.cellInput, styles.cellText, issues.has(`models.${index}.label`) ? styles.cellInvalid : null]
                .filter(Boolean)
                .join(' ')}
              value={model.label}
              aria-label={`Label for ${model.key}`}
              onChange={(event) => patchModel(index, { label: event.target.value })}
            />
          </span>
        ),
      },
      {
        id: 'match',
        header: 'Model id prefixes',
        width: '196px',
        headerTitle: 'Model ids starting with one of these use this row; the longest match wins',
        cell: ({ model, index }) => (
          <input
            className={[
              styles.cellInput,
              styles.cellText,
              styles.monoCell,
              issues.has(`models.${index}.match`) ? styles.cellInvalid : null,
            ]
              .filter(Boolean)
              .join(' ')}
            value={model.match.join(', ')}
            title={model.match.join(', ')}
            aria-label={`Match prefixes for ${model.label}`}
            onChange={(event) =>
              patchModel(index, {
                match: event.target.value
                  .split(',')
                  .map((entry) => entry.trim())
                  .filter(Boolean),
              })
            }
          />
        ),
      },
      ...PRICE_COLUMNS.map<LedgerColumn<PriceRow>>((column) => ({
        id: column.field,
        header: column.header,
        headerTitle: column.title,
        numeric: true,
        width: column.width,
        cell: ({ model, index }) =>
          numberCell(model, index, column.field, model[column.field], column.title, (parsed) =>
            patchModel(index, { [column.field]: parsed ?? 0 } as Partial<ModelPrice>),
          ),
      })),
      {
        id: 'fastInput',
        header: 'Input',
        headerTitle: 'Fast-mode input price; blank means this model has no fast tier',
        numeric: true,
        width: '64px',
        cell: ({ model, index }) =>
          numberCell(model, index, 'fast.input', model.fast?.input, 'Fast input price', (parsed) =>
            patchModel(index, {
              fast:
                parsed === null && model.fast?.output === undefined
                  ? undefined
                  : { ...(model.fast ?? standardPrices(model)), input: parsed ?? 0 },
            }),
          ),
      },
      {
        id: 'fastOutput',
        header: 'Output',
        headerTitle: 'Fast-mode output price; blank means this model has no fast tier',
        numeric: true,
        width: '64px',
        cell: ({ model, index }) =>
          numberCell(model, index, 'fast.output', model.fast?.output, 'Fast output price', (parsed) =>
            patchModel(index, {
              fast:
                parsed === null && model.fast?.input === undefined
                  ? undefined
                  : { ...(model.fast ?? standardPrices(model)), output: parsed ?? 0 },
            }),
          ),
      },
      {
        id: 'charsPerToken',
        // Two lines: on one it is the widest header in the table, and it would take that width
        // out of the two columns whose values actually need it.
        header: (
          <>
            Chars /<br />
            token
          </>
        ),
        headerTitle: 'Characters per token for this tokenizer generation; used by the attribution estimates',
        numeric: true,
        width: '64px',
        cell: ({ model, index }) =>
          numberCell(
            model,
            index,
            'charsPerToken',
            model.charsPerToken,
            'Characters per token',
            (parsed) => patchModel(index, { charsPerToken: parsed ?? 1 }),
            0.1,
          ),
      },
      {
        id: 'remove',
        header: '',
        width: '32px',
        cell: ({ model, index }) =>
          model.custom ? (
            <IconButton
              icon="close"
              size="sm"
              label={`Remove ${model.label}`}
              onClick={() =>
                setDraft((current) => {
                  const base = current ?? pricing.data;
                  return base ? { ...base, models: base.models.filter((_, position) => position !== index) } : current;
                })
              }
            />
          ) : null,
      },
    ];
  }, [issues, patchModel, edits, pricing.data]);

  const unpriced = status.data?.unpricedModels ?? [];
  const problems = [...issues.entries()];

  return (
    <Section
      id="pricing"
      title="Pricing"
      note="USD per million tokens, except characters per token"
      actions={
        <>
          <Button variant="secondary" size="sm" onClick={() => setResetOpen(true)} disabled={reset.isPending}>
            Reset to defaults
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            disabled={!dirty || problems.length > 0}
            loading={update.isPending}
            title={problems.length > 0 ? 'Fix the highlighted prices first' : dirty ? undefined : 'No price has been edited yet'}
          >
            Save pricing
          </Button>
        </>
      }
    >
      {pricing.isError ? <QueryError error={pricing.error} what="the pricing table" onRetry={() => void pricing.refetch()} /> : null}
      {pricing.isPending ? <Skeleton height={260} label="Loading the pricing table" /> : null}

      {config ? (
        <div className="stack">
          {unpriced.length > 0 ? (
            <Callout tone="warn" title={`${plural(unpriced.length, 'model')} in the index ${unpriced.length === 1 ? 'has' : 'have'} no price`}>
              <span className={styles.unpricedList}>
                {unpriced.map((model) => (
                  <span key={model} className={styles.unpricedItem}>
                    {model}
                    <Button variant="ghost" size="sm" onClick={() => setAdding(model)}>
                      Add price
                    </Button>
                  </span>
                ))}
              </span>
            </Callout>
          ) : null}

          {problems.length > 0 ? (
            <Callout tone="cost" title="Fix these before saving">
              <ul>
                {problems.slice(0, 6).map(([path, message]) => (
                  <li key={path}>
                    <code>{path}</code> — {message}
                  </li>
                ))}
              </ul>
            </Callout>
          ) : null}

          <LedgerTable
            columns={columns}
            columnGroups={COLUMN_GROUPS}
            rows={rows}
            rowKey={({ model }) => model.key}
            caption="Editable model prices, USD per million tokens"
            rowHeight={40}
            // Dense: the horizontal padding of a normal ledger cell is room a price input needs.
            dense
            // A form grid, not a ledger: every cell is an input, so the tab order is the point.
            rowTabStops="natural"
            empty="No model prices configured."
          />

          <div className={styles.fields}>
            <NumberField
              label="Web search"
              value={config.webSearchPer1000}
              onChange={(value) => patchConfig({ webSearchPer1000: value ?? 0 })}
              min={0}
              step={1}
              prefix="$"
              suffix="/ 1,000 searches"
              width={220}
            />
            <Select
              label="Unknown model"
              value={config.unknownModelPolicy}
              onChange={(value) => patchConfig({ unknownModelPolicy: value === 'fallbackModel' ? 'fallbackModel' : 'zero' })}
              options={[
                { value: 'zero', label: 'Count tokens, charge nothing' },
                { value: 'fallbackModel', label: 'Price as another model' },
              ]}
            />
            {config.unknownModelPolicy === 'fallbackModel' ? (
              <Select
                label="Fallback model"
                value={config.fallbackModelKey ?? ''}
                onChange={(value) => patchConfig({ fallbackModelKey: value })}
                options={[{ value: '', label: 'Choose a model' }, ...config.models.map((model) => ({ value: model.key, label: model.label }))]}
              />
            ) : null}
            <Select
              label="Cache write with no TTL"
              value={config.assumeCacheWriteTtlWhenUnknown}
              onChange={(value) => patchConfig({ assumeCacheWriteTtlWhenUnknown: value === '1h' ? '1h' : '5m' })}
              options={[
                { value: '5m', label: 'Assume 5 minutes' },
                { value: '1h', label: 'Assume 1 hour' },
              ]}
            />
          </div>

          <p className="ui-xs muted-2">
            Source: {config.source || 'unknown'} · last updated {formatDate(config.updatedAt, 'datetime')}
            {dirty ? ' · unsaved changes' : ''}
          </p>
        </div>
      ) : null}

      <AddPriceDialog
        model={adding}
        existingKeys={existingKeys}
        targets={config?.models.filter((m) => !m.custom && !m.retired) ?? []}
        onEstimate={(modelId, targetKey) =>
          setDraft((current) => {
            const base = current ?? pricing.data;
            return base ? { ...base, estimateAs: { ...base.estimateAs, [modelId]: targetKey } } : current;
          })
        }
        onClose={() => setAdding(null)}
        onAdd={(price) =>
          setDraft((current) => {
            const base = current ?? pricing.data;
            return base ? { ...base, models: [...base.models, price] } : current;
          })
        }
      />

      <Dialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset the pricing table?"
        description="Every custom row and every edited price is replaced by the list prices this build ships with. Your sessions are not touched — only the money is recomputed."
        alert
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetOpen(false)}>
              Keep my prices
            </Button>
            <Button
              variant="danger"
              loading={reset.isPending}
              onClick={() =>
                reset.mutate(undefined, {
                  onSuccess: () => {
                    setDraft(null);
                    setEdits({});
                    setResetOpen(false);
                    toast({ title: 'Pricing reset to defaults', tone: 'info' });
                  },
                  onError: () => toast({ title: 'Could not reset the pricing table', tone: 'cost' }),
                })
              }
            >
              Reset to defaults
            </Button>
          </>
        }
      >
        <p className="ui-sm muted">This cannot be undone.</p>
      </Dialog>
    </Section>
  );
}
