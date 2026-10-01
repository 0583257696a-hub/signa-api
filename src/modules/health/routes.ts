import { Hono } from 'hono';
import type { AppEnv } from '../../context';

/**
 * Liveness (/health): the Worker is running. No dependencies are touched.
 * Readiness (/ready): required dependencies respond. Only coarse statuses are
 * returned — no versions, identifiers, error messages or configuration.
 */
export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get('/health', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ status: 'ok' });
});

healthRoutes.get('/ready', async (c) => {
  const svc = c.get('services');
  const checks: Record<string, 'ok' | 'fail' | 'not_configured'> = {};
  try {
    await svc.db.prepare('SELECT 1 AS ok').first();
    checks.database = 'ok';
  } catch {
    checks.database = 'fail';
  }
  checks.storage = svc.assetStore ? ((await svc.assetStore.ping()) ? 'ok' : 'fail') : 'not_configured';
  checks.queue = svc.jobQueue ? 'ok' : 'not_configured';
  // Only the database is required to serve traffic; the others degrade gracefully.
  const ready = checks.database === 'ok';
  c.header('Cache-Control', 'no-store');
  return c.json({ status: ready ? 'ready' : 'not_ready', checks }, ready ? 200 : 503);
});
