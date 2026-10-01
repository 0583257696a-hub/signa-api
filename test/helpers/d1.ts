import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/**
 * Minimal D1Database implementation over Node's built-in SQLite, used to run the
 * real migrations and SQL in tests (D1 is SQLite). Batches run in a transaction,
 * mirroring D1's atomic batch semantics.
 */
type Param = string | number | null;

class Stmt {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: Param[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : (p as Param))));
  }
  private prepared(): StatementSync {
    return this.db.prepare(this.sql);
  }
  async first<T>(col?: string): Promise<T | null> {
    const row = this.prepared().get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T>() {
    return this.exec<T>();
  }
  async run<T>() {
    return this.exec<T>();
  }
  exec<T>() {
    const s = this.prepared();
    if (/\breturning\b/i.test(this.sql) || /^\s*select/i.test(this.sql)) {
      const rows = s.all(...this.params).map((r) => ({ ...(r as object) })) as T[];
      return { results: rows, success: true, meta: { changes: /^\s*select/i.test(this.sql) ? 0 : rows.length } };
    }
    const r = s.run(...this.params);
    return { results: [] as T[], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async raw() {
    return this.prepared().all(...this.params).map((r) => Object.values(r as object));
  }
}

export class TestD1 {
  readonly db: DatabaseSync;
  failNext: RegExp | null = null;
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON;');
    const dir = join(__dirname, '..', '..', 'migrations');
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) this.db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  prepare(sql: string) {
    return new Stmt(this.db, sql);
  }
  async batch(stmts: Stmt[]) {
    this.db.exec('BEGIN');
    try {
      const out = stmts.map((s) => s.exec());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async exec(sql: string) {
    this.db.exec(sql);
    return { count: 1, duration: 0 };
  }
  /** Direct synchronous query helper for assertions. */
  q<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[] {
    return this.db.prepare(sql).all(...params).map((r) => ({ ...(r as object) })) as T[];
  }
}
