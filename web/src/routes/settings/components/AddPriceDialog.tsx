import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelFamily, ModelPrice } from '@core/types';
import { Button, Dialog, NumberField, Select } from '@/components';
import styles from '../Settings.module.css';

const FAMILIES: ModelFamily[] = ['opus', 'sonnet', 'haiku', 'fable', 'mythos', 'synthetic', 'other'];

/** `claude-opus-5[1m]@20260101` → `claude-opus-5`, the shape the matcher compares against. */
export function normalizeModelId(model: string): string {
  return model.toLowerCase().replace(/\[1m\]/g, '').replace(/@.*$/, '').trim();
}

/** Best guess at the family from the id, so the colour is usually right without asking. */
export function guessFamily(model: string): ModelFamily {
  const id = normalizeModelId(model);
  if (id === '<synthetic>') return 'synthetic';
  for (const family of ['opus', 'sonnet', 'haiku', 'fable', 'mythos'] as const) {
    if (id.includes(family)) return family;
  }
  return 'other';
}

function suggestKey(model: string, taken: ReadonlySet<string>): string {
  const base = normalizeModelId(model).replace(/^claude-/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom';
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
  }
  return `${base}-${Date.now()}`;
}

export interface AddPriceDialogProps {
  /** raw model id from `/api/status`; `null` closes the dialog */
  model: string | null;
  existingKeys: ReadonlySet<string>;
  onClose: () => void;
  onAdd: (price: ModelPrice) => void;
  /** priced rows an unknown model may be estimated as; enables the "Estimate as…" option */
  targets?: readonly ModelPrice[];
  /** records `estimateAs[modelId] = targetKey`; the model itself stays unpriced */
  onEstimate?: (modelId: string, targetKey: string) => void;
}

/**
 * Adds a price row for a model the table cannot match. The match prefix is prefilled from the
 * id the indexer actually saw, so saving once is enough to price every request that used it.
 */
export function AddPriceDialog({ model, existingKeys, onClose, onAdd, targets = [], onEstimate }: AddPriceDialogProps) {
  const [estimating, setEstimating] = useState(false);
  const [targetKey, setTargetKey] = useState('');
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [match, setMatch] = useState('');
  const [family, setFamily] = useState<ModelFamily>('other');
  const [input, setInput] = useState<number | null>(0);
  const [output, setOutput] = useState<number | null>(0);
  const [cacheWrite5m, setCacheWrite5m] = useState<number | null>(0);
  const [cacheWrite1h, setCacheWrite1h] = useState<number | null>(0);
  const [cacheRead, setCacheRead] = useState<number | null>(0);
  const [charsPerToken, setCharsPerToken] = useState<number | null>(3.1);

  useEffect(() => {
    if (!model) return;
    setEstimating(false);
    setTargetKey(targets[0]?.key ?? '');
    const normalized = normalizeModelId(model);
    setKey(suggestKey(model, existingKeys));
    setLabel(normalized);
    setMatch(normalized);
    setFamily(guessFamily(model));
    setInput(0);
    setOutput(0);
    setCacheWrite5m(0);
    setCacheWrite1h(0);
    setCacheRead(0);
    setCharsPerToken(3.1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, existingKeys]);

  const problem = useMemo(() => {
    if (!key.trim()) return 'A key is required.';
    if (existingKeys.has(key.trim())) return 'That key is already used by another row.';
    if (!label.trim()) return 'A label is required.';
    if (!match.trim()) return 'At least one match prefix is required.';
    if (charsPerToken === null || charsPerToken <= 0) return 'Characters per token must be greater than zero.';
    return null;
  }, [key, label, match, charsPerToken, existingKeys]);

  const submitEstimate = (): void => {
    if (!model || !targetKey || !onEstimate) return;
    onEstimate(normalizeModelId(model), targetKey);
    onClose();
  };

  const submit = (): void => {
    if (estimating) return submitEstimate();
    if (problem) return;
    onAdd({
      key: key.trim(),
      label: label.trim(),
      match: match
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
      input: input ?? 0,
      output: output ?? 0,
      cacheWrite5m: cacheWrite5m ?? 0,
      cacheWrite1h: cacheWrite1h ?? 0,
      cacheRead: cacheRead ?? 0,
      supportsUsGeo: false,
      charsPerToken: charsPerToken ?? 3.1,
      family,
      custom: true,
    });
    onClose();
  };

  return (
    <Dialog
      open={model !== null}
      onClose={onClose}
      title={estimating ? 'Estimate as another model' : 'Add a price'}
      description={model && estimating ? `${model} stays unpriced. Its tokens are costed at the chosen model's list prices as a separate, labeled estimate that never joins recorded cost.` : model ? `Prices are USD per million tokens. Requests billed as ${model} will use this row once you save.` : undefined}
      size="lg"
      initialFocusRef={firstFieldRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {onEstimate && targets.length > 0 ? (
            <Button variant="secondary" onClick={() => setEstimating((value) => !value)}>
              {estimating ? 'Add a price instead' : 'Estimate as…'}
            </Button>
          ) : null}
          <Button variant="primary" onClick={submit} disabled={estimating ? !targetKey : problem !== null}>
            {estimating ? 'Save estimate' : 'Add to the table'}
          </Button>
        </>
      }
    >
      {estimating ? (
        <div className={styles.dialogFields}>
          <Select
            label="Bill as"
            value={targetKey}
            onChange={setTargetKey}
            options={targets.map((entry) => ({ value: entry.key, label: entry.label }))}
          />
        </div>
      ) : (
      <div className={styles.dialogFields}>
        <label className={styles.textField}>
          <span className={styles.textLabel}>Label</span>
          <input ref={firstFieldRef} className={styles.textInput} value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label className={styles.textField}>
          <span className={styles.textLabel}>Key</span>
          <input className={styles.textInput} value={key} onChange={(event) => setKey(event.target.value)} />
        </label>
        <label className={`${styles.textField} ${styles.dialogWide}`}>
          <span className={styles.textLabel}>Match prefixes (comma separated)</span>
          <input className={styles.textInput} value={match} onChange={(event) => setMatch(event.target.value)} />
        </label>
        <Select
          label="Family"
          value={family}
          onChange={(value) => setFamily(value as ModelFamily)}
          options={FAMILIES.map((entry) => ({ value: entry, label: entry }))}
        />
        <NumberField label="Chars per token" value={charsPerToken} onChange={setCharsPerToken} min={0.5} step={0.1} />
        <NumberField label="Input" value={input} onChange={setInput} min={0} step={0.1} prefix="$" suffix="/ MTok" />
        <NumberField label="Output" value={output} onChange={setOutput} min={0} step={0.1} prefix="$" suffix="/ MTok" />
        <NumberField label="Cache write 5m" value={cacheWrite5m} onChange={setCacheWrite5m} min={0} step={0.1} prefix="$" />
        <NumberField label="Cache write 1h" value={cacheWrite1h} onChange={setCacheWrite1h} min={0} step={0.1} prefix="$" />
        <NumberField label="Cache read" value={cacheRead} onChange={setCacheRead} min={0} step={0.01} prefix="$" />
      </div>
      )}
      {problem && !estimating ? (
        <p role="status" className="ui-xs" style={{ color: 'var(--cost)', marginTop: 'var(--s3)' }}>
          {problem}
        </p>
      ) : null}
    </Dialog>
  );
}
