import { providerLabel } from '@/lib/provider';
import { Link } from '@/lib/navigation';
import type { SessionDetail } from '@core/types';
import { Button } from '@/components/Button';
import { Duration } from '@/components/Duration';
import { Icon } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';
import { Money } from '@/components/Money';
import { Tooltip } from '@/components/Tooltip';
import { useToast } from '@/components/Toast';
import { api } from '@/lib/api';
import { usePinSession } from '@/lib/queries';
import { formatDate } from '@/lib/format';
import type { WhatIfStore } from '@/lib/whatif';
import { ReportedBadge } from '@/routes/sessions/ReportedBadge';
import { TitleSourceHint, shortProjectPath } from '@/routes/sessions/meta';
import { markdownReceipt } from './receipt';
import { WhatIf } from './WhatIf';
import styles from './Header.module.css';

interface Fact {
  label: string;
  value: string;
}

function factsOf(detail: SessionDetail): Fact[] {
  const { summary } = detail;
  const facts: Fact[] = [{ label: 'Provider', value: providerLabel(summary.provider) }];
  if (summary.entrypoint) facts.push({ label: 'Entrypoint', value: summary.entrypoint });
  if (summary.sessionKind) facts.push({ label: 'Kind', value: summary.sessionKind });
  if (summary.gitBranch) facts.push({ label: 'Branch', value: summary.gitBranch });
  if (summary.version) facts.push({ label: providerLabel(summary.provider), value: summary.version });
  if (summary.effort) facts.push({ label: 'Effort', value: summary.effort });
  if (detail.facts.permissionMode) facts.push({ label: 'Permissions', value: detail.facts.permissionMode });
  return facts;
}

/** Unique PR links, newest first — a session often records the same PR a dozen times. */
function prLinks(detail: SessionDetail): SessionDetail['facts']['prLinks'] {
  const seen = new Map<string, SessionDetail['facts']['prLinks'][number]>();
  for (const link of detail.facts.prLinks) if (!seen.has(link.url)) seen.set(link.url, link);
  return [...seen.values()];
}

export interface SessionHeaderProps {
  detail: SessionDetail;
  whatIf: WhatIfStore;
}

export function SessionHeader({ detail, whatIf }: SessionHeaderProps) {
  const { summary } = detail;
  const pin = usePinSession();
  const { toast } = useToast();
  const facts = factsOf(detail);
  const prs = prLinks(detail);
  const chain = detail.facts.chain;
  const position = chain.findIndex((link) => link.sessionId === summary.id);
  const previous = position > 0 ? chain[position - 1] : undefined;
  const next = position >= 0 && position < chain.length - 1 ? chain[position + 1] : undefined;
  const chainTotal = chain.reduce((sum, link) => sum + link.cost, 0);

  const copyReceipt = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(markdownReceipt(detail));
      toast({ title: 'Receipt copied as Markdown', tone: 'save' });
    } catch {
      toast({ title: 'Could not reach the clipboard', description: 'Your browser blocked the copy.', tone: 'warn' });
    }
  };

  return (
    <header className={styles.head}>
      <div className={styles.titleRow}>
        <div className={styles.titleBlock}>
          <p className="eyebrow">Session</p>
          <h1 className={styles.title}>{summary.title}</h1>
          <p className={styles.subtitle}>
            <TitleSourceHint source={summary.titleSource} />
            <Link className={styles.projectLink} to={`/sessions?project=${encodeURIComponent(summary.projectId)}`} title={summary.projectPath}>
              <Icon name="sessions" size={12} /> {shortProjectPath(summary.projectPath, 3)}
            </Link>
            <span className={styles.id} title={summary.id}>
              {summary.provider === 'codex' ? summary.id.slice(-8) : summary.id.slice(0, 8)}
            </span>
          </p>
        </div>
        <div className={styles.actions} data-print-hide>
          <WhatIf whatIf={whatIf} models={detail.byModel} />
          <Button variant="secondary" size="sm" iconStart="copy" onClick={() => void copyReceipt()}>
            Copy receipt
          </Button>
          <a className={styles.download} href={api.sessionJsonHref(summary.id)} download>
            <Icon name="download" size={14} /> JSON
          </a>
          <IconButton
            icon="pin"
            active={summary.pinned}
            variant="outline"
            label={summary.pinned ? 'Unpin this session' : 'Pin this session'}
            onClick={() => pin.mutate(summary.id)}
          />
        </div>
      </div>

      {summary.provider === 'codex' ? <p className="ui-sm muted">Codex amounts are API-price estimates, not your subscription bill. Claude Code hook, skill and workflow attribution is unavailable in Codex rollouts.</p> : null}
      {summary.usageIncomplete ? <p className="ui-sm muted" role="note">Usage incomplete — totals cover recorded tokens only.</p> : null}
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>Ran</dt>
          <dd>
            <time dateTime={summary.startedAt}>{formatDate(summary.startedAt, 'datetime')}</time>
            {summary.endedAt ? <> → {formatDate(summary.endedAt, 'time')}</> : null}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>Elapsed</dt>
          <dd>
            <Duration ms={summary.durationMs} />
            {summary.activeMs > 0 ? <Tooltip content="Active time counts only the stretches with activity: idle gaps between turns are excluded.">
              <span className={styles.active}>
                active <Duration ms={summary.activeMs} />
              </span>
            </Tooltip> : null}
          </dd>
        </div>
        {facts.map((fact) => (
          <div key={fact.label} className={styles.fact}>
            <dt>{fact.label}</dt>
            <dd className={styles.factValue}>{fact.value}</dd>
          </div>
        ))}
        {summary.provider !== 'codex' ? <div className={styles.fact}>
          <dt>Claude Code’s tally</dt>
          <dd>
            <ReportedBadge status={summary.reportedStatus} comparison={detail.facts.reportedComparison} />
          </dd>
        </div> : null}
      </dl>

      {chain.length > 1 || prs.length > 0 ? (
        <div className={styles.links}>
          {chain.length > 1 ? (
            <span className={styles.chain}>
              <span className="eyebrow">Chain</span>
              {previous ? (
                <Link to={`/sessions/${encodeURIComponent(previous.sessionId)}`} className={styles.chainLink}>
                  ← previous <Money usd={previous.cost} />
                </Link>
              ) : null}
              <span className={styles.chainHere}>
                {position + 1} of {chain.length}
              </span>
              {next ? (
                <Link to={`/sessions/${encodeURIComponent(next.sessionId)}`} className={styles.chainLink}>
                  next <Money usd={next.cost} /> →
                </Link>
              ) : null}
              <span className={styles.chainTotal}>
                chain total <Money usd={chainTotal} />
              </span>
            </span>
          ) : null}
          {prs.length > 0 ? (
            <span className={styles.prs}>
              <span className="eyebrow">Pull requests</span>
              {prs.map((link) => (
                <a key={link.url} href={link.url} className={styles.pr} target="_blank" rel="noreferrer noopener">
                  <Icon name="external" size={11} />
                  {link.repository ? `${link.repository}#${link.number ?? '?'}` : link.url}
                </a>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
