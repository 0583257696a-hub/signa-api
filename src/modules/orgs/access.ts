import type { Services } from '../../context';
import { first } from '../../lib/db';
import { AppError } from '../../lib/errors';

export type OrgRole = 'owner' | 'admin' | 'member';

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'deleted';
  default_locale: 'he' | 'en';
  settings_json: string;
  created_by: string | null;
  suspended_at: number | null;
  suspended_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface Membership {
  organization: OrganizationRow;
  role: OrgRole;
}

const RANK: Record<OrgRole, number> = { member: 1, admin: 2, owner: 3 };

/**
 * Tenant boundary check. Returns the caller's membership or throws `not_found`
 * (not `forbidden`) so that outsiders cannot probe which organization IDs exist.
 */
export async function requireMembership(
  svc: Services,
  userId: string,
  organizationId: string,
  minRole: OrgRole = 'member',
  opts: { allowSuspended?: boolean } = {},
): Promise<Membership> {
  const row = await first<OrganizationRow & { member_role: OrgRole }>(
    svc.db,
    `SELECT o.*, m.role AS member_role FROM organizations o
       JOIN organization_members m ON m.organization_id = o.id
      WHERE o.id = ? AND m.user_id = ? AND o.status <> 'deleted'`,
    organizationId,
    userId,
  );
  if (!row) throw new AppError('not_found');
  const { member_role, ...organization } = row;
  if (RANK[member_role] < RANK[minRole]) throw new AppError('forbidden');
  if (organization.status === 'suspended' && !opts.allowSuspended) throw new AppError('organization_suspended');
  return { organization, role: member_role };
}

export const roleAtLeast = (role: OrgRole, min: OrgRole) => RANK[role] >= RANK[min];
