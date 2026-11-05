import { useLocation } from 'react-router';
import { Link } from '@/lib/navigation';
import type { IndexProgress } from '@core/types';
import { IconButton } from '@/components/IconButton';
import { DateRange } from '@/components/DateRange';
import { Select } from '@/components/Select';
import { useDateRange } from '@/lib/range';
import { GlobalSearch } from './GlobalSearch';
import { ThemeToggle } from './ThemeToggle';
import { IndexStatusPill } from './IndexStatusPill';
import { useMediaQuery } from '@/lib/media';
import styles from './TopBar.module.css';

export interface TopBarProps {
  onToggleRail: () => void;
  railExpanded: boolean;
  progress: IndexProgress | null;
  lastIndexedAt: string | null;
  connected: boolean;
  sessionCount?: number;
  /** indexed sessions currently hidden by the "hide scratch projects" setting */
  scratchSessions?: number;
  indexError?: string | null;
  /** the transcript roots the server resolved, for the status tooltip */
  roots?: string[];
  /** true once the first `/api/status` has answered */
  statusResolved?: boolean;
  /** indexed, not indexing, and no sessions at all: there is nothing to filter yet */
  firstRun?: boolean;
}

/** The width at which the full preset row + both bounds stop fitting beside search and status. */
const COMPACT_RANGE = '(max-width: 1180px)';
/** Under this the bar keeps only the wordmark, status and theme; the rail carries the range. */
const NO_RANGE = '(max-width: 720px)';

/** 48px bar: wordmark, search, range, theme, index status. */
export function TopBar({
  onToggleRail,
  railExpanded,
  progress,
  lastIndexedAt,
  connected,
  sessionCount,
  scratchSessions,
  indexError,
  roots,
  statusResolved,
  firstRun,
}: TopBarProps) {
  const range = useDateRange();
  const location = useLocation();
  const compactRange = useMediaQuery(COMPACT_RANGE);
  const noRange = useMediaQuery(NO_RANGE);
  // The search page owns a richer field of its own (scope, filters, tool name). Two search
  // boxes on one screen is one too many; `/` and ⌘K still reach the page's field.
  const onSearchPage = location.pathname === '/search';

  return (
    <header className={styles.bar} data-app-bar>
      <div className={styles.left}>
        <IconButton
          icon="menu"
          label={railExpanded ? 'Hide navigation' : 'Show navigation'}
          className={styles.railToggle}
          data-rail-toggle
          onClick={onToggleRail}
          aria-expanded={railExpanded}
        />
        <Link to="/" className={styles.wordmark}>
          AI Cost Analyzer
        </Link>
      </div>
      <div className={styles.centre}>
        {/* Nothing indexed means nothing to search, so the field steps aside on a first run too. */}
        <GlobalSearch hideField={onSearchPage || Boolean(firstRun)} />
      </div>
      <div className={styles.right}>
        <Select className={styles.provider} label="Provider" hideLabel value={range.provider ?? ''}
          onChange={(value) => range.setProvider(value === 'claude' || value === 'codex' ? value : undefined)}
          options={[{ value: '', label: 'All providers' }, { value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }]} />
        {/* Below 720px this moves into the rail: see `LeftRail`'s range slot. */}
        {noRange || firstRun ? null : (
          <div className={styles.range}>
            <DateRange value={range.value} onPreset={range.setPreset} onBounds={range.setBounds} compact={compactRange} />
          </div>
        )}
        <IndexStatusPill
          progress={progress}
          lastIndexedAt={lastIndexedAt}
          connected={connected}
          sessionCount={sessionCount}
          scratchSessions={scratchSessions}
          error={indexError ?? null}
          roots={roots}
          statusResolved={statusResolved}
          firstRun={firstRun}
        />
        <ThemeToggle />
      </div>
    </header>
  );
}
