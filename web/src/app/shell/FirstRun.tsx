import { Link } from '@/lib/navigation';
import { Button } from '@/components/Button';
import { Callout } from '@/components/Callout';
import { truncateMiddle } from '@/lib/format';
import { useReindex } from '@/lib/queries';
import styles from './FirstRun.module.css';

export interface FirstRunProps {
  /** `StatusResponse.roots` — the transcript directories the server actually resolved */
  roots: string[];
}

/** Long enough to recognise a path, short enough not to wrap on a 13" laptop. */
const ROOT_MAX_CHARS = 72;

/**
 * What every data page shows when the index is empty (SPEC §8.4: the app is useless without
 * transcripts, and each page saying "no rows match your filters" blamed the reader's filters for
 * a missing data directory). Settings, Methodology and the design gallery still render their own
 * page — those are the three that work with nothing indexed.
 */
export function FirstRun({ roots }: FirstRunProps) {
  const reindex = useReindex();

  return (
    <div className={`stack stack-lg ${styles.page}`}>
      <header className="stack stack-sm">
        <h1>No Claude Code or Codex transcripts found</h1>
        <p className="muted ui-sm">
          There is nothing indexed yet, so there is nothing to price. Every page here reads the same local files —
          none of them leaves this machine.
        </p>
      </header>

      <section className={styles.panel} aria-labelledby="first-run-roots">
        <h2 id="first-run-roots" className="eyebrow">
          Looked in
        </h2>
        {roots.length > 0 ? (
          <ul className={styles.roots}>
            {roots.map((root) => (
              <li key={root}>
                <code className={styles.root} title={root}>
                  {truncateMiddle(root, ROOT_MAX_CHARS)}
                </code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted ui-sm">The server has not reported a transcript root.</p>
        )}
        <p className="ui-sm">
          Claude Code writes one directory per project under <code>~/.claude/projects</code>, and one{' '}
          <code>.jsonl</code> file per session inside it. Codex writes rollout JSONL files under <code>~/.codex/sessions</code> and <code>~/.codex/archived_sessions</code>. A root with no session file indexes to nothing.
        </p>
        <div className="cluster">
          <Button
            variant="primary"
            onClick={() => reindex.mutate(true)}
            loading={reindex.isPending}
            disabled={reindex.isPending}
          >
            Re-index now
          </Button>
          <Link to="/settings#data">Settings › Data</Link>
          <Link to="/how-it-works">How it works</Link>
        </div>
        {reindex.isError ? (
          <Callout tone="warn" title="Could not start an index run">
            The local server refused the request. It may already be indexing.
          </Callout>
        ) : null}
      </section>

      <p className="muted-2 ui-xs">
        Run Claude Code or Codex once in any project, then re-index — a session appears as soon as its first request is
        written to disk.
      </p>
    </div>
  );
}
