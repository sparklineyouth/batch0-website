/**
 * The database half of `npm run db:migrate` (scripts/db-migrate.mts): read
 * what a database has, and run one migration file all-or-nothing. Talks to
 * Postgres through a two-method adapter, so lib/migration-runner.test.ts
 * drives it with PGlite and the script with node-postgres.
 */
import {
  MIGRATION_CHECKS,
  MISSING_OBJECT_CODES,
  transactionMode,
  type DbState,
  type MigrationFile,
} from "./migration-plan.ts";

export type Db = {
  /** One statement with $1… params, or (no params) any number of statements; the last result's rows. */
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
};

const HISTORY = "supabase_migrations.schema_migrations";

/** Columns of the Supabase CLI's history table, or null when there is none. */
export async function historyColumns(db: Db): Promise<Set<string> | null> {
  const exists = await db.query(`select to_regclass('${HISTORY}') is not null as ok`);
  if (!exists.rows[0]?.ok) return null;
  const cols = await db.query(
    `select column_name from information_schema.columns where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'`,
  );
  return new Set(cols.rows.map((r) => String(r.column_name)));
}

/**
 * A verify query's answer. Outside a transaction it gets its own, rolled
 * back, so a failing query can't poison the session; "that object doesn't
 * exist" means "not yet". Inside the migration's transaction any error is a
 * failure (the caller rolls the whole file back).
 */
export async function runCheck(db: Db, sql: string, opts: { inTransaction?: boolean } = {}): Promise<boolean> {
  if (opts.inTransaction) {
    const r = await db.query(sql);
    return r.rows[0]?.ok === true;
  }
  await db.query("begin");
  try {
    const r = await db.query(sql);
    return r.rows[0]?.ok === true;
  } catch (err) {
    if (MISSING_OBJECT_CODES.has((err as { code?: string })?.code ?? "")) return false;
    throw err;
  } finally {
    await db.query("rollback").catch(() => undefined);
  }
}

export async function readState(db: Db, files: readonly MigrationFile[]): Promise<DbState> {
  const cols = await historyColumns(db);
  const recorded = cols
    ? new Set((await db.query(`select version from ${HISTORY}`)).rows.map((r) => String(r.version)))
    : null;
  const existingTables = new Set(
    (await db.query(`select tablename from pg_tables where schemaname = 'public'`)).rows.map((r) => String(r.tablename)),
  );
  const checks = new Map<string, boolean>();
  for (const v of new Set(files.map((f) => f.version))) {
    const sql = MIGRATION_CHECKS[v];
    if (sql) checks.set(v, await runCheck(db, sql));
  }
  return { recorded, checks, existingTables };
}

/** "0101_chat.sql" → "chat", the CLI's `name` column. */
export function migrationName(file: string): string {
  return file.replace(/^\d+_/, "").replace(/\.sql$/, "");
}

/** Record a version the way `supabase db push` does, so `supabase migration list` agrees. */
export async function recordVersion(db: Db, m: Pick<MigrationFile, "file" | "version">, cols: Set<string> | null): Promise<void> {
  if (!cols) return;
  const fields = ["version"];
  const values: unknown[] = [m.version];
  if (cols.has("name")) {
    fields.push("name");
    values.push(migrationName(m.file));
  }
  await db.query(
    `insert into ${HISTORY} (${fields.join(", ")}) values (${values.map((_, i) => `$${i + 1}`).join(", ")}) on conflict do nothing`,
    values,
  );
}

export class MigrationError extends Error {
  readonly file: string;
  /** True when nothing from the file stayed: it ran in one transaction that was rolled back. */
  readonly rolledBack: boolean;
  constructor(file: string, message: string, rolledBack: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MigrationError";
    this.file = file;
    this.rolledBack = rolledBack;
  }
}

/**
 * Run one file. By default inside one transaction with its verify query (when
 * it has one) checked before COMMIT: any error or a failing check rolls the
 * whole file back and nothing of it stays. A file that runs its own
 * transaction, or uses CONCURRENTLY, runs as written; then a failure can
 * leave part of it applied, and the error says so.
 */
export async function applyMigration(
  db: Db,
  m: MigrationFile,
  opts: { history: Set<string> | null; statementTimeout?: string; lockTimeout?: string },
): Promise<void> {
  const check = MIGRATION_CHECKS[m.version];
  const mode = transactionMode(m.sql);
  if (mode === "wrap") {
    await db.query("begin");
    try {
      await db.query(
        `set local statement_timeout = '${opts.statementTimeout ?? "15min"}'; set local lock_timeout = '${opts.lockTimeout ?? "20s"}'`,
      );
      await db.query(m.sql);
      if (check && !(await runCheck(db, check, { inTransaction: true }))) {
        throw new MigrationError(m.file, `${m.file} ran, but its verify query still fails`, true);
      }
      await recordVersion(db, m, opts.history);
      await db.query("commit");
    } catch (err) {
      await db.query("rollback").catch(() => undefined);
      if (err instanceof MigrationError) throw err;
      throw new MigrationError(m.file, `${m.file} failed and was rolled back: ${describeError(err)}`, true, err);
    }
    return;
  }
  try {
    await db.query(m.sql);
  } catch (err) {
    throw new MigrationError(
      m.file,
      `${m.file} failed part-way (it runs outside a single transaction, so some of it may have applied): ${describeError(err)}`,
      false,
      err,
    );
  }
  if (check && !(await runCheck(db, check))) {
    throw new MigrationError(m.file, `${m.file} ran, but its verify query still fails`, false);
  }
  await recordVersion(db, m, opts.history);
}

export function describeError(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const e = err as { message?: string; code?: string; detail?: string; hint?: string; where?: string; position?: string };
  return [e.message, e.code && `(${e.code})`, e.detail && `detail: ${e.detail}`, e.hint && `hint: ${e.hint}`, e.where && `where: ${e.where}`]
    .filter(Boolean)
    .join(" ");
}
