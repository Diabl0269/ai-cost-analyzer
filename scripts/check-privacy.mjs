#!/usr/bin/env node
// scripts/check-privacy.mjs - plain Node, no deps.
//
// Walks the repo (honoring .gitignore-style excludes) looking for generic
// personally-identifying or machine-identifying strings that should never
// end up in a published repo: email addresses, non-"dev" /Users/<name> or
// /home/<name> paths, Slack member IDs, and any literal tokens listed one
// per line in an optional local ".privacy-denylist.local" file (itself
// gitignored - never commit real tokens there).
//
// Exits 1 and prints "path:line: <redacted hit>" for every match found.
// Exits 0 (with a summary line) when clean.
//
// This file intentionally contains none of the sensitive tokens it looks
// for - only generic patterns and a loader for the local denylist file.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp", ".tiff",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".pdf", ".zip", ".gz", ".tgz", ".tar", ".7z", ".rar",
  ".mp4", ".mov", ".avi", ".webm", ".mp3", ".wav",
  ".sqlite", ".sqlite-journal", ".sqlite-wal", ".sqlite-shm", ".db",
  ".wasm", ".node", ".jar", ".class",
]);

// Extensions treated as "docs" for the softer (warning-only) email rule.
const DOC_EXTS = new Set([".md", ".mdx", ".txt", ".html", ".htm"]);

const ALWAYS_SKIP_DIRS = new Set([".git"]);

/* Minimal .gitignore reader: supports comments, blank lines, trailing "/"
 * directory patterns, "*"-glob basename patterns, and bare literal names.
 * Not a full gitignore implementation - sufficient for this repo's file. */
function loadGitignore(root) {
  const p = path.join(root, ".gitignore");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}

function makeIgnoreMatcher(patterns) {
  const dirNames = [];
  const dirPaths = [];
  const fileGlobs = [];
  for (const raw of patterns) {
    const pat = raw.replace(/^\//, "");
    const qualified = pat.includes("/");
    if (pat.endsWith("/")) {
      const name = pat.slice(0, -1);
      if (qualified) dirPaths.push(name); else dirNames.push(name);
    } else if (pat.includes("*")) {
      fileGlobs.push(globToRegExp(pat));
    } else {
      if (qualified) dirPaths.push(pat); else dirNames.push(pat);
      fileGlobs.push(globToRegExp(qualified ? pat.split("/").pop() : pat));
    }
  }
  return {
    isDirIgnored(name, relPath) {
      return dirNames.includes(name) || dirPaths.includes(relPath);
    },
    isFileIgnored(name) {
      return fileGlobs.some((re) => re.test(name));
    },
  };
}

function loadDenylist(root) {
  const p = path.join(root, ".privacy-denylist.local");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function walk(dir, matcher, out, root) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Git worktrees use a .git file containing a machine-local path.
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
      if (matcher.isDirIgnored(entry.name, rel)) continue;
      walk(full, matcher, out, root);
    } else if (entry.isFile()) {
      if (matcher.isFileIgnored(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTS.has(ext)) continue;
      out.push(full);
    }
  }
}

function redact(token) {
  return token.slice(0, 3) + "...";
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const USERS_PATH_RE = /\/Users\/([A-Za-z0-9_.-]+)/g;
const HOME_PATH_RE = /\/home\/([A-Za-z0-9_.-]+)/g;
const SLACK_ID_RE = /\bU0[A-Z0-9]{8,}\b/g;

function looksBinary(text) {
  if (text.indexOf(String.fromCharCode(0)) !== -1) return true;
  let weird = 0;
  const sampleLen = Math.min(text.length, 2000);
  for (let i = 0; i < sampleLen; i++) {
    const c = text.charCodeAt(i);
    if (c < 9 || (c > 13 && c < 32)) weird++;
  }
  return sampleLen > 0 && weird / sampleLen > 0.05;
}

function scanFile(file, denylist) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { hits: [], warnings: [] };
  }
  if (looksBinary(text)) return { hits: [], warnings: [] };

  const lines = text.split("\n");
  const ext = path.extname(file).toLowerCase();
  const isDoc = DOC_EXTS.has(ext);
  const hits = [];
  const warnings = [];

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    for (const m of line.matchAll(EMAIL_RE)) {
      const bucket = isDoc ? warnings : hits;
      bucket.push({ line: lineNo, token: m[0] });
    }

    for (const m of line.matchAll(USERS_PATH_RE)) {
      if (m[1] === "dev") continue; // fixture convention: /Users/dev/... is fine
      hits.push({ line: lineNo, token: "/Users/" + m[1] });
    }

    for (const m of line.matchAll(HOME_PATH_RE)) {
      if (m[1] === "user") continue; // fixture convention: /home/user/... is fine
      hits.push({ line: lineNo, token: "/home/" + m[1] });
    }

    for (const m of line.matchAll(SLACK_ID_RE)) {
      hits.push({ line: lineNo, token: m[0] });
    }

    // Long base64 data-URI payloads can coincidentally contain a short
    // denylist token; the structured regexes above are unaffected by this
    // (an email or /Users/<name> shape essentially can't appear by chance).
    const isBase64Blob = line.includes("base64,") || (line.length > 2000 && /^[A-Za-z0-9+/=\s"'<>:;,.-]+$/.test(line));
    if (isBase64Blob) return;

    for (const token of denylist) {
      if (!token) continue;
      let from = 0;
      let idx2;
      while ((idx2 = line.indexOf(token, from)) !== -1) {
        hits.push({ line: lineNo, token });
        from = idx2 + token.length;
      }
    }
  });

  return { hits, warnings };
}

function main() {
  const gitignorePatterns = loadGitignore(ROOT);
  const matcher = makeIgnoreMatcher(gitignorePatterns);
  const denylist = loadDenylist(ROOT);

  const files = [];
  walk(ROOT, matcher, files, ROOT);

  let anyHit = false;
  let anyWarning = false;

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const { hits, warnings } = scanFile(file, denylist);
    for (const h of hits) {
      anyHit = true;
      console.error(rel + ":" + h.line + ": " + redact(h.token));
    }
    for (const w of warnings) {
      anyWarning = true;
      console.warn("WARNING " + rel + ":" + w.line + ": " + redact(w.token) + " (email-like mention in a doc file)");
    }
  }

  if (anyHit) {
    console.error("\ncheck-privacy: found sensitive-looking strings above.");
    process.exit(1);
  }

  if (anyWarning) {
    console.warn("\ncheck-privacy: no blocking hits; see warnings above.");
  } else {
    console.log("check-privacy: clean.");
  }
}

main();
