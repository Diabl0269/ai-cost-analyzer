import { useMemo } from 'react';
import { Link } from '@/lib/navigation';
import type { IndexProgress } from '@core/types';
import { Tooltip } from '@/components/Tooltip';
import { formatCount, formatDate, formatPercent, truncateMiddle } from '@/lib/format';
import styles from './IndexStatusPill.module.css';

export interface IndexStatusPillProps {
  progress: IndexProgress | null;
  lastIndexedAt: string | null;
  connected: boolean;
  sessionCount?: number;
  /** indexed sessions the "hide scratch projects" setting is keeping out of the lists */
  scratchSessions?: number;
  error?: string | null;
  /** the transcript roots the server resolved (`StatusResponse.roots`) */
  roots?: string[];
  /** true once the first `/api/status` has answered; before that nothing is known */
  statusResolved?: boolean;
  /** indexed, not indexing, and no sessions at all */
  firstRun?: boolean;
}

/** How long a root may get in the tooltip before its middle is elided. */
const ROOT_MAX_CHARS = 52;

/**
 * How many sessions are indexed, and how many of them the scratch filter is hiding. Without the
 * second half the index count and every list on screen disagree with no explanation.
 */
function indexedPhrase(sessionCount: number | undefined, scratchSessions: number | undefined): string {
  if (sessionCount === undefined) return 'The index';
  const indexed = `${formatCount(sessionCount)} indexed`;
  if (!scratchSessions) return indexed;
  return `${indexed} · ${formatCount(scratchSessions)} scratch hidden (Settings › Appearance)`;
}

/**
 * The roots actually being watched, middle-truncated. The tooltip used to name
 * `~/.claude/projects` whatever the server had resolved, which is wrong the moment
 * `CCA_CLAUDE_DIR` or a second root is configured.
 */
function rootsPhrase(roots: string[] | undefined): string {
  if (!roots || roots.length === 0) return 'the configured transcript root';
  return roots.map((root) => truncateMiddle(root, ROOT_MAX_CHARS)).join(' · ');
}

/**
 * Live index state. The visible text counts files one by one; the announcement does not — a
 * polite region fed one message per file talks over everything else on the page for the whole
 * index. The screen-reader copy moves in tenths, so a full index is at most eleven sentences.
 */
export function IndexStatusPill({
  progress,
  lastIndexedAt,
  connected,
  sessionCount,
  scratchSessions,
  error,
  roots,
  statusResolved = true,
  firstRun = false,
}: IndexStatusPillProps) {
  const indexing = progress !== null && progress.phase !== 'done' && progress.phase !== 'error';
  const ratio = progress && progress.filesTotal > 0 ? progress.filesDone / progress.filesTotal : 0;

  const state = error
    ? 'error'
    : indexing
      ? 'indexing'
      : !statusResolved
        ? 'connecting'
        : firstRun
          ? 'empty'
          : connected
            ? 'ready'
            : 'offline';

  // "Offline" before the first `/api/status` has even answered is a false alarm: the app is
  // still booting, and the SSE stream has not had time to connect.
  const text = error
    ? 'Index error'
    : indexing
      ? `Indexing ${progress.filesDone}/${progress.filesTotal}`
      : !statusResolved
        ? 'Connecting…'
        : firstRun
          ? 'No transcripts found'
          : lastIndexedAt
            ? `Up to date · ${formatDate(lastIndexedAt, 'time')}`
            : connected
              ? 'Up to date'
              : 'Offline';

  const decile = indexing ? Math.floor(ratio * 10) : -1;
  const announcement = useMemo(() => {
    if (error) return 'Indexing failed.';
    if (decile >= 0) return `Indexing, ${decile * 10}% of files read.`;
    if (!statusResolved) return 'Connecting to the local server.';
    if (firstRun) return 'No Claude Code or Codex transcripts found.';
    return connected ? 'Index up to date.' : 'Not connected to the local server.';
  }, [error, decile, connected, statusResolved, firstRun]);

  // The visible text is about the *index*; the dot and the last sentence are about the *stream*.
  // Branching the tooltip on `connected` first used to contradict the pill beside it, which read
  // "Up to date · 12:02" while the tooltip said "Not connected — numbers may be stale".
  const detailText = error
    ? error
    : indexing
      ? `${progress.phase} phase, ${formatPercent(ratio)} of files${progress.currentProject ? ` · ${progress.currentProject}` : ''}`
      : !statusResolved
        ? 'Asking the local server for its index status…'
        : firstRun
          ? `No transcripts under ${rootsPhrase(roots)}. Change the root or re-index in Settings › Data.`
          : `${indexedPhrase(sessionCount, scratchSessions)} up to date${
              lastIndexedAt ? ` as of ${formatDate(lastIndexedAt, 'datetime')}` : ''
            }. ${
              connected
                ? `Watching ${rootsPhrase(roots)} for changes.`
                : 'Not connected to the local server, so live updates are paused.'
            }`;

  // The pill is the one place every reader looks when they wonder whether a number is current,
  // so it is also the right place to say where the answer is written down. The tooltip stays
  // open while the pointer is over it (WCAG 1.4.13), so the link is clickable; keyboard users
  // reach the same page from the rail or `g w`, which is why it is not in the tab order.
  const detail = (
    <>
      {detailText} See{' '}
      <Link to="/how-it-works" className={styles.tipLink} tabIndex={-1}>
        How it works
      </Link>{' '}
      for when the index updates.
    </>
  );

  return (
    <>
      <Tooltip content={detail} placement="bottom" maxWidth={360}>
        <span className={styles.pill} data-state={state} tabIndex={0}>
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.text}>{text}</span>
          {indexing ? (
            <span className={styles.track} aria-hidden="true">
              <span className={styles.fill} style={{ width: `${Math.round(ratio * 100)}%` }} />
            </span>
          ) : null}
        </span>
      </Tooltip>
      {/* Beside the pill rather than inside it, so focusing the pill reads the visible text
          once instead of reading it and then the coarser announcement after it. */}
      <span className="visually-hidden" role="status">
        {announcement}
      </span>
    </>
  );
}
