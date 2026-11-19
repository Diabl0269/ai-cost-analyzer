/** `GET /api/analytics/{overview,summary,tools,models,hooks,attribution,insights}` */
import { Hono } from 'hono';
import type { SummaryResponse } from '../../core/types.js';
import type { AppDeps } from '../deps.js';
import { queryContext } from '../deps.js';
import { rangeQuerySchema } from '../schemas.js';
import { parseQuery } from '../validate.js';

export function analyticsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/overview', async (c) => {
    const query = parseQuery(c, rangeQuerySchema);
    if (!query.ok) return query.response;
    return c.json(await deps.store.overview(query.data, queryContext(deps.config)));
  });

  app.get('/summary', async (c) => {
    const summary = await deps.store.summary(queryContext(deps.config));
    const idx = deps.index.status();
    const failures = idx.indexFailures?.length ?? 0;
    const response: SummaryResponse = {
      ...summary,
      indexing: idx.indexing,
      ...(idx.error ? { indexError: idx.error } : {}),
      ...(failures > 0 ? { indexFailureCount: failures } : {}),
      lastIndexedAt: idx.lastIndexedAt,
    };
    return c.json(response);
  });

  app.get('/tools', async (c) => {
    const query = parseQuery(c, rangeQuerySchema);
    if (!query.ok) return query.response;
    return c.json(await deps.store.toolsAnalytics(query.data, queryContext(deps.config)));
  });

  app.get('/models', async (c) => {
    const query = parseQuery(c, rangeQuerySchema);
    if (!query.ok) return query.response;
    return c.json(await deps.store.modelsAnalytics(query.data, queryContext(deps.config)));
  });

  app.get('/hooks', async (c) => {
    const query = parseQuery(c, rangeQuerySchema);
    if (!query.ok) return query.response;
    return c.json(await deps.store.hooksAnalytics(query.data, queryContext(deps.config)));
  });

  app.get('/attribution', async (c) => {
    const query = parseQuery(c, rangeQuerySchema);
    if (!query.ok) return query.response;
    return c.json(await deps.store.attributionAnalytics(query.data, queryContext(deps.config)));
  });

  app.get('/insights', async (c) => {
    const query = parseQuery(c, rangeQuerySchema);
    if (!query.ok) return query.response;
    return c.json(await deps.store.insights(query.data, queryContext(deps.config)));
  });

  return app;
}
