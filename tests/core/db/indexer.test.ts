import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiscoveredSession, IndexProgress, ParsedSession, PricingConfig, UserSettings } from '../../../core/types.js';
import type { QueryContext } from '../../../core/store.js';
import { defaultPricing } from '../../../core/pricing/defaults.js';
import { defaultSettings } from '../../../core/settings.js';
import { META_PARSER_VERSION, PARSER_VERSION, runIndex, indexChangedFiles } from '../../../core/db/indexer.js';
import { createStore } from '../../../core/db/store.js';
import { getMeta, openDatabase, setMeta } from '../../../core/db/schema.js';
import { SESSION_ID } from '../cost/builders.js';
import { EXPECTED, EXPECTED_MAIN, EXPECTED_TOTAL, buildFixture } from './fixture.js';

let root: string;
let dbPath: string;
const pricing: PricingConfig = defaultPricing();
const settings: UserSettings = { ...defaultSettings(), hideScratchProjects: false };
const ctx: QueryContext = { pricing, settings, now: new Date(2026, 8, 7, 12) };

function deps(session: ParsedSession): {
  discover: (roots: string[]) => Promise<DiscoveredSession[]>;
  parse: (s: DiscoveredSession) => Promise<ParsedSession>;
} {
  return {
    discover: async () => [session.discovered],
    parse: async () => session,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cca-index-'));
  dbPath = join(root, 'db', 'index.sqlite');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('runIndex', () => {
  it('indexes a session and reports progress phases', async () => {
    const fixture = buildFixture(root);
    const phases: IndexProgress['phase'][] = [];
    const result = await runIndex({
      roots: [root],
      dbPath,
      pricing,
      onProgress: (p) => phases.push(p.phase),
      ...deps(fixture.session),
    });
    expect(result.sessionsIndexed).toBe(1);
    expect(result.sessionsSkipped).toBe(0);
    expect(result.filesSeen).toBe(2);
    expect(result.changedSessionIds).toEqual([SESSION_ID]);
    expect(phases).toContain('discover');
    expect(phases).toContain('parse');
    expect(phases).toContain('write');
    expect(phases.at(-1)).toBe('done');
  });

  it('skips a session whose files are unchanged and re-indexes when mtime moves', async () => {
    const fixture = buildFixture(root);
    await runIndex({ roots: [root], dbPath, pricing, ...deps(fixture.session) });

    const second = await runIndex({ roots: [root], dbPath, pricing, ...deps(fixture.session) });
    expect(second.sessionsSkipped).toBe(1);
    expect(second.sessionsIndexed).toBe(0);

    const touched = buildFixture(root, 1_757_000_999_000);
    const third = await runIndex({ roots: [root], dbPath, pricing, ...deps(touched.session) });
    expect(third.sessionsIndexed).toBe(1);
    expect(third.sessionsSkipped).toBe(0);
  });

  it('replaces rows instead of duplicating them on re-index', async () => {
    const fixture = buildFixture(root);
    await runIndex({ roots: [root], dbPath, pricing, ...deps(fixture.session) });
    const touched = buildFixture(root, 1_757_000_999_000);
    await runIndex({ roots: [root], dbPath, pricing, ...deps(touched.session) });

    const store = createStore(dbPath);
    try {
      const status = await store.status(ctx);
      expect(status.counts.sessions).toBe(1);
      expect(status.counts.requests).toBe(4);
      expect(status.counts.messages).toBe(10);
      expect(status.counts.agents).toBe(1);
      expect(status.lastIndexedAt).not.toBeNull();
      expect(status.dbBytes).toBeGreaterThan(0);
      expect(status.unpricedModels).toEqual([]);
      // The FTS rows must be replaced too, or every re-index would duplicate the hits.
      const search = await store.search({ q: 'helper' }, ctx);
      expect(search.groups).toHaveLength(1);
      expect(search.groups[0]?.hits.length).toBeLessThanOrEqual(3);
      expect(await store.search({ q: 'utils', scope: 'titles' }, ctx)).toMatchObject({ totalSessions: 1 });
    } finally {
      store.close();
    }
  });

  it('drops sessions that disappeared from disk', async () => {
    const fixture = buildFixture(root);
    await runIndex({ roots: [root], dbPath, pricing, ...deps(fixture.session) });
    const gone = await runIndex({
      roots: [root],
      dbPath,
      pricing,
      discover: async () => [],
      parse: async () => fixture.session,
    });
    expect(gone.changedSessionIds).toEqual([SESSION_ID]);

    const store = createStore(dbPath);
    try {
      expect((await store.status(ctx)).counts.sessions).toBe(0);
    } finally {
      store.close();
    }
  });

  it('rebuilds from scratch with full: true', async () => {
    const fixture = buildFixture(root);
    await runIndex({ roots: [root], dbPath, pricing, ...deps(fixture.session) });
    const full = await runIndex({ roots: [root], dbPath, pricing, full: true, ...deps(fixture.session) });
    expect(full.sessionsIndexed).toBe(1);
    expect(full.sessionsSkipped).toBe(0);

    const store = createStore(dbPath);
    try {
      expect((await store.status(ctx)).counts.requests).toBe(4);
    } finally {
      store.close();
    }
  });

  it('counts a session that fails to parse without aborting the run', async () => {
    const fixture = buildFixture(root);
    const result = await runIndex({
      roots: [root],
      dbPath,
      pricing,
      discover: async () => [fixture.discovered],
      parse: async () => {
        throw new Error('bad line');
      },
    });
    expect(result.parseErrors).toBe(1);
    expect(result.sessionsIndexed).toBe(0);
  });
});

describe('indexChangedFiles', () => {
  it('re-indexes only the sessions owning the changed paths', async () => {
    const fixture = buildFixture(root);
    await runIndex({ roots: [root], dbPath, pricing, ...deps(fixture.session) });

    const untouched = await indexChangedFiles([join(root, 'other.jsonl')], {
      roots: [root],
      dbPath,
      pricing,
      ...deps(fixture.session),
    });
    expect(untouched.sessionsIndexed).toBe(0);
    expect(untouched.sessionsSkipped).toBe(0);

    const touched = buildFixture(root, 1_757_001_999_000);
    const changed = await indexChangedFiles([fixture.mainPath], {
      roots: [root],
      dbPath,
      pricing,
      ...deps(touched.session),
    });
    expect(changed.sessionsIndexed).toBe(1);
  });
});

describe('hand-computed totals', () => {
  it('matches the fixture priced at list prices', async () => {
    const fixture = buildFixture(root);
    await runIndex({ roots: [root], dbPath, pricing, ...deps(fixture.session) });
    const store = createStore(dbPath);
    try {
      const list = await store.listSessions({}, ctx);
      expect(list.total).toBe(1);
      const session = list.sessions[0];
      expect(session).toBeDefined();
      if (!session) return;
      expect(session.cost.total).toBeCloseTo(EXPECTED_TOTAL, 12);
      expect(session.costMain).toBeCloseTo(EXPECTED_MAIN, 12);
      expect(session.costAgents).toBeCloseTo(EXPECTED.agent, 12);
      expect(session.costWorkflows).toBe(0);
      expect(session.requestCount).toBe(4);
      expect(session.tokens.output).toBe(500 + 300 + 200 + 18);
      expect(session.tokens.context).toBe(1000 + 3100 + 4050 + 6735);
      expect(session.reportedCostUsd).toBe(0.05);
      expect(session.models).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-5']);
      expect(list.totalCost).toBeCloseTo(EXPECTED_TOTAL, 12);
    } finally {
      store.close();
    }
  });
});


describe('parser cache upgrades', () => {
  it('reparses unchanged files to refresh derived titles and then resumes incremental skipping', async () => {
    const fixture = buildFixture(root);
    const opts = { roots: [root], dbPath, pricing, ...deps(fixture.session) };
    await runIndex(opts);
    const db = openDatabase(dbPath);
    setMeta(db, META_PARSER_VERSION, 'old');
    db.close();
    fixture.session.main.facts!.customTitle = 'Refreshed human request';
    const upgraded = await runIndex(opts);
    expect(upgraded.sessionsIndexed).toBe(1);
    const store = createStore(dbPath);
    try { expect((await store.getSession(SESSION_ID, ctx))?.summary.title).toBe('Refreshed human request'); }
    finally { store.close(); }
    expect((await runIndex(opts)).sessionsSkipped).toBe(1);
  });

  it('upgrades the whole parser cache when the first event after an upgrade is a watcher update', async () => {
    const fixture = buildFixture(root);
    const opts = { roots: [root], dbPath, pricing, ...deps(fixture.session) };
    await runIndex(opts);
    const db = openDatabase(dbPath);
    setMeta(db, META_PARSER_VERSION, 'old'); db.close();
    expect((await indexChangedFiles([join(root, 'unrelated.jsonl')], opts)).sessionsIndexed).toBe(1);
    const check = openDatabase(dbPath);
    expect(getMeta(check, META_PARSER_VERSION)).toBe(PARSER_VERSION); check.close();
  });

  it('does not certify a parser upgrade when a whole session fails', async () => {
    const fixture = buildFixture(root);
    const opts = { roots: [root], dbPath, pricing, ...deps(fixture.session) };
    await runIndex(opts);
    const db = openDatabase(dbPath); setMeta(db, META_PARSER_VERSION, 'old'); db.close();
    const result = await runIndex({ ...opts, parse: async () => { throw new Error('Synthetic parse failure'); } });
    expect(result.sessionsFailed).toBe(1);
    const check = openDatabase(dbPath); expect(getMeta(check, META_PARSER_VERSION)).toBe('old'); check.close();
  });
});
