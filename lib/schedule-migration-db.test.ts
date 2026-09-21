import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Public event metadata only: no meeting URLs, recipients or student records.
const fixture = JSON.parse(await readFile(new URL("./fixtures/fall-schedule-before-repair.json", import.meta.url), "utf8"));
const migration = await readFile(new URL("../supabase/migrations/0083_restore_fall_schedule.sql", import.meta.url), "utf8");
const fall = "6350c6ac-70f0-4f53-93d5-c99e397185a9";
const intro = "a1ab2a89-6cde-504c-9b17-857a683549eb";

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create table cohorts(id uuid primary key, starts_on date, ends_on date, applications_close_at timestamptz, late_entry_until timestamptz, catch_up_plan text);
    create table events(id uuid primary key, cohort_id uuid, type text, title text, starts_at timestamptz, ends_at timestamptz, daily_room_name text, description text, updated_at timestamptz);
    create table cohort_kickoff(cohort_id uuid primary key, headline text, intro text, time_label text, join_url text, agenda jsonb, checklist jsonb, note text, updated_at timestamptz);
  `);
  await db.query("insert into cohorts(id,starts_on,ends_on) values($1,'2026-09-14','2026-11-13')", [fall]);
  await db.query("insert into cohort_kickoff(cohort_id) values($1)", [fall]);
  for (const row of fixture) {
    await db.query("insert into events(id,cohort_id,type,title,starts_at,ends_at,daily_room_name) values($1,$2,$3,$4,$5,$6,$7)",
      [row.id,row.cohort_id,row.type,row.title,row.starts_at,row.ends_at,row.daily_room_name]);
  }
  return db;
}

test("approved Fall repair restores the entire nine-week schedule including DST and keeps the intro time", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    const rows = (await db.query<any>(`select *,
      to_char(starts_at at time zone 'America/New_York','YYYY-MM-DD HH24:MI') local_start,
      extract(isodow from starts_at at time zone 'America/New_York')::int weekday,
      extract(epoch from (ends_at-starts_at))/60 minutes,
      to_char(starts_at at time zone 'UTC','HH24:MI') utc_time
      from events order by starts_at`)).rows;
    assert.equal(rows.length, 18);
    const first = rows.find(row => row.id === intro);
    assert.equal(first.local_start, "2026-09-21 13:00");
    assert.equal(Number(first.minutes), 60);
    for (const row of rows.filter(row => row.id !== intro)) {
      const date = row.daily_room_name.match(/-(\d{4})(\d{2})(\d{2})-/)!;
      assert.equal(row.local_start, `${date[1]}-${date[2]}-${date[3]} 20:00`);
      assert.equal(row.weekday, row.type === "office_hours" ? 4 : row.type === "demo_day" ? 5 : 1);
      assert.equal(Number(row.minutes), row.type === "office_hours" ? 30 : 60);
      assert.doesNotMatch(row.title, /^Week \d+ Webinar/);
      assert.equal(row.utc_time, row.local_start < "2026-11-01" ? "00:00" : "01:00");
    }
    assert.equal(rows.at(-1).local_start, "2026-11-13 20:00");
    const cohort = (await db.query<any>("select to_char(late_entry_until at time zone 'America/New_York','YYYY-MM-DD HH24:MI:SS') deadline, catch_up_plan from cohorts")).rows[0];
    assert.equal(cohort.deadline, "2026-09-22 23:59:59");
    assert.match(cohort.catch_up_plan, /September 21, 1–2 p.m. Eastern/);
    // Re-running a narrowly scoped repair must not move the dates again.
    await db.exec(migration);
    assert.equal((await db.query<any>("select count(*)::int n from events where starts_at > '2026-11-14'::timestamptz")).rows[0].n, 0);
  } finally { await db.close(); }
});

test("a changed offer fails without changing its dates or deadline", async () => {
  const db = await setup();
  try {
    await db.exec("update cohorts set ends_on='2026-12-01'");
    await assert.rejects(db.exec(migration), /dates differ/);
    await db.exec("rollback");
    assert.equal((await db.query<any>("select late_entry_until from cohorts")).rows[0].late_entry_until, null);
    assert.equal((await db.query<any>("select count(*)::int n from events where starts_at > '2026-11-14'::timestamptz")).rows[0].n, 10);
  } finally { await db.close(); }
});

test("an unrecognized out-of-range event rolls the whole schedule repair back", async () => {
  const db = await setup();
  try {
    await db.query("insert into events(id,cohort_id,type,title,starts_at,ends_at,daily_room_name) values(gen_random_uuid(),$1,'workshop','Unrecognized','2026-12-01','2026-12-01 01:00','custom-event')", [fall]);
    await assert.rejects(db.exec(migration), /event remains beyond/);
    await db.exec("rollback");
    assert.equal((await db.query<any>("select late_entry_until from cohorts")).rows[0].late_entry_until, null);
    const original = fixture.find((row: any) => row.type === "demo_day");
    const restored = (await db.query<any>("select starts_at from events where id=$1", [original.id])).rows[0];
    assert.equal(new Date(restored.starts_at).toISOString(), new Date(original.starts_at).toISOString());
  } finally { await db.close(); }
});
