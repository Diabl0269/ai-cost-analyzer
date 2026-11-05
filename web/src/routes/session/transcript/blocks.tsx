import { Link } from '@/lib/navigation';
import { plural } from '@core/pricing/format.js';
import type { RequestCost, ToolCallCost } from '@core/types';
import { EstimateBadge } from '@/components/EstimateBadge';
import { Icon } from '@/components/Icon';
import { ModelChip } from '@/components/ModelChip';
import { Money } from '@/components/Money';
import { Tokens } from '@/components/Tokens';
import { Tooltip } from '@/components/Tooltip';
import { formatCount, formatPercent, formatTokensExact } from '@/lib/format';
import { ToolName } from '../tabs/toolbits';
import { Markdown } from './markdown';
import styles from './blocks.module.css';

/** How much raw text is rendered before an expander takes over. */
const CLAMP = 2400;

export interface ExpandApi {
  open: ReadonlySet<string>;
  toggle: (key: string) => void;
}

export function ClampedText({ text, id, expand, mono = false }: { text: string; id: string; expand: ExpandApi; mono?: boolean }) {
  const expanded = expand.open.has(id);
  const clipped = text.length > CLAMP && !expanded;
  const shown = clipped ? text.slice(0, CLAMP) : text;
  return (
    <div className={styles.clamp}>
      {mono ? (
        // `max-height` makes this a scrolling region, and a region only reachable by dragging
        // its scrollbar is unusable from the keyboard (WCAG 2.1.1). `tabIndex` makes it a stop
        // the arrow keys can then scroll.
        <pre className={styles.pre} tabIndex={0}>
          {shown}
        </pre>
      ) : (
        <Markdown text={shown} />
      )}
      {text.length > CLAMP ? (
        <button type="button" className={styles.expander} onClick={() => expand.toggle(id)}>
          {expanded ? 'Show less' : `Show all ${formatTokensExact(text.length)} characters`}
        </button>
      ) : null}
    </div>
  );
}

/** The exact price of one API call, as a chip on the message it produced. */
export function RequestChip({ request }: { request: RequestCost }) {
  const write = request.usage.cache5m + request.usage.cache1h;
  return (
    <span className={styles.requestChip}>
      <ModelChip model={request.model} />
      <span className={styles.usage} title={`${formatTokensExact(request.contextTokens)} tokens of context`}>
        <span className={styles.usageItem}>
          in <Tokens value={request.usage.input} />
        </span>
        <span className={styles.usageItem}>
          out <Tokens value={request.usage.output} />
        </span>
        <span className={styles.usageItem}>
          write <Tokens value={write} />
        </span>
        <span className={styles.usageItem}>
          read <Tokens value={request.usage.cacheRead} />
        </span>
      </span>
      <Tooltip content={`${formatPercent(request.cacheHitRatio)} of this request's context was served from the cache at a tenth of the input price.`}>
        <span className={styles.hit}>{formatPercent(request.cacheHitRatio)} cached</span>
      </Tooltip>
      {request.coldCache ? <span className={styles.warnFlag}>cold cache</span> : null}
      {request.isFallback ? <span className={styles.warnFlag}>fallback</span> : null}
      <Money usd={request.cost.total} className={styles.requestCost} />
    </span>
  );
}

export interface ToolCallRowProps {
  toolUseId: string;
  name: string;
  input: unknown;
  cost: ToolCallCost | undefined;
  expand: ExpandApi;
  sessionId: string;
}

export function ToolCallRow({ toolUseId, name, input, cost, expand, sessionId }: ToolCallRowProps) {
  const key = `tool:${toolUseId}`;
  const expanded = expand.open.has(key);
  const childHref = cost?.childAgentId
    ? `/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(cost.childAgentId)}`
    : cost?.childRunId
      ? `/sessions/${encodeURIComponent(sessionId)}/agents`
      : null;

  return (
    <div className={styles.tool} data-error={cost?.isError ? 'true' : undefined}>
      <button type="button" className={styles.toolHead} aria-expanded={expanded} onClick={() => expand.toggle(key)}>
        <Icon name="chevron" size={11} rotate={expanded ? 90 : 0} className={styles.chevron} />
        <Icon name="tools" size={12} className={styles.toolIcon} />
        <ToolName name={name} {...(cost?.mcpServer ? { mcpServer: cost.mcpServer } : {})} />
        <span className={styles.toolSummary}>{cost?.inputSummary ?? ''}</span>
        {cost?.isError ? <span className={styles.errorFlag}>error</span> : null}
        {cost ? (
          <span className={styles.toolCost}>
            <Money usd={cost.ownCost} />
            <EstimateBadge method={cost.result.estMethod} />
          </span>
        ) : null}
      </button>

      {expanded ? (
        <div className={styles.toolBody}>
          {cost ? (
            <dl className={styles.costGrid}>
              <div>
                <dt>Generate</dt>
                <dd>
                  <Money usd={cost.genCost} /> <span className={styles.muted}>{formatCount(cost.genTokens)} output tokens</span>
                </dd>
              </div>
              <div>
                <dt>Ingest result</dt>
                <dd>
                  <Money usd={cost.result.ingestCost} />{' '}
                  <span className={styles.muted}>{formatTokensExact(cost.resultChars)} chars, {cost.resultShape}</span>
                </dd>
              </div>
              <div>
                <dt>Carry result</dt>
                <dd>
                  <Money usd={cost.result.carryCost} />{' '}
                  <span className={styles.muted}>re-sent on {formatCount(cost.result.carryRequests)} later requests</span>
                </dd>
              </div>
              <div>
                <dt>Own total</dt>
                <dd>
                  <Money usd={cost.ownCost} className={styles.strong} /> <EstimateBadge method={cost.result.estMethod} />
                </dd>
              </div>
            </dl>
          ) : null}
          {childHref && cost ? (
            <p className={styles.child}>
              <Link to={childHref} className={styles.childLink}>
                <Icon name="agent" size={12} />
                {cost.childAgentId ? `Open this ${cost.childDescription ? 'agent' : 'subagent'} transcript` : 'Open this workflow run'}
              </Link>
              {cost.childCost === null ? null : (
                <>
                  {' '}
                  cost <Money usd={cost.childCost} /> <span className={styles.muted}>(exact, counted separately)</span>
                </>
              )}
              {cost.childModel ? <span className={styles.muted}> · model {cost.childModel}</span> : null}
            </p>
          ) : null}
          <ClampedText id={`${key}:input`} expand={expand} mono text={stringifyInput(input)} />
        </div>
      ) : null}
    </div>
  );
}

function stringifyInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return '(input could not be displayed)';
  }
}

export interface ToolResultRowProps {
  id: string;
  toolUseId: string;
  text: string;
  images: number;
  isError: boolean;
  cost: ToolCallCost | undefined;
  expand: ExpandApi;
}

export function ToolResultRow({ id, text, images, isError, cost, expand }: ToolResultRowProps) {
  const expanded = expand.open.has(id);
  return (
    <div className={styles.result} data-error={isError ? 'true' : undefined}>
      <button type="button" className={styles.resultHead} aria-expanded={expanded} onClick={() => expand.toggle(id)}>
        <Icon name="chevron" size={11} rotate={expanded ? 90 : 0} className={styles.chevron} />
        <span className={styles.resultLabel}>{isError ? 'error result' : 'result'}</span>
        {cost ? <ToolName name={cost.name} {...(cost.mcpServer ? { mcpServer: cost.mcpServer } : {})} /> : null}
        <span className={styles.sizeChip}>
          {formatTokensExact(text.length)} ch{images > 0 ? ` · ${plural(images, 'image')}` : ''}
        </span>
        {cost ? (
          <span className={styles.toolCost}>
            <Money usd={cost.result.ingestCost + cost.result.carryCost} />
            <EstimateBadge method={cost.result.estMethod} />
          </span>
        ) : null}
        <span className={styles.showHint}>{expanded ? 'hide' : 'show'}</span>
      </button>
      {expanded ? <ClampedText id={`${id}:text`} expand={expand} mono text={text || '(empty result)'} /> : null}
    </div>
  );
}

export function ThinkingBlock({ id, text, tokens, expand }: { id: string; text: string; tokens: number | null; expand: ExpandApi }) {
  const expanded = expand.open.has(id);
  return (
    <div className={styles.thinking}>
      <button type="button" className={styles.thinkingHead} aria-expanded={expanded} onClick={() => expand.toggle(id)}>
        <Icon name="chevron" size={11} rotate={expanded ? 90 : 0} className={styles.chevron} />
        thinking
        {tokens === null ? null : (
          <span className={styles.sizeChip}>
            <Tokens value={tokens} unit="tok" />
          </span>
        )}
      </button>
      {expanded ? <ClampedText id={`${id}:text`} expand={expand} text={text || '(no thinking text was recorded)'} /> : null}
    </div>
  );
}
