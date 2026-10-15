import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  CHECK_REQUIRES,
  createdTables,
  DEPLOY_GATES,
  MIGRATION_CHECKS,
  parseMigrationFile,
  planMigrations,
  sessionConnectionString,
  sortMigrations,
  stripSqlComments,
  supabaseProjectRef,
  touchedTables,
  transactionMode,
  type DbState,
  type MigrationFile,
} from "./migration-plan.ts";

const DIR = new URL("../supabase/migrations/", import.meta.url);
const real = sortMigrations(
  readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => parseMigrationFile(f, readFileSync(new URL(f, DIR), "utf8")))
    .filter((m): m is MigrationFile => !!m),
);
const file = (version: string, sql = "", name = "x"): MigrationFile => parseMigrationFile(`${version}_${name}.sql`, sql)!;
const state = (over: Partial<DbState> = {}): DbState => ({
  recorded: null,
  checks: new Map(),
  existingTables: new Set(),
  ...over,
});

test("every migration file parses, in order, and two files may share a version", () => {
  const names = readdirSync(DIR).filter((f) => f.endsWith(".sql"));
  assert.equal(real.length, names.length, "a file isn't named NNNN_name.sql");
  for (let i = 1; i < real.length; i++) assert.ok(real[i - 1].num <= real[i].num);
  assert.equal(real.filter((m) => m.version === "0071").length, 2);
  assert.equal(parseMigrationFile("README.md", ""), null);
  assert.equal(parseMigrationFile("101_x.sql", ""), null);
});

test("the verify queries match docs/migrations-2026-10.md exactly", () => {
  const doc = readFileSync(new URL("../docs/migrations-2026-10.md", import.meta.url), "utf8");
  const verify = doc.slice(doc.indexOf("## Verify"));
  const block = verify.slice(verify.indexOf("```sql") + 6, verify.indexOf("```", verify.indexOf("```sql") + 6));
  const fromDoc: Record<string, string> = {};
  for (const part of block.split(/^-- (\d{4})\s*$/m).slice(1).reduce<string[][]>((acc, x, i) => {
    if (i % 2 === 0) acc.push([x]);
    else acc[acc.length - 1].push(x);
    return acc;
  }, [])) {
    fromDoc[part[0]] = part[1].trim();
  }
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  assert.deepEqual(Object.keys(MIGRATION_CHECKS).sort(), Object.keys(fromDoc).sort());
  for (const [v, sql] of Object.entries(MIGRATION_CHECKS)) assert.equal(norm(sql), norm(fromDoc[v]), `check ${v} drifted from the doc`);
  // Every check, requirement and gate names a migration that exists.
  for (const v of [...Object.keys(MIGRATION_CHECKS), ...Object.keys(CHECK_REQUIRES), ...Object.keys(DEPLOY_GATES)]) {
    assert.ok(real.some((m) => m.version === v), `no migration file for ${v}`);
  }
});

test("comments never count, strings do", () => {
  assert.equal(stripSqlComments("select 1; -- create table x\nselect 2;").includes("create table"), false);
  assert.equal(stripSqlComments("/* drop table x */ select 1").includes("drop"), false);
  assert.ok(stripSqlComments("select '-- not a comment'").includes("-- not a comment"));
  assert.ok(stripSqlComments("select 'it''s -- fine' -- gone").includes("it''s -- fine"));
});

test("created tables: public only, quoted names, no temp tables, no comments", () => {
  assert.deepEqual(
    createdTables(`
      create table if not exists public.alpha (id int);
      create table "Beta" (id int);
      create unlogged table public.gamma (id int);
      create table storage.other (id int);
      create temp table scratch (id int);
      -- create table public.commented (id int);
    `).sort(),
    ["alpha", "beta", "gamma"],
  );
  const chat = real.find((m) => m.version === "0101")!;
  for (const t of ["chat_channels", "chat_members", "chat_messages", "chat_message_revisions", "chat_reports", "chat_blocks"]) {
    assert.ok(createdTables(chat.sql).includes(t), t);
  }
});

test("how each file runs: one transaction unless it manages its own or needs CONCURRENTLY", () => {
  assert.equal(transactionMode("create table a (id int);"), "wrap");
  assert.equal(transactionMode("begin;\ncreate table a (id int);\ncommit;"), "own");
  assert.equal(transactionMode("create index concurrently i on a (id);"), "none");
  // plpgsql's BEGIN … END; is not a transaction.
  assert.equal(transactionMode("do $$ begin\n perform 1;\nend $$;"), "wrap");
  assert.equal(transactionMode("-- begin;\n-- commit;\nselect 1;"), "wrap");
  // The October files — the ones a production database can still be missing — all run atomically.
  for (const m of real.filter((m) => m.num >= 93)) assert.equal(transactionMode(m.sql), "wrap", m.file);
});

test("what a file removes or rewrites gets snapshotted first", () => {
  assert.deepEqual(
    touchedTables(`
      drop table if exists public.old_a;
      alter table public.profiles drop column if exists discord_user_id, drop column if exists x;
      alter table only public.teams add column y int, drop column z;
      update public.lessons set title = 'x' where true;
      update public.app_roles r set permissions = '{}';
      delete from public.site_settings where key like 'discord%';
      delete from storage.objects where false;
      alter table public.kept add column w int;
    `).sort(),
    ["app_roles", "lessons", "old_a", "profiles", "site_settings", "teams"],
  );
  const chat = real.find((m) => m.version === "0101")!;
  const touched = touchedTables(chat.sql);
  for (const t of ["profiles", "teams", "app_roles", "site_settings", "oh_queue", "event_rsvps"]) assert.ok(touched.includes(t), t);
});

test("plan: recorded, verified, and 'a later one ran' are applied; the rest is pending, in order", () => {
  const files = [
    file("0001", "create table public.a (id int);"),
    file("0002", "alter table public.a add column b int;"), // no tables of its own
    file("0003", "create table public.c (id int);"),
    file("0004", "create table public.d (id int);"),
  ];
  // Fresh database: everything is pending.
  assert.deepEqual(planMigrations(files, state()).map((p) => p.status), ["pending", "pending", "pending", "pending"]);
  // 0003's table exists: 0001–0003 ran (in order), 0004 hasn't.
  const p = planMigrations(files, state({ existingTables: new Set(["a", "c"]) }));
  assert.deepEqual(p.map((x) => x.status), ["unrecorded", "unrecorded", "unrecorded", "pending"]);
  assert.equal(p[1].why, "a later migration has run");
  assert.equal(p[0].why, "every table it creates exists");
  // Recorded wins.
  assert.equal(planMigrations(files, state({ recorded: new Set(["0004"]) }))[3].status, "applied");
});

test("plan: a verify query decides for its own migration, both ways, even out of order", () => {
  const files = [file("0093", "create table public.course_assignments (id int);"), file("0095", ""), file("0096", ""), file("0101", "")];
  const checks = new Map([
    ["0093", false],
    ["0095", true],
    ["0096", true],
    ["0101", false],
  ]);
  // 0095/0096 ran before the deploy, 0093 and 0101 didn't: the later evidence doesn't paper over 0093.
  assert.deepEqual(planMigrations(files, state({ checks })).map((p) => p.status), ["pending", "unrecorded", "unrecorded", "pending"]);
  // A table existing doesn't count for a file with a verify query: only the query does.
  assert.equal(planMigrations(files, state({ checks, existingTables: new Set(["course_assignments"]) }))[0].status, "pending");
});

test("plan: tables a later migration dropped don't make an old file pending again", () => {
  const files = [file("0033", "create table public.oh_queue (id int);"), file("0101", "drop table public.oh_queue;")];
  const p = planMigrations(files, state({ checks: new Map([["0101", true]]), existingTables: new Set(["profiles", "app_roles"]) }));
  assert.deepEqual(p.map((x) => x.status), ["unrecorded", "unrecorded"]);
});

test("plan: an absence check on tables that don't exist yet proves nothing", () => {
  // A fresh database: 0097's "no write policy left on the call tables" is
  // true because there are no call tables. It must not count.
  const files = [file("0005", "create table public.call_invites (id int);"), file("0097", ""), file("0099", "")];
  const checks = new Map([
    ["0097", true],
    ["0099", true],
  ]);
  const p = planMigrations(files, state({ checks }));
  assert.deepEqual(p.map((x) => x.status), ["pending", "pending", "pending"]);
  assert.match(p[1].why, /can't tell yet \(call_invites, interview_requests, mentor_bookings, mentor_slots missing\)/);
});

/** Roughly production: every table the files up to 0100 create exists. */
function productionTables(upTo: number): Set<string> {
  return new Set(real.filter((m) => m.num <= upTo).flatMap((m) => createdTables(m.sql)));
}

test("plan against the real files: a production database that has everything but 0101", () => {
  const checks = new Map(Object.keys(MIGRATION_CHECKS).map((v) => [v, v !== "0101"] as [string, boolean]));
  const plan = planMigrations(real, state({ checks, existingTables: productionTables(100) }));
  assert.deepEqual(plan.filter((p) => p.status === "pending").map((p) => p.version), ["0101"]);
  assert.equal(plan.filter((p) => p.status === "unrecorded").length, real.length - 1);
});

test("plan against the real files: an empty database needs every file", () => {
  const checks = new Map(Object.keys(MIGRATION_CHECKS).map((v) => [v, ["0097", "0099"].includes(v)] as [string, boolean]));
  const plan = planMigrations(real, state({ checks }));
  assert.equal(plan.filter((p) => p.status === "pending").length, real.length);
});

test("project refs and the session port", () => {
  const ref = "abcdefghijklmnopqrst";
  assert.equal(supabaseProjectRef(`https://${ref}.supabase.co`), ref);
  assert.equal(supabaseProjectRef(`postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres`), ref);
  assert.equal(supabaseProjectRef(`postgresql://postgres.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`), ref);
  assert.equal(supabaseProjectRef("postgresql://u:p@localhost:5432/db"), null);
  assert.equal(supabaseProjectRef("not a url"), null);
  assert.equal(supabaseProjectRef(undefined), null);
  const moved = sessionConnectionString(`postgresql://postgres.${ref}:p%40ss@aws-0-us-east-1.pooler.supabase.com:6543/postgres`);
  assert.equal(moved.changed, true);
  assert.equal(new URL(moved.url).port, "5432");
  assert.equal(new URL(moved.url).password, "p%40ss", "the password survives untouched");
  assert.equal(sessionConnectionString(`postgresql://postgres:p@db.${ref}.supabase.co:5432/postgres`).changed, false);
});
