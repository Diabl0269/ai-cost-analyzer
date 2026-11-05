/**
 * Prompt cleaning and session-title resolution (SPEC §4).
 */
import type { TitleSource } from '../types.js';

const MAX_TITLE_CHARS = 120;

/** Wrapper elements that are harness plumbing: dropped whole, content included. */
const DROPPED_BLOCKS = [
  'system-reminder',
  'task-notification',
  'local-command-stdout',
  'local-command-caveat',
  'command-message',
  'command-contents',
  'persisted-output',
];

const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/i;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/gi;

function dropBlock(text: string, tag: string): string {
  const paired = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'gi');
  const dangling = new RegExp(`</?${tag}>`, 'gi');
  return text.replace(paired, ' ').replace(dangling, ' ');
}

/**
 * Turns raw prompt text into something a human can read in a list: harness wrappers removed,
 * slash commands rendered as `/<command> <args>`, whitespace collapsed, capped at 120 chars.
 */
export function cleanPrompt(text: string): string {
  if (!text) return '';
  let rest = text.replace(/(?<!!)\[([^\]\r\n]+)\]\((?:<[^>\r\n]+>|[^()\r\n]*(?:\([^()\r\n]*\)[^()\r\n]*)*)\)/g, '$1');

  const nameMatch = COMMAND_NAME.exec(rest);
  const commandName = nameMatch?.[1]?.trim().replace(/^\//, '');

  const args: string[] = [];
  for (const m of rest.matchAll(COMMAND_ARGS)) {
    const value = m[1]?.trim();
    if (value) args.push(value);
  }

  rest = rest.replace(COMMAND_NAME, ' ');
  rest = rest.replace(COMMAND_ARGS, ' ');
  for (const tag of DROPPED_BLOCKS) rest = dropBlock(rest, tag);

  const parts: string[] = [];
  if (commandName) parts.push(`/${commandName}`);
  parts.push(...args);
  parts.push(rest);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
}

/** Codex automation envelopes supply a task name; only complete leading metadata qualifies. */
function titlePrompt(text: string): string {
  const automation = /^\s*Automation:[ \t]+([^\r\n]+)\r?\n[ \t]*Automation ID:[ \t]*[^\r\n]+\r?\n[ \t]*Automation memory:[ \t]*[^\r\n]+(?:\r?\n|$)/.exec(text);
  return cleanPrompt(automation?.[1] ?? text);
}

export interface TitleInput {
  /** last `custom-title` line in the transcript */
  customTitle?: string;
  /** `<session>/custom-title.json` */
  customTitleFromFile?: string;
  aiTitle?: string;
  agentName?: string;
  /** `summary` from `sessions-index.json` */
  indexSummary?: string;
  firstPrompt?: string;
  slug?: string;
  sessionId: string;
}

export interface ResolvedTitle {
  title: string;
  source: TitleSource;
}

/** Title priority per SPEC §4; falls back to a short session id, so it never returns empty. */
export function resolveTitle(input: TitleInput): ResolvedTitle {
  const candidates: [TitleSource, string | undefined][] = [
    ['custom-title', input.customTitle],
    ['custom-title-file', input.customTitleFromFile],
    ['ai-title', input.aiTitle],
    ['agent-name', input.agentName],
    ['sessions-index', input.indexSummary],
    ['first-prompt', input.firstPrompt === undefined ? undefined : titlePrompt(input.firstPrompt)],
    ['slug', input.slug],
  ];
  for (const [source, value] of candidates) {
    const title = value?.trim().slice(0, MAX_TITLE_CHARS);
    if (title) return { title, source };
  }
  if (input.sessionId.startsWith('copilot-')) return { title: `Copilot ${input.sessionId.slice('copilot-'.length)}`, source: 'session-id' };
  return { title: input.sessionId.startsWith('codex-') ? `Codex ${input.sessionId.slice('codex-'.length)}` : input.sessionId.slice(0, 8), source: 'session-id' };
}
