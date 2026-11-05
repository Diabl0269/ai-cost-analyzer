/** `GET /api/status` */
import { Hono } from 'hono';
import type { StatusResponse } from '../../core/types.js';
import type { AppDeps } from '../deps.js';
import { queryContext } from '../deps.js';

export function statusRoutes(deps: AppDeps): Hono {
  const app = new Hono();
  app.get('/', async (c) => {
    const ctx = queryContext(deps.config);
    const status = await deps.store.status(ctx);
    const idx = deps.index.status();
    // How many indexed sessions the `hideScratchProjects` setting is currently hiding (all-time).
    const hidden = ctx.settings.hideScratchProjects ? status.scratchSessions : undefined;
    const response: StatusResponse = {
      version: deps.version,
      indexing: idx.indexing,
      ...(idx.error ? { indexError: idx.error } : {}),
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
