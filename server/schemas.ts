/**
 * zod schemas for every query string / body the server accepts. Query strings are always
 * `string | undefined` from the URL, so numeric/boolean fields are coerced explicitly here
 * (not with `z.coerce.boolean()`, which treats the literal string `"false"` as truthy).
 */
import { z } from 'zod';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const dateSchema = z.string().regex(DATE_RE, 'expected YYYY-MM-DD');

/** `"true" | "false"` query param → boolean. */
const boolQuerySchema = z.enum(['true', 'false']).transform((v) => v === 'true');

function commaList<T extends string>(values: readonly [T, ...T[]]) {
  return z.preprocess((input) => {
    if (typeof input !== 'string' || input.length === 0) return undefined;
    const items = input
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }, z.array(z.enum(values)).optional());
}

export const rangeQuerySchema = z.object({
  provider: z.enum(['claude', 'codex', 'copilot']).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  project: z.string().min(1).max(4096).optional(),
  whatIf: z.string().min(1).max(4096).optional(),
});

export const sessionSortValues = ['recent', 'cost', 'duration', 'prompts', 'requests', 'tools', 'started'] as const;

export const sessionsQuerySchema = rangeQuerySchema.extend({
  q: z.string().max(1000).optional(),
  sort: z.enum(sessionSortValues).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().max(4096).optional(),
  model: z.string().max(200).optional(),
  entrypoint: z.string().max(200).optional(),
  pinned: boolQuerySchema.optional(),
  hasAgents: boolQuerySchema.optional(),
});

/** Routes that take no range but still honour a pricing simulation. */
export const whatIfQuerySchema = z.object({
  whatIf: z.string().min(1).max(4096).optional(),
});

export const transcriptQuerySchema = whatIfQuerySchema.extend({
  agentId: z.string().max(200).optional(),
  fromSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

const searchKindValues = ['prompt', 'assistant', 'thinking', 'tool_use', 'tool_result'] as const;

export const searchQuerySchema = rangeQuerySchema.extend({
  q: z.string().min(1).max(1000),
  scope: z.enum(['titles', 'everything']).optional(),
  kinds: commaList(searchKindValues),
  model: z.string().max(200).optional(),
  tool: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(4096).optional(),
});

export const reindexBodySchema = z.object({ full: z.boolean().optional() });

/**
 * Safe-token check for a session id that is about to be embedded in an HTTP response header
 * (`Content-Disposition` filename on `GET /api/export/sessions/:id.json`). Real session ids are
 * UUIDs (SPEC §3.1: `<sessionId>.jsonl`), so this is intentionally tighter than
 * `sessionIdParamSchema` (used for lookups, which just need "some string"): it excludes quotes,
 * CR/LF, and path separators so an id can never break out of the quoted filename or inject a
 * header. A store lookup miss on an id shaped like this still 404s normally; ids that don't
 * match this shape 400 before we ever build a header from them.
 */
export const sessionIdTokenSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9._-]+$/, 'must be a plain id (letters, digits, "-", "_", ".")');

export const sessionIdParamSchema = z.object({ id: z.string().min(1).max(500) });
