import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  ABSENCE_CHECKS,
  addedMigrationFiles,
  CHECK_REQUIRES,
  createdTables,
  droppedTables,
  lexSql,
  splitStatements,
  DEPLOY_GATES,
  MIGRATION_CHECKS,
  parseMigrationFile,
  planMigrations,
  sessionConnectionString,
  sharedVersions,
  sortMigrations,
  stripSqlComments,
  supabaseProjectRef,
  touchedTables,
  transactionMode,
  versionConflicts,
  versionsNotOnMain,
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

test("every migration file parses, in the order the Supabase CLI applies them", () => {
  const names = readdirSync(DIR).filter((f) => f.endsWith(".sql"));
  assert.equal(real.length, names.length, "a file isn't named NNNN_name.sql");
  for (let i = 1; i < real.length; i++) assert.ok(real[i - 1].num < real[i].num);
  // The CLI applies files in directory order (by name) and compares versions
  // as strings; this sorts by number. Four digits each keeps the two the same
  // (a 00785_x.sql would run before 0079_y.sql there, after it here).
  assert.deepEqual(real.map((m) => m.file), [...names].sort());
  assert.equal(parseMigrationFile("README.md", ""), null);
  assert.equal(parseMigrationFile("101_x.sql", ""), null);
});

test("no two migration files share a version", () => {
  // Supabase records each file under its version, the history table's
  // primary key: the second file's INSERT fails and rolls it back, which
  // failed the Supabase check on every push to main from 2026-09-20 (two
  // 0071s). Give the newer file an unused number instead.
  assert.deepEqual(sharedVersions(real), [], "two files share a version");
  // That pair: scholarships kept 0071, which production's history already
  // holds for it, so 0072 still runs after it; the viewer count, which needs
  // only public.events (0005), moved into the unused 0078.
  assert.deepEqual(real.filter((m) => m.num >= 70 && m.num <= 80).map((m) => m.file), [
    "0070_demo_day_tickets.sql",
    "0071_scholarships.sql",
    "0072_scholarship_award_percent.sql",
    "0073_week1_field_guide.sql",
    "0074_scholarship_perks.sql",
    "0075_week1_intro_call.sql",
    "0076_builtin_live.sql",
    "0077_lock_profile_privileges.sql",
    "0078_event_display_viewer_count.sql",
    "0080_revenue_ledger.sql",
  ]);
  assert.deepEqual(sharedVersions([file("0071", "", "b"), file("0072"), file("0071", "", "a"), file("0003"), file("0003", "", "y")]), [
    { version: "0003", files: ["0003_x.sql", "0003_y.sql"] },
    { version: "0071", files: ["0071_a.sql", "0071_b.sql"] },
  ]);
});

test("a version is recorded only once its file is on main", () => {
  // Production's history holding a version main has no file for stops
  // Supabase's integration on every push to main ("Remote migration versions
  // not found in local migrations directory") until the file lands.
  const files = [file("0102", "", "outbox"), file("0103", "", "admin_integrity"), file("0104", "", "chat_ids")];
  const main = new Set(["0102_outbox.sql", "0104_other_name.sql"]);
  assert.deepEqual([...versionsNotOnMain(files, main)].sort(), ["0103", "0104"]);
  assert.deepEqual([...versionsNotOnMain(files, new Set(files.map((f) => f.file)))], []);
  // main unknown (git couldn't say): nothing held back.
  assert.deepEqual([...versionsNotOnMain(files, null)], []);
});

test("a pull request's new migration can't take a version main or another open pull request holds", () => {
  const added = addedMigrationFiles([
    { filename: "supabase/migrations/0108_mine.sql", status: "added" },
    { filename: "supabase/migrations/0078_event_display_viewer_count.sql", status: "renamed" },
    { filename: "supabase/migrations/0101_chat.sql", status: "modified" },
    { filename: "supabase/migrations/0050_old.sql", status: "removed" },
    { filename: "supabase/migrations/README.md", status: "added" },
    { filename: "lib/0109_not_a_migration.sql", status: "added" },
  ]);
  assert.deepEqual(added, ["0108_mine.sql", "0078_event_display_viewer_count.sql"]);
  const claims = [
    { file: "0077_lock_profile_privileges.sql", where: "main" },
    { file: "0078_event_display_viewer_count.sql", where: "#360" }, // the same file, stacked on this branch: fine
    { file: "0108_theirs.sql", where: "#361" },
    { file: "0109_later.sql", where: "#362" },
  ];
  assert.deepEqual(versionConflicts(added, claims), [{ file: "0108_mine.sql", version: "0108", claimedBy: { file: "0108_theirs.sql", where: "#361" } }]);
  assert.deepEqual(versionConflicts(["0110_free.sql"], claims), []);
  // Already on main under another name.
  assert.deepEqual(versionConflicts(["0077_again.sql"], claims).map((c) => c.claimedBy.where), ["main"]);
});

test("0078 on production (column and check, never the comment) is pending, not 'live because later files ran'", () => {
  const files = real.filter((m) => m.num <= 102);
  const recorded = new Set(files.map((f) => f.version).filter((v) => v !== "0078"));
  const checks = new Map(Object.keys(MIGRATION_CHECKS).map((v) => [v, v !== "0078"] as [string, boolean]));
  const all = new Set([...productionTables(102), "profiles", "app_roles"]);
  const plan = planMigrations(files, state({ recorded, checks, existingTables: all }));
  const notApplied = plan.filter((p) => p.status !== "applied");
  assert.deepEqual(notApplied.map((p) => [p.version, p.status, p.why]), [["0078", "pending", "its verify query fails"]]);
  // Once it has run (the comment is there), it's live, and then recorded.
  const ran = planMigrations(files, state({ recorded, checks: new Map([...checks, ["0078", true]]), existingTables: all }));
  assert.deepEqual(ran.filter((p) => p.status !== "applied").map((p) => [p.version, p.status]), [["0078", "unrecorded"]]);
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

test("plan against the real files: a production database that has everything but 0101 and 0102", () => {
  const notYet = new Set(["0101", "0102"]);
  const checks = new Map(Object.keys(MIGRATION_CHECKS).map((v) => [v, !notYet.has(v)] as [string, boolean]));
  const plan = planMigrations(real, state({ checks, existingTables: productionTables(100) }));
  // 0099 and 0100 only check for an absence, and no later file proves they
  // ran, so they run again — they're idempotent; that's the safe answer.
  assert.deepEqual(plan.filter((p) => p.status === "pending").map((p) => p.version), ["0099", "0100", "0101", "0102"]);
  assert.equal(plan.filter((p) => p.status === "gap").length, 0);
  // With 0101 and 0102 run, everything is accounted for.
  const done = planMigrations(real, state({ checks: new Map([...checks, ["0101", true], ["0102", true]]), existingTables: new Set([...productionTables(100), "profiles", "app_roles"]) }));
  assert.deepEqual(done.filter((p) => p.status !== "unrecorded" && p.status !== "applied").map((p) => p.version), []);
});

test("plan: the newest file recorded but failing its check is an earlier draft, and runs again", () => {
  // The files as they stood when 0101 was the newest.
  const files = real.filter((m) => m.num <= 101);
  const all = new Set([...productionTables(100), "profiles", "app_roles"]);
  const recorded = new Set(files.map((f) => f.version));
  const passing = new Map(Object.keys(MIGRATION_CHECKS).map((v) => [v, true] as [string, boolean]));
  // Recorded and verified: nothing to do.
  assert.deepEqual(planMigrations(files, state({ recorded, checks: passing, existingTables: all })).filter((p) => p.status !== "applied"), []);
  // 0101 recorded from an earlier draft: its check fails, so it runs again.
  const draft = planMigrations(files, state({ recorded, checks: new Map([...passing, ["0101", false]]), existingTables: all }));
  const pending = draft.filter((p) => p.status !== "applied");
  assert.deepEqual(pending.map((p) => [p.version, p.status]), [["0101", "pending"]]);
  assert.match(pending[0].why, /earlier draft/);
  // An older recorded file whose check fails is left alone: a later file may
  // have changed what it made on purpose.
  const older = planMigrations(files, state({ recorded, checks: new Map([...passing, ["0095", false]]), existingTables: all }));
  assert.deepEqual(older.filter((p) => p.status !== "applied"), []);
});

test("plan: a skipped older file is a GAP, never 'live' — its own tables decide", () => {
  // 0086 was skipped by hand; 0085 and 0087 ran. Inferring 0086 from 0087
  // would record it unrun and hide the hole forever.
  const files = [file("0085", "create table public.x (id int);"), file("0086", "create table public.y (id int);"), file("0087", "create table public.z (id int);")];
  const p = planMigrations(files, state({ existingTables: new Set(["x", "z"]) }));
  assert.deepEqual(p.map((x) => x.status), ["unrecorded", "gap", "unrecorded"]);
  assert.match(p[1].why, /its tables are missing \(y\), though later files ran/);
});

test("plan: an absence check passing is never evidence for older files", () => {
  // A database stopped at 0070: 0100's "no role holds ai_usage.view" is true
  // there too. It must not make 0071 look live.
  const files = [file("0070", "create table public.a (id int);"), file("0071", "alter table public.a add column b int;"), file("0072", "create table public.c (id int);"), file("0100", "")];
  const p = planMigrations(files, state({ checks: new Map([["0100", true]]), existingTables: new Set(["a", "app_roles"]) }));
  assert.deepEqual(p.map((x) => x.status), ["unrecorded", "pending", "pending", "pending"]);
  for (const v of ABSENCE_CHECKS) assert.ok(MIGRATION_CHECKS[v], v);
});

test("plan: files that share a version are refused, not guessed at", () => {
  // A recorded 0071 can't say which of two 0071 files ran.
  const files = [file("0071", "alter table public.events add column v int;", "a_viewer_count"), file("0071", "create table public.scholarships (id int);", "b_scholarships")];
  assert.throws(() => planMigrations(files, state({ recorded: new Set(["0071"]) })), /share a version: 0071 \(0071_a_viewer_count\.sql, 0071_b_scholarships\.sql\)/);
});

test("the lexer: strings, E-strings, identifiers, comments and dollar quotes", () => {
  assert.equal(transactionMode("update public.lessons set description = 'Run your interviews concurrently';"), "wrap");
  assert.deepEqual(touchedTables("insert into x select $t$it's$t$;\n-- delete from public.profiles where false"), []);
  assert.deepEqual(touchedTables("do $$ begin update public.chat_reports set status = 'x'; delete from public.a; end $$;").sort(), ["a", "chat_reports"]);
  assert.deepEqual(createdTables("select 'create table public.fake (id int)'; create table public.real (id int);"), ["real"]);
  assert.deepEqual(droppedTables("drop table if exists public.a, public.b cascade; drop table c;"), ["a", "b", "c"]);
  assert.deepEqual(lexSql("select E'it\\'s -- not a comment', $$x$$").map((p) => p.kind), ["code", "string", "code", "string"]);
  assert.deepEqual(splitStatements("do $$ begin perform 1; perform 2; end $$; select ';' ; create function f() returns int language sql as\n-- c\n$fn$ select 1; $fn$;"), [
    "do $$ begin perform 1; perform 2; end $$;",
    "select ';' ;",
    "create function f() returns int language sql as\n-- c\n$fn$ select 1; $fn$;",
  ]);
  assert.deepEqual(splitStatements("alter table t add column b int; create index concurrently i on t (b);"), [
    "alter table t add column b int;",
    "create index concurrently i on t (b);",
  ]);
  // Every real file lexes into the same text it came from.
  for (const m of real) assert.equal(lexSql(m.sql).map((p) => p.text).join("").length > 0, true, m.file);
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
  // The dedicated PgBouncer on the direct host pools in transaction mode too.
  assert.equal(new URL(sessionConnectionString(`postgresql://postgres:p@db.${ref}.supabase.co:6543/postgres`).url).port, "5432");
  assert.equal(sessionConnectionString("postgresql://u:p@localhost:6543/db").changed, false);
});
