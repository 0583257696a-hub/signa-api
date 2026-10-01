export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Monthly usage period in UTC, e.g. "2026-10". */
export function utcPeriod(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Start (inclusive) and end (exclusive) of the UTC month containing `ms`. */
export function utcPeriodBounds(ms: number): { start: number; end: number } {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start, end };
}

/** Hourly metric bucket in UTC, e.g. "2026-10-01T13". */
export function hourBucket(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13);
}

export const iso = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();
