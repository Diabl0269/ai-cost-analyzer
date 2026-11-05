import { useState } from 'react';
import { Button, Callout, Dialog, RelativeTime, Skeleton, useToast } from '@/components';
import { Link } from '@/lib/navigation';
import { plural } from '@core/pricing/format';
import { formatCount, formatDate } from '@/lib/format';
import { QueryError, Section } from '@/lib/page';
import { useReindex, useStatus } from '@/lib/queries';
import styles from '../Settings.module.css';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3));
  const value = bytes / 1000 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

/**
 * Index maintenance. Progress comes from `GET /api/status`, which polls every two seconds while
 * a run is in flight — the shell already owns the single SSE subscription, and a second one
 * would open a second stream for the same events.
 */
export function DataSection() {
  const status = useStatus();
  const reindex = useReindex();
  const { toast } = useToast();
  const [rebuildOpen, setRebuildOpen] = useState(false);

  const data = status.data;
  const progress = data?.progress ?? null;
  const indexing = data?.indexing ?? false;
  const done = progress ? progress.filesDone : 0;
  const totalFiles = progress ? progress.filesTotal : 0;
  const fraction = totalFiles > 0 ? Math.min(1, done / totalFiles) : 0;

  const run = (full: boolean): void =>
    reindex.mutate(full, {
      onSuccess: () =>
        toast({
          title: full ? 'Rebuilding the index' : 'Re-indexing',
          description: full ? 'The database is dropped and rebuilt from the transcripts.' : 'Only files that changed are re-read.',
          tone: 'info',
        }),
      onError: () => toast({ title: 'Could not start indexing', tone: 'cost' }),
    });

  return (
    <Section id="data" title="Data" note="where the transcripts come from and how the index is built">
      {status.isError ? <QueryError error={status.error} what="the index status" onRetry={() => void status.refetch()} /> : null}
      {status.isPending ? <Skeleton height={180} label="Loading index status" /> : null}

      {data ? (
        <div className="stack">
          <div className={styles.card}>
            <h3>Transcript roots</h3>
            <p className="ui-xs muted-2">
              What is actually being indexed right now. Claude Code roots can be overridden with <code>--claude-dir</code> or <code>CCA_CLAUDE_DIR</code>; Codex roots with <code>--codex-dir</code> or <code>CCA_CODEX_DIR</code>; Copilot roots with <code>--copilot-dir</code> or <code>CCA_COPILOT_DIR</code>. These override
              the configured roots, which is why this list is shown rather than edited here; change it in{' '}
              <code>~/.claude-cost-analyzer/config.json</code> or on the command line.
            </p>
            <ul className={styles.rootList} style={{ marginTop: 'var(--s2)' }}>
              {data.roots.map((root) => (
                <li key={root} className={styles.root}>
                  {root}
                </li>
              ))}
            </ul>
          </div>

          <div className={styles.card}>
            <div className="cluster cluster-between">
              <h3>Index</h3>
              <div className="cluster">
                <Button variant="secondary" size="sm" disabled={indexing || reindex.isPending} onClick={() => run(false)}>
                  Re-index changed files
                </Button>
                <Button variant="danger" size="sm" disabled={indexing || reindex.isPending} onClick={() => setRebuildOpen(true)}>
                  Rebuild from scratch
                </Button>
              </div>
            </div>

            {/* A progress bar, not a live region: the top bar's status pill already narrates the
                index, and a region fed one message per file drowns out everything else. */}
            {indexing && progress ? (
              <div className="stack stack-sm" style={{ marginTop: 'var(--s3)' }}>
                <div
                  className={styles.progressTrack}
                  role="progressbar"
                  aria-label="Indexing progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(fraction * 100)}
                >
                  <div className={styles.progressFill} style={{ width: `${fraction * 100}%` }} />
                </div>
                <p className="ui-xs muted">
                  {progress.phase} · {formatCount(done)} of {plural(totalFiles, 'file')}
                  {progress.currentProject ? ` · ${progress.currentProject}` : ''}
                </p>
              </div>
            ) : null}

            <div className={styles.meta} style={{ marginTop: 'var(--s3)' }}>
              <span className={styles.metaLabel}>Database</span>
              <span className={styles.metaValue}>{data.dbPath}</span>
              <span className={styles.metaLabel}>Size</span>
              <span className={styles.metaValue}>{formatBytes(data.dbBytes)}</span>
              <span className={styles.metaLabel}>Last indexed</span>
              <span className={styles.metaValue}>
                {data.lastIndexedAt ? (
                  <>
                    <RelativeTime value={data.lastIndexedAt} /> · {formatDate(data.lastIndexedAt, 'datetime')}
                  </>
                ) : (
                  'never'
                )}
              </span>
              <span className={styles.metaLabel}>Indexed</span>
              <span className={styles.metaValue}>
                {plural(data.counts.sessions, 'session')} · {plural(data.counts.requests, 'request')} ·{' '}
                {plural(data.counts.agents, 'agent')} · {plural(data.counts.messages, 'message')}
              </span>
              {data.scratchSessions ? (
                <>
                  <span className={styles.metaLabel}>Hidden</span>
                  <span className={styles.metaValue}>
                    {plural(data.scratchSessions, 'of those sessions sits', 'of those sessions sit')} in a scratch project
                    and {data.scratchSessions === 1 ? 'is' : 'are'} kept out of every list and total by{' '}
                    <Link to="/settings#appearance">Hide scratch projects</Link>. They are still indexed, so turning the
                    setting off costs nothing.
                  </span>
                </>
              ) : null}
              {/* `0.0.0` is the placeholder a build that never got its version stamped reports;
                  a version row that says nothing is worse than no version row. */}
              {data.version && data.version !== '0.0.0' ? (
                <>
                  <span className={styles.metaLabel}>Version</span>
                  <span className={styles.metaValue}>{data.version}</span>
                </>
              ) : null}
            </div>
          </div>

          <Callout tone="info" title="The index is a cache">
            Nothing here is your data: the database is rebuilt from the JSONL transcripts on disk, and deleting it costs
            you only the time to read them again.
          </Callout>
        </div>
      ) : null}

      <Dialog
        open={rebuildOpen}
        onClose={() => setRebuildOpen(false)}
        title="Rebuild the index from scratch?"
        description="The database is deleted and every transcript is parsed again. No Claude Code or Codex source files are touched, but the app will be re-reading files for a while."
        alert
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRebuildOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={reindex.isPending}
              onClick={() => {
                run(true);
                setRebuildOpen(false);
              }}
            >
              Rebuild
            </Button>
          </>
        }
      >
        <p className="ui-sm muted">Use this after changing a parser or when a session looks wrong; the incremental re-index is enough for new work.</p>
      </Dialog>
    </Section>
  );
}
