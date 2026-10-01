/** Thin typed helpers over D1. All SQL uses bound parameters — never string interpolation of input. */
export type SqlParam = string | number | null | boolean;

const norm = (p: SqlParam[]): (string | number | null)[] =>
  p.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v));

export async function first<T>(db: D1Database, sql: string, ...params: SqlParam[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...norm(params)).first<T>()) ?? null;
}

export async function all<T>(db: D1Database, sql: string, ...params: SqlParam[]): Promise<T[]> {
  const r = await db.prepare(sql).bind(...norm(params)).all<T>();
  return r.results ?? [];
}

/** Executes a write and returns the number of changed rows. */
export async function run(db: D1Database, sql: string, ...params: SqlParam[]): Promise<number> {
  const r = await db.prepare(sql).bind(...norm(params)).run();
  return r.meta?.changes ?? 0;
}

export function stmt(db: D1Database, sql: string, ...params: SqlParam[]): D1PreparedStatement {
  return db.prepare(sql).bind(...norm(params));
}

/** Executes statements atomically (D1 batches run inside a single transaction). */
export async function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<number[]> {
  if (statements.length === 0) return [];
  const results = await db.batch(statements);
  return results.map((r) => r.meta?.changes ?? 0);
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Error && /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|constraint failed: UNIQUE/i.test(e.message);
