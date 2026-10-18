/**
 * The database half of `npm run db:migrate` (scripts/db-migrate.mts): read
 * what a database has, and run one migration file all-or-nothing. Talks to
 * Postgres through a two-method adapter, so lib/migration-runner.test.ts
 * drives it with PGlite and the script with node-postgres.
 */
import {
  MIGRATION_CHECKS,
  MISSING_OBJECT_CODES,
  splitStatements,
  transactionMode,
  type DbState,
  type MigrationFile,
} from "./migration-plan.ts";

export type Db = {
  /** One statement with $1… params, or (no params) any number of statements; the last result's rows. */
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
};

const HISTORY = "supabase_migrations.schema_migrations";

/**
 * Create the Supabase CLI's history table when it's missing (a project that
 * was only ever migrated in the SQL editor), with the CLI's own shape, so
 * what this run records is what `supabase migration list` reads.
 */
export async function ensureHistory(db: Db): Promise<Set<string>> {
  await db.query(`
    create schema if not exists supabase_migrations;
    create table if not exists ${HISTORY} (version text not null primary key);
    alter table ${HISTORY} add column if not exists statements text[];
    alter table ${HISTORY} add column if not exists name text;
  `);
  return (await historyColumns(db)) ?? new Set(["version"]);
}

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

/** Postgres gave up waiting for a lock (lock_timeout): worth trying again shortly. */
export function isLockTimeout(err: unknown): boolean {
  const e = (err instanceof MigrationError ? (err.cause as { code?: string } | undefined) : (err as { code?: string })) ?? {};
  return e.code === "55P03";
}

/**
 * Run one file. By default inside one transaction with its verify query (when
 * it has one) checked before COMMIT: any error or a failing check rolls the
 * whole file back and nothing of it stays. A file that runs its own
 * transaction runs as written; one that uses CONCURRENTLY runs statement by
 * statement. Either way a failure can leave part of it applied, and the
 * error says so.
 *
 * `record: false` runs it without recording it: a file that isn't on main
 * yet (versionsNotOnMain in lib/migration-plan.ts). Supabase's integration
 * runs it again and records it once it lands there.
 *
 * The lock wait is short on purpose: while a migration waits for a lock on a
 * busy table (profiles), every request that needs that table queues behind
 * it. Better to give up after a few seconds and try again (runWithRetry).
 */
export async function applyMigration(
  db: Db,
  m: MigrationFile,
  opts: { history: Set<string> | null; record?: boolean; statementTimeout?: string; lockTimeout?: string },
): Promise<void> {
  const check = MIGRATION_CHECKS[m.version];
  const record = opts.record ?? true;
  const mode = transactionMode(m.sql);
  const timeouts = `set statement_timeout = '${opts.statementTimeout ?? "15min"}'; set lock_timeout = '${opts.lockTimeout ?? "4s"}'`;
  if (mode === "wrap") {
    await db.query("begin");
    try {
      await db.query(timeouts.replace(/set /g, "set local "));
      await db.query(m.sql);
      if (check && !(await runCheck(db, check, { inTransaction: true }))) {
        throw new MigrationError(m.file, `${m.file} ran, but its verify query still fails`, true);
      }
      if (record) await recordVersion(db, m, opts.history);
      await db.query("commit");
    } catch (err) {
      await db.query("rollback").catch(() => undefined);
      if (err instanceof MigrationError) throw err;
      throw new MigrationError(m.file, `${m.file} failed and was rolled back: ${describeError(err)}`, true, err);
    }
    return;
  }
  try {
    await db.query(timeouts);
    if (mode === "own") await db.query(m.sql);
    else for (const statement of splitStatements(m.sql)) await db.query(statement);
  } catch (err) {
    throw new MigrationError(
      m.file,
      `${m.file} failed part-way (it runs outside a single transaction, so some of it may have applied): ${describeError(err)}`,
      false,
      err,
    );
  } finally {
    await db.query("reset statement_timeout; reset lock_timeout").catch(() => undefined);
  }
  if (check && !(await runCheck(db, check))) {
    throw new MigrationError(m.file, `${m.file} ran, but its verify query still fails`, false);
  }
  if (record) await recordVersion(db, m, opts.history);
}

/**
 * applyMigration, again after a lock timeout (rolled back, so nothing
 * applied): 3 tries, waiting 5s then 15s between them. Anything else fails at once.
 */
export async function applyWithRetry(
  db: Db,
  m: MigrationFile,
  opts: Parameters<typeof applyMigration>[2] & { waits?: number[]; onRetry?: (attempt: number, waitMs: number) => void },
): Promise<void> {
  const waits = opts.waits ?? [5_000, 15_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await applyMigration(db, m, opts);
    } catch (err) {
      const retriable = err instanceof MigrationError && err.rolledBack && isLockTimeout(err);
      if (!retriable || attempt >= waits.length) throw err;
      opts.onRetry?.(attempt + 1, waits[attempt]);
      await new Promise((r) => setTimeout(r, waits[attempt]));
    }
  }
}

export function describeError(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const e = err as { message?: string; code?: string; detail?: string; hint?: string; where?: string; position?: string };
  return [e.message, e.code && `(${e.code})`, e.detail && `detail: ${e.detail}`, e.hint && `hint: ${e.hint}`, e.where && `where: ${e.where}`]
    .filter(Boolean)
    .join(" ");
}
