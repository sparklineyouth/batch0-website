import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { parseMigrationFile, planMigrations, type MigrationFile } from "./migration-plan.ts";
import {
  applyMigration,
  applyWithRetry,
  ensureHistory,
  historyColumns,
  isLockTimeout,
  MigrationError,
  migrationName,
  readState,
  recordVersion,
  type Db,
} from "./migration-runner.ts";

/**
 * The runner against a real (embedded) Postgres: one transaction per file,
 * the verify query checked before COMMIT, history recorded the way the
 * Supabase CLI does, and a failure leaving nothing behind.
 */

function adapter(pg: PGlite): Db {
  return {
    async query(sql, params) {
      if (params) return pg.query(sql, params);
      const results = await pg.exec(sql);
      return { rows: results[results.length - 1]?.rows ?? [] };
    },
  };
}

async function setup(withHistory = true) {
  const pg = new PGlite();
  if (withHistory) {
    await pg.exec(`
      create schema supabase_migrations;
      create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
    `);
  }
  return { pg, db: adapter(pg) };
}

const m = (version: string, sql: string, name = "test"): MigrationFile => parseMigrationFile(`${version}_${name}.sql`, sql)!;
const tableExists = async (pg: PGlite, t: string) =>
  (await pg.query<{ ok: boolean }>(`select to_regclass('public.${t}') is not null as ok`)).rows[0].ok;
const recorded = async (pg: PGlite) =>
  (await pg.query<{ version: string; name: string }>(`select version, name from supabase_migrations.schema_migrations order by version`)).rows;

test("a file runs whole and is recorded like `supabase db push` would", async () => {
  const { pg, db } = await setup();
  const file = m("0001", "create table public.a (id int); insert into public.a values (1), (2);", "first");
  await applyMigration(db, file, { history: await historyColumns(db) });
  assert.equal((await pg.query<{ n: number }>("select count(*)::int as n from public.a")).rows[0].n, 2);
  assert.deepEqual(await recorded(pg), [{ version: "0001", name: "first" }]);
  assert.equal(migrationName("0101_chat.sql"), "chat");
});

test("an error part-way rolls the whole file back and records nothing", async () => {
  const { pg, db } = await setup();
  const bad = m("0002", "create table public.b (id int); insert into public.b values (1); select * from public.nope;");
  await assert.rejects(applyMigration(db, bad, { history: await historyColumns(db) }), (err: unknown) => {
    assert.ok(err instanceof MigrationError);
    assert.equal(err.rolledBack, true);
    assert.match(err.message, /0002_test\.sql failed and was rolled back.*nope/);
    return true;
  });
  assert.equal(await tableExists(pg, "b"), false);
  assert.deepEqual(await recorded(pg), []);
  // The session is usable afterwards.
  await applyMigration(db, m("0003", "create table public.c (id int);"), { history: await historyColumns(db) });
  assert.equal(await tableExists(pg, "c"), true);
});

test("a file that runs but leaves its verify query failing is rolled back too", async () => {
  const { pg, db } = await setup();
  await pg.exec(`
    create table public.app_roles (slug text primary key, permissions text[] not null default '{}');
    insert into public.app_roles values ('intern', array['ai_usage.view']);
  `);
  // 0100's verify query: no role holds ai_usage.view.
  const wrong = m("0100", "create table public.marker (id int);", "admin_cleanup");
  await assert.rejects(applyMigration(db, wrong, { history: await historyColumns(db) }), /verify query still fails/);
  assert.equal(await tableExists(pg, "marker"), false);
  assert.deepEqual(await recorded(pg), []);
  const right = m("0100", "update public.app_roles set permissions = array_remove(permissions, 'ai_usage.view');", "admin_cleanup");
  await applyMigration(db, right, { history: await historyColumns(db) });
  assert.deepEqual(await recorded(pg), [{ version: "0100", name: "admin_cleanup" }]);
});

test("reading state: history, tables, and verify queries that hit missing objects mean 'not yet'", async () => {
  const { pg, db } = await setup();
  await pg.exec(`
    insert into supabase_migrations.schema_migrations (version) values ('0001');
    create table public.a (id int);
    create table public.app_roles (slug text primary key, permissions text[] not null default '{}');
  `);
  const files = [m("0001", "create table public.a (id int);"), m("0093", ""), m("0095", ""), m("0100", ""), m("0101", "")];
  const s = await readState(db, files);
  assert.deepEqual([...s.recorded!], ["0001"]);
  assert.ok(s.existingTables.has("a"));
  // 0095 reads storage.buckets (no storage schema here), 0101 reads public.chat_channels: errors → false.
  assert.equal(s.checks.get("0095"), false);
  assert.equal(s.checks.get("0101"), false);
  assert.equal(s.checks.get("0093"), false);
  assert.equal(s.checks.get("0100"), true, "nobody holds ai_usage.view");
  // ...which proves nothing: an absence check never counts on its own.
  assert.deepEqual(
    planMigrations(files, s).map((p) => [p.version, p.status]),
    [
      ["0001", "applied"],
      ["0093", "pending"],
      ["0095", "pending"],
      ["0100", "pending"],
      ["0101", "pending"],
    ],
  );
});

test("without the CLI's history table nothing is recorded, and nothing breaks", async () => {
  const { pg, db } = await setup(false);
  assert.equal(await historyColumns(db), null);
  await applyMigration(db, m("0001", "create table public.a (id int);"), { history: null });
  await recordVersion(db, m("0002", ""), null);
  assert.equal(await tableExists(pg, "a"), true);
  assert.equal((await readState(db, [])).recorded, null);
});

test("a file with its own BEGIN … COMMIT runs as written", async () => {
  const { pg, db } = await setup();
  await applyMigration(db, m("0004", "begin;\ncreate table public.d (id int);\ncommit;"), { history: await historyColumns(db) });
  assert.equal(await tableExists(pg, "d"), true);
  assert.deepEqual((await recorded(pg)).map((r) => r.version), ["0004"]);
});

test("recording twice is harmless", async () => {
  const { pg, db } = await setup();
  const cols = await historyColumns(db);
  await recordVersion(db, m("0005", ""), cols);
  await recordVersion(db, m("0005", ""), cols);
  assert.equal((await recorded(pg)).length, 1);
});

test("CONCURRENTLY runs statement by statement, outside a transaction", async () => {
  const { pg, db } = await setup();
  await applyMigration(db, m("0006", "create table public.e (id int);\ncreate index concurrently e_id on public.e (id);"), { history: await historyColumns(db) });
  assert.equal((await pg.query<{ n: number }>("select count(*)::int as n from pg_indexes where indexname = 'e_id'")).rows[0].n, 1);
  assert.deepEqual((await recorded(pg)).map((r) => r.version), ["0006"]);
});

test("record: false runs the file but leaves its version unrecorded (it isn't on main yet)", async () => {
  // Recording a version production's history has but main has no file for
  // stops Supabase's integration on every push to main until that file lands.
  const { pg, db } = await setup();
  await applyMigration(db, m("9103", "create table public.f (id int);", "branch_only"), { history: await historyColumns(db), record: false });
  assert.equal(await tableExists(pg, "f"), true);
  await applyMigration(db, m("9104", "create table public.g (id int);\ncreate index concurrently g_id on public.g (id);"), { history: await historyColumns(db), record: false });
  assert.equal(await tableExists(pg, "g"), true);
  assert.deepEqual(await recorded(pg), []);
});

test("a project that never had the CLI's history table gets one, in the CLI's shape", async () => {
  const { pg, db } = await setup(false);
  const cols = await ensureHistory(db);
  assert.deepEqual([...cols].sort(), ["name", "statements", "version"]);
  await ensureHistory(db); // idempotent
  await recordVersion(db, m("0001", "", "init"), cols);
  assert.deepEqual(await recorded(pg), [{ version: "0001", name: "init" }]);
});

test("only a lock timeout is retried, and only so many times", async () => {
  const lockErr = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
  assert.equal(isLockTimeout(new MigrationError("x.sql", "x", true, lockErr)), true);
  assert.equal(isLockTimeout(new MigrationError("x.sql", "x", true, new Error("syntax"))), false);
  let calls = 0;
  const flaky: Db = {
    async query(sql) {
      if (/select 1 as boom/.test(sql)) {
        calls++;
        throw lockErr;
      }
      return { rows: [] };
    },
  };
  const retries: number[] = [];
  await assert.rejects(
    applyWithRetry(flaky, m("0007", "select 1 as boom;"), { history: null, waits: [1, 1], onRetry: (n) => retries.push(n) }),
    /rolled back.*lock timeout/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(retries, [1, 2]);
});
