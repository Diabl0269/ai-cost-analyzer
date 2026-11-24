/** `GET/PUT /api/settings` */
import { Hono } from 'hono';
import { userSettingsSchema } from '../../core/settings.js';
import type { AppDeps } from '../deps.js';
import { badRequest } from '../errors.js';
import { validateRoots } from '../rootsPolicy.js';
import { parseJsonBody } from '../validate.js';

export function settingsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(deps.config.get().settings));

  app.put('/', async (c) => {
    const body = await parseJsonBody(c, userSettingsSchema);
    if (!body.ok) return body.response;
    // zod only checks shape ("non-empty strings"); roots also carry a filesystem-meaning policy
    // (existing directories only, no sensitive locations) that a schema can't express. Never
    // echo the offending path back (SPEC §7.2/§5: errors never include request input).
    const rootsCheck = validateRoots(body.data.roots, deps.ccaHome, deps.config.get().settings.roots);
    if (!rootsCheck.ok) {
      const reasons = new Set(rootsCheck.violations.map((v) => v.reason));
      const parts: string[] = [];
      if (reasons.has('not_a_directory')) parts.push('point at a directory that does not exist');
      if (reasons.has('sensitive_location')) parts.push('point at a disallowed system or credential location');
      return badRequest(c, `one or more roots ${parts.join(', or ')}`);
    }
    const updated = deps.config.updateSettings(body.data);
    deps.sse.broadcast({ type: 'settingsChanged' });
    return c.json(updated);
  });

  return app;
}
