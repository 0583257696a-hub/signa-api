import type { Services } from '../../context';
import { newId } from '../../lib/crypto';
import { run } from '../../lib/db';

export interface AuditInput {
  action: string;
  outcome?: 'success' | 'denied' | 'failure';
  requestId?: string | null;
  actorUserId?: string | null;
  actorRole?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  organizationId?: string | null;
  /** Identifiers and enum values only. Never content, credentials or tokens. */
  metadata?: Record<string, string | number | boolean | null>;
}

const FORBIDDEN_META = /pass|secret|token|text|body|card|cvv|cookie/i;

export async function audit(svc: Services, e: AuditInput): Promise<void> {
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(e.metadata ?? {})) {
    if (!FORBIDDEN_META.test(k)) metadata[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  }
  await run(
    svc.db,
    `INSERT INTO audit_events (id, created_at, request_id, actor_user_id, actor_role, action, target_type, target_id,
       organization_id, outcome, metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    newId('aud'),
    svc.now(),
    e.requestId ?? null,
    e.actorUserId ?? null,
    e.actorRole ?? null,
    e.action,
    e.targetType ?? null,
    e.targetId ?? null,
    e.organizationId ?? null,
    e.outcome ?? 'success',
    JSON.stringify(metadata),
  );
}
