import { useEffect, useState } from 'react';

/**
 * Initial viewport hints for the session ledger. Page.tsx makes the final choice from measured
 * table space and actual column budgets, keeping the title and Cost visible beside the rail.
 *
 * `LedgerTable`'s own `secondary` flag drops a column under 900px, which is one step where this
 * table needs four: eleven columns of numerals need 1,122px of table beside a 264px rail, and a
 * phone has room for two. The thresholds below are the viewport widths at which each set stops
 * fitting, so the Cost column is never the one pushed off the right edge.
 *
 * - `full` — every column (from 1,440px)
 * - `rich` — without tool calls and agents (1,220–1,439px)
 * - `mid` — title, started, duration, requests, cost (701–1,219px)
 * - `narrow` — title and cost, with the rest folded into a meta line (up to 700px)
 */
export type LedgerWidth = 'narrow' | 'mid' | 'rich' | 'full';

const QUERIES: readonly (readonly [LedgerWidth, string])[] = [
  ['narrow', '(max-width: 700px)'],
  ['mid', '(max-width: 1219px)'],
  ['rich', '(max-width: 1439px)'],
];

export function useLedgerWidth(): LedgerWidth {
  // Starts at `full` and corrects itself in the first effect: a media query cannot be read
  // during render without making the first paint depend on the window.
  const [width, setWidth] = useState<LedgerWidth>('full');
  useEffect(() => {
    const lists = QUERIES.map(([name, query]) => [name, window.matchMedia(query)] as const);
    const update = (): void => setWidth(lists.find(([, list]) => list.matches)?.[0] ?? 'full');
    update();
    for (const [, list] of lists) list.addEventListener('change', update);
    return () => {
      for (const [, list] of lists) list.removeEventListener('change', update);
    };
  }, []);
  return width;
}
