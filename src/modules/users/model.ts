import { parseJson } from '../../lib/db';
import { directionFor, type Direction, type Locale } from '../../lib/i18n';
import { iso } from '../../lib/time';

export type UserStatus = 'active' | 'suspended' | 'deactivated' | 'deleted';
export type PlatformRole = 'user' | 'support' | 'admin' | 'superadmin';

export interface UserRow {
  id: string;
  email: string;
  email_normalized: string;
  email_verified_at: number | null;
  name: string;
  status: UserStatus;
  platform_role: PlatformRole;
  locale: Locale;
  direction: Direction | null;
  time_zone: string;
  accessibility_json: string;
  preferences_json: string;
  history_enabled: number;
  history_consent_at: number | null;
  history_consent_version: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface Accessibility {
  reduceMotion?: boolean;
  highContrast?: boolean;
  largeText?: boolean;
  captions?: boolean;
}

export interface Preferences {
  defaultMode?: 'sign' | 'emoji';
  playbackSpeed?: 0.5 | 0.75 | 1 | 1.25 | 1.5;
  emojiStyle?: 'minimal' | 'standard' | 'expressive';
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase().normalize('NFKC');

/** The shape returned to the account owner. Never includes credentials or internal flags. */
export function toSelfView(u: UserRow) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    emailVerified: u.email_verified_at !== null,
    status: u.status,
    locale: u.locale,
    direction: u.direction ?? directionFor(u.locale),
    directionSource: u.direction ? 'explicit' : 'derived',
    timeZone: u.time_zone,
    accessibility: parseJson<Accessibility>(u.accessibility_json, {}),
    preferences: parseJson<Preferences>(u.preferences_json, {}),
    privacy: {
      historyEnabled: u.history_enabled === 1,
      historyConsentAt: iso(u.history_consent_at),
    },
    isPlatformStaff: u.platform_role !== 'user',
    createdAt: iso(u.created_at),
    updatedAt: iso(u.updated_at),
  };
}

/** The shape returned to platform staff. Account metadata only. */
export function toAdminView(u: UserRow) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    emailVerified: u.email_verified_at !== null,
    status: u.status,
    platformRole: u.platform_role,
    locale: u.locale,
    createdAt: iso(u.created_at),
    updatedAt: iso(u.updated_at),
    deletedAt: iso(u.deleted_at),
  };
}
