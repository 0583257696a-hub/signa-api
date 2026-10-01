import type { Services } from './context';
import { run } from './lib/db';
import { DAY } from './lib/time';
import { reconcileSubscriptions } from './modules/billing/service';
import { sweepJobs } from './modules/sign/jobs';

export const AUDIT_RETENTION = 365 * DAY;
export const METRICS_RETENTION = 90 * DAY;
export const USAGE_EVENT_RETENTION = 400 * DAY;

/** Scheduled maintenance. Every step is independent so one failure does not block the rest. */
export async function runMaintenance(svc: Services, cron: string): Promise<Record<string, unknown>> {
  const now = svc.now();
  const results: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      results[name] = await fn();
    } catch (e) {
      results[name] = 'failed';
      svc.logger.log('error', 'maintenance_step_failed', { step: name, errorCode: e instanceof Error ? e.name : 'unknown' });
    }
  };
  await step('jobs', () => sweepJobs(svc));
  await step('subscriptions', () => reconcileSubscriptions(svc));
  await step('sessions', () => run(svc.db, 'DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', now - DAY, now - 30 * DAY));
  await step('oneTimeTokens', () => run(svc.db, 'DELETE FROM one_time_tokens WHERE expires_at < ?', now - DAY));
  await step('oauthStates', () => run(svc.db, 'DELETE FROM oauth_states WHERE expires_at < ?', now));
  await step('rateLimits', () => run(svc.db, 'DELETE FROM rate_limits WHERE expires_at < ?', now));
  await step('uploadGrants', () => run(svc.db, 'DELETE FROM asset_upload_grants WHERE expires_at < ?', now - DAY));
  await step('invitations', () => run(svc.db, 'DELETE FROM organization_invitations WHERE accepted_at IS NULL AND expires_at < ?', now - 30 * DAY));
  await step('metrics', () => run(svc.db, 'DELETE FROM ops_metrics WHERE bucket < ?', new Date(now - METRICS_RETENTION).toISOString().slice(0, 13)));
  await step('audit', () => run(svc.db, 'DELETE FROM audit_events WHERE created_at < ?', now - AUDIT_RETENTION));
  await step('usageEvents', () => run(svc.db, 'DELETE FROM usage_events WHERE created_at < ?', now - USAGE_EVENT_RETENTION));
  svc.logger.log('info', 'maintenance_completed', { cron });
  return results;
}
