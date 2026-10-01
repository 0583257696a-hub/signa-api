import type { Services } from '../../context';
import { first } from '../../lib/db';
import { AppError } from '../../lib/errors';

export async function isFlagEnabled(svc: Services, key: string): Promise<boolean> {
  const row = await first<{ enabled: number }>(svc.db, 'SELECT enabled FROM feature_flags WHERE key = ?', key);
  return row?.enabled === 1;
}

export async function requireFlag(svc: Services, key: string): Promise<void> {
  if (!(await isFlagEnabled(svc, key))) throw new AppError('feature_disabled', { details: { feature: key } });
}
