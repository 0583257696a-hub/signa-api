import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv, Services } from './context';
import { AppError, classifyError } from './lib/errors';
import { errorMessage } from './lib/i18n';
import { csrfProtection, loadSession, requestContext, securityHeaders } from './middleware';
import { adminRoutes } from './modules/admin/routes';
import { authRoutes } from './modules/auth/routes';
import { billingRoutes, planRoutes, usageRoutes } from './modules/billing/routes';
import { adminDictionaryRoutes, assetContentRoutes, dictionaryRoutes } from './modules/dictionary/routes';
import { emojiRoutes } from './modules/emoji/routes';
import { healthRoutes } from './modules/health/routes';
import { historyRoutes } from './modules/history/routes';
import { orgRoutes } from './modules/orgs/routes';
import { signRoutes } from './modules/sign/routes';
import { meRoutes } from './modules/users/routes';
import { buildServices } from './services';

/**
 * Creates the HTTP application. `overrides` injects fakes in tests; in production all
 * services are built from Worker bindings.
 */
export function createApp(overrides: Partial<Services> = {}) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('services', buildServices(c.env, overrides));
    await next();
  });
  app.use('*', requestContext);
  app.use('*', securityHeaders);
  app.use('/api/*', async (c, next) => {
    const svc = c.get('services');
    const origins = new Set([svc.config.APP_BASE_URL, ...svc.config.CORS_ALLOWED_ORIGINS].map((o) => o.replace(/\/+$/, '')));
    return cors({
      origin: (origin) => (origins.has(origin) ? origin : null),
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'X-Organization-Id', 'X-Upload-Token', 'Accept-Language'],
      exposeHeaders: ['X-Request-Id', 'Retry-After'],
      maxAge: 600,
    })(c, next);
  });
  app.use('/api/*', loadSession);
  app.use('/api/*', csrfProtection);

  app.route('/', healthRoutes);
  const v1 = new Hono<AppEnv>();
  v1.route('/auth', authRoutes);
  v1.route('/me', meRoutes);
  v1.route('/organizations', orgRoutes);
  v1.route('/plans', planRoutes);
  v1.route('/usage', usageRoutes);
  v1.route('/billing', billingRoutes);
  v1.route('/emoji', emojiRoutes);
  v1.route('/sign', signRoutes);
  v1.route('/history', historyRoutes);
  v1.route('/dictionary', dictionaryRoutes);
  v1.route('/assets', assetContentRoutes);
  v1.route('/admin/dictionary', adminDictionaryRoutes);
  v1.route('/admin', adminRoutes);
  app.route('/api/v1', v1);

  app.notFound((c) => {
    const locale = c.get('locale') ?? 'he';
    c.header('X-Error-Code', 'not_found');
    return c.json({ error: { code: 'not_found', message: errorMessage('not_found', locale) }, meta: { requestId: c.get('requestId') ?? null } }, 404);
  });

  app.onError((err, c) => {
    const locale = c.get('locale') ?? 'he';
    const requestId = c.get('requestId') ?? null;
    const appErr = err instanceof AppError ? err : new AppError('internal_error');
    if (!(err instanceof AppError) || appErr.status >= 500) {
      // Log the error class and name only. Messages may contain data, so internal errors log `name` only.
      c.get('services')?.logger.log('error', 'request_error', {
        requestId,
        route: c.req.routePath,
        errorCode: appErr.code,
        errorClass: classifyError(appErr.code),
        errorName: err instanceof Error ? err.name : 'unknown',
        diagnostic: err instanceof AppError ? err.message.slice(0, 120) : undefined,
      });
    }
    for (const [k, v] of Object.entries(appErr.headers ?? {})) c.header(k, v);
    c.header('X-Error-Code', appErr.code);
    return c.json(
      {
        error: {
          code: appErr.code,
          class: classifyError(appErr.code),
          message: errorMessage(appErr.code, locale),
          ...(appErr.details ? { details: appErr.details } : {}),
        },
        meta: { requestId },
      },
      appErr.status as 400,
    );
  });

  return app;
}
