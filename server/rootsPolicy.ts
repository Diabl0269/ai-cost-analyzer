/**
 * Policy for `settings.roots` (the directories the indexer walks for transcripts), enforced on
 * `PUT /api/settings`. Two rules, both server-side because `core/settings.ts`'s zod schema only
 * checks shape ("a non-empty array of non-empty strings"), not filesystem meaning:
 *
 *  1. Every root must resolve (after `~` expansion) to a directory that exists right now. A
 *     typo'd or not-yet-mounted path is rejected at save time rather than silently indexing
 *     nothing (the watcher already tolerates a root that *disappears* later — see watcher.ts —
 *     this is only about what you're allowed to configure).
 *  2. No root may be, or contain as an ancestor relationship, a well-known sensitive location:
 *     OS/system directories, and per-user credential/secret directories and files. This is a
 *     single-user tool that walks arbitrary directory trees and full-text-indexes every line of
 *     every file that looks like a transcript into a local SQLite DB; pointing it at `/`, `/etc`,
 *     or `~/.ssh` would happily index (and make searchable, in `messages_fts`) the contents of
 *     those files. `~/.claude` itself is denied (it holds this account's own credentials/oauth
 *     state next to the transcripts), but `~/.claude/projects` — the documented default root —
 *     is explicitly carved back out since it is a normal descendant of the denied path, not an
 *     ancestor of anything sensitive.
 *
 * Non-goals: this does not stop a root from containing *unrelated* non-sensitive private files
 * (that's the point of the feature), and it does not follow symlinks to detect a link that
 * escapes to a sensitive target after the fact — same non-goal as `static.ts`'s traversal guard.
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expandHome } from './paths.js';

export interface RootsPolicyViolation {
  root: string;
  reason: 'not_a_directory' | 'sensitive_location';
}

export interface RootsPolicyResult {
  ok: boolean;
  violations: RootsPolicyViolation[];
}

/** `a` is `b` itself, or an ancestor directory of `b`, after normalization. */
function isAncestorOrEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const prefix = a.endsWith(sep) ? a : a + sep;
  return b.startsWith(prefix);
}

/** Fixed, resolved once per call since `home` and `ccaHome` are runtime values. */
function sensitivePaths(ccaHome: string): string[] {
  const home = homedir();
  return [
    '/etc',
    '/private/etc',
    '/var',
    '/private/var',
    '/System',
    '/Library',
    '/root',
    '/proc',
    '/sys',
    '/dev',
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    join(home, '.kube'),
    join(home, '.docker'),
    join(home, '.npmrc'),
    join(home, '.netrc'),
    join(home, '.pypirc'),
    join(home, '.git-credentials'),
    join(home, '.claude'),
    join(home, '.codex'),
    ...(process.env.CODEX_HOME ? [resolve(expandHome(process.env.CODEX_HOME))] : []),
    resolve(ccaHome),
  ];
}

/** `~/.claude/projects` (and anything under it) is a normal descendant of the denied `~/.claude`,
 * not an ancestor of anything sensitive, so it is always allowed regardless of the check above. */
function isExplicitlyAllowed(resolvedRoot: string): boolean {
  const codexHome = resolve(expandHome(process.env.CODEX_HOME ?? join(homedir(), '.codex')));
  const allowed = [join(homedir(), '.claude', 'projects'),
    join(homedir(), '.codex', 'sessions'), join(homedir(), '.codex', 'archived_sessions'),
    join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')];
  return allowed.some((root) => isAncestorOrEqual(resolve(root), resolvedRoot));
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Validates a full `settings.roots` list. Returns every violation found (not just the first) so
 * the caller can report a single, honest 400 without a second round trip.
 *
 * `previousRoots` (the roots already on file, if any) grandfathers the "must exist" rule: a root
 * that was already configured and has since disappeared (unmounted drive, deleted directory —
 * see watcher.ts, which already tolerates this at run time) does not block saving an *unrelated*
 * settings change, e.g. a theme toggle, since `PUT /api/settings` always sends the whole object.
 * The sensitive-location check has no such exemption and always runs, on every root, every save.
 */
export function validateRoots(
  roots: string[],
  ccaHome: string,
  previousRoots: readonly string[] = [],
): RootsPolicyResult {
  const sensitive = sensitivePaths(ccaHome);
  const previous = new Set(previousRoots);
  const violations: RootsPolicyViolation[] = [];

  for (const raw of roots) {
    const resolved = resolve(expandHome(raw));

    if (!isExplicitlyAllowed(resolved)) {
      const hitsSensitive = sensitive.some(
        (s) => isAncestorOrEqual(resolved, s) || isAncestorOrEqual(s, resolved),
      );
      if (hitsSensitive) {
        violations.push({ root: raw, reason: 'sensitive_location' });
        continue;
      }
    }

    if (!previous.has(raw) && !isDirectory(resolved)) {
      violations.push({ root: raw, reason: 'not_a_directory' });
    }
  }

  return { ok: violations.length === 0, violations };
}
