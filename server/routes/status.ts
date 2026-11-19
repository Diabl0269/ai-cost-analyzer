/** `GET /api/status` */
import { Hono } from 'hono';
import type { StatusResponse } from '../../core/types.js';
import type { AppDeps } from '../deps.js';
import { queryContext } from '../deps.js';
import { MAX_REPORTED_FAILURES } from '../indexing.js';

export function statusRoutes(deps: AppDeps): Hono {
  const app = new Hono();
  app.get('/', async (c) => {
    const ctx = queryContext(deps.config);
    const status = await deps.store.status(ctx);
    const idx = deps.index.status();
    const failures = idx.indexFailures ?? [];
    const warnings = idx.discoverWarnings ?? [];
    // How many indexed sessions the `hideScratchProjects` setting is currently hiding (all-time).
    const hidden = ctx.settings.hideScratchProjects ? status.scratchSessions : undefined;
    const response: StatusResponse = {
      version: deps.version,
      indexing: idx.indexing,
      ...(idx.error ? { indexError: idx.error } : {}),
      ...(failures.length > 0
        ? { indexFailures: failures.slice(0, MAX_REPORTED_FAILURES), indexFailureCount: failures.length }
        : {}),
      ...(warnings.length > 0
        ? { discoverWarnings: warnings.slice(0, MAX_REPORTED_FAILURES), discoverWarningCount: warnings.length }
        : {}),
      progress: idx.progress,
      lastIndexedAt: status.lastIndexedAt,
      roots: deps.roots,
      dbPath: deps.store.dbPath,
      dbBytes: status.dbBytes,
      counts: status.counts,
      unpricedModels: status.unpricedModels,
      ...(hidden === undefined ? {} : { scratchSessions: hidden }),
    };
    return c.json(response);
  });
  return app;
}
