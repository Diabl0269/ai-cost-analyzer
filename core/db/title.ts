/**
 * Adapter from `ParsedSession` to the parser's title resolution (SPEC §4), so the DB stores the
 * same title the transcript view shows. The rules themselves live in core/parse/titles.ts.
 */
import type { ParsedSession } from '../types.js';
import { cleanPrompt, resolveTitle as resolveTitleFrom, type ResolvedTitle } from '../parse/index.js';

export function resolveSessionTitle(session: ParsedSession): ResolvedTitle {
  const facts = session.main.facts;
  const firstPrompt = session.discovered.provider === 'codex'
    ? session.main.messages.find((message) => message.kind === 'prompt')?.searchText ?? facts?.firstPrompt
    : facts?.firstPrompt;
  return resolveTitleFrom({
    ...(facts?.customTitle ? { customTitle: facts.customTitle } : {}),
    ...(session.customTitleFromFile ? { customTitleFromFile: session.customTitleFromFile } : {}),
    ...(facts?.aiTitle ? { aiTitle: facts.aiTitle } : {}),
    ...(facts?.agentName ? { agentName: facts.agentName } : {}),
    ...(session.discovered.indexEntry?.summary ? { indexSummary: session.discovered.indexEntry.summary } : {}),
    ...(firstPrompt ? { firstPrompt } : {}),
    ...(session.main.meta.slug ? { slug: session.main.meta.slug } : {}),
    sessionId: session.discovered.sessionId,
  });
}

/** First human prompt, cleaned, for the list view and title search. */
export function resolveFirstPrompt(session: ParsedSession): string {
  return cleanPrompt(session.main.facts?.firstPrompt ?? session.discovered.indexEntry?.firstPrompt ?? '');
}
