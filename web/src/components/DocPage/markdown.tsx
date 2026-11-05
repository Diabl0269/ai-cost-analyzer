/**
 * A deliberately small Markdown subset renderer for the prose documents this repo ships
 * (`docs/METHODOLOGY.md`, `docs/HOW-IT-WORKS.md`).
 *
 * Everything is built out of React elements — there is no `dangerouslySetInnerHTML` and no HTML
 * pass-through anywhere, so an angle bracket in the source is text, not markup. Supported:
 * ATX headings, paragraphs, fenced code, ordered and unordered lists, block quotes, thematic
 * breaks, and inline code, bold and links. Anything else renders as the literal characters,
 * which is the right failure mode for a document we ship ourselves.
 */
import { Fragment, type ReactNode } from 'react';
import { Link } from '../../lib/navigation.js';

export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string; slug: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; language: string | null; code: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' };

/**
 * URL-safe id for a heading, used by the in-page contents list. Numbered headings ("2. Request
 * cost") would otherwise produce an id starting with a digit, which is legal HTML but not a legal
 * CSS selector, so those get an `s-` prefix.
 */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[`*_[\]()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^\d/.test(slug) ? `s-${slug}` : slug;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^```\s*([A-Za-z0-9+-]*)\s*$/;
const BULLET = /^[-*]\s+(.*)$/;
const ORDERED = /^\d+\.\s+(.*)$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const QUOTE = /^>\s?(.*)$/;

/** Splits the source into blocks. Line-based: the subset has no nested containers. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  const flushParagraph = (buffer: string[]): void => {
    if (buffer.length === 0) return;
    blocks.push({ kind: 'paragraph', text: buffer.join(' ').trim() });
    buffer.length = 0;
  };

  const paragraph: string[] = [];

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (trimmed === '') {
      flushParagraph(paragraph);
      index += 1;
      continue;
    }

    const fence = FENCE.exec(trimmed);
    if (fence) {
      flushParagraph(paragraph);
      const language = fence[1] ? fence[1] : null;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test((lines[index] ?? '').trim())) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // closing fence
      blocks.push({ kind: 'code', language, code: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(trimmed);
    if (heading) {
      flushParagraph(paragraph);
      const level = Math.min(6, (heading[1] ?? '#').length) as 1 | 2 | 3 | 4 | 5 | 6;
      const text = (heading[2] ?? '').trim();
      blocks.push({ kind: 'heading', level, text, slug: slugify(text) });
      index += 1;
      continue;
    }

    if (RULE.test(trimmed)) {
      flushParagraph(paragraph);
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    const bullet = BULLET.exec(trimmed);
    const ordered = ORDERED.exec(trimmed);
    if (bullet || ordered) {
      flushParagraph(paragraph);
      const isOrdered = Boolean(ordered);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const currentTrimmed = current.trim();
        if (currentTrimmed === '') break;
        const nextBullet = BULLET.exec(currentTrimmed);
        const nextOrdered = ORDERED.exec(currentTrimmed);
        if ((isOrdered && nextOrdered) || (!isOrdered && nextBullet)) {
          items.push(((isOrdered ? nextOrdered?.[1] : nextBullet?.[1]) ?? '').trim());
        } else if (items.length > 0 && /^\s+/.test(current)) {
          // A continuation line of the item above.
          items[items.length - 1] = `${items[items.length - 1] ?? ''} ${currentTrimmed}`;
        } else {
          break;
        }
        index += 1;
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items });
      continue;
    }

    const quote = QUOTE.exec(trimmed);
    if (quote) {
      flushParagraph(paragraph);
      const body: string[] = [quote[1] ?? ''];
      index += 1;
      while (index < lines.length) {
        const next = QUOTE.exec((lines[index] ?? '').trim());
        if (!next) break;
        body.push(next[1] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'quote', text: body.join(' ').trim() });
      continue;
    }

    paragraph.push(trimmed);
    index += 1;
  }

  flushParagraph(paragraph);
  return blocks;
}

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const BOLD = /\*\*([^*]+)\*\*/g;

export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'link'; text: string; href: string };

/** Only http(s) and in-app paths become links; anything else stays as its own literal text. */
export function safeHref(href: string): string | null {
  if (href.startsWith('/') || href.startsWith('#')) return href;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function pushText(tokens: InlineToken[], text: string): void {
  if (text) tokens.push({ kind: 'text', text });
}

function tokenizeEmphasis(text: string, tokens: InlineToken[]): void {
  let cursor = 0;
  BOLD.lastIndex = 0;
  for (let match = BOLD.exec(text); match; match = BOLD.exec(text)) {
    pushText(tokens, text.slice(cursor, match.index));
    tokens.push({ kind: 'strong', text: match[1] ?? '' });
    cursor = match.index + match[0].length;
  }
  pushText(tokens, text.slice(cursor));
}

function tokenizeLinks(text: string, tokens: InlineToken[]): void {
  let cursor = 0;
  LINK.lastIndex = 0;
  for (let match = LINK.exec(text); match; match = LINK.exec(text)) {
    tokenizeEmphasis(text.slice(cursor, match.index), tokens);
    const href = safeHref(match[2] ?? '');
    if (href) tokens.push({ kind: 'link', text: match[1] ?? '', href });
    else pushText(tokens, match[0]);
    cursor = match.index + match[0].length;
  }
  tokenizeEmphasis(text.slice(cursor), tokens);
}

/**
 * Inline markup, as data: code spans win over everything (so `**x**` inside backticks stays
 * literal), then links, then bold. Kept separate from rendering so the rules are unit-testable.
 */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  text.split('`').forEach((part, position) => {
    if (position % 2 === 1) tokens.push({ kind: 'code', text: part });
    else if (part) tokenizeLinks(part, tokens);
  });
  return tokens;
}

/** Turns the tokens above into React elements. No HTML string ever reaches the DOM. */
export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  return parseInline(text).map((token, position) => {
    const key = `${keyPrefix}-${position}`;
    switch (token.kind) {
      case 'text':
        return <Fragment key={key}>{token.text}</Fragment>;
      case 'code':
        return <code key={key}>{token.text}</code>;
      case 'strong':
        return <strong key={key}>{token.text}</strong>;
      case 'link':
        // An in-app path (`/methodology`) is a route, not a document: routing it through
        // `<Link>` keeps the navigation client-side instead of reloading the whole app.
        return token.href.startsWith('/') ? (
          <Link key={key} to={token.href}>
            {token.text}
          </Link>
        ) : (
          <a key={key} href={token.href} rel="noreferrer">
            {token.text}
          </a>
        );
    }
  });
}

export interface MarkdownProps {
  source: string;
  /** class applied to every heading, so the page can hang scroll-margin off it */
  headingClassName?: string;
}

/** Renders the subset above. Headings carry the slug id the contents list links to. */
export function Markdown({ source, headingClassName }: MarkdownProps) {
  const blocks = parseMarkdown(source);
  return (
    <>
      {blocks.map((block, position) => {
        const key = `${block.kind}-${position}`;
        switch (block.kind) {
          case 'heading': {
            const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
            return (
              <Tag key={key} id={block.slug} className={headingClassName}>
                {renderInline(block.text, key)}
              </Tag>
            );
          }
          case 'paragraph':
            return <p key={key}>{renderInline(block.text, key)}</p>;
          case 'code':
            return (
              <pre key={key}>
                <code data-language={block.language ?? undefined}>{block.code}</code>
              </pre>
            );
          case 'list':
            return block.ordered ? (
              <ol key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </ul>
            );
          case 'quote':
            return <blockquote key={key}>{renderInline(block.text, key)}</blockquote>;
          case 'rule':
            return <hr key={key} />;
        }
      })}
    </>
  );
}
