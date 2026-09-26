import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(new URL("../supabase/migrations/0085_fall_admissions_rollover.sql", import.meta.url), "utf8");
const fall = "6350c6ac-70f0-4f53-93d5-c99e397185a9";
const winter = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
async function setup() {
  const db = new PGlite();
  await db.exec(`
    create table cohorts(id uuid primary key, starts_on date, ends_on date, status text, applications_close_at timestamptz, late_entry_until timestamptz, catch_up_plan text, price_cents int);
    create table applications(id int primary key, cohort_id uuid, status text);
    create table enrollments(id int primary key, cohort_id uuid);
  `);
  await db.query("insert into cohorts values($1,'2026-09-14','2026-11-13','active','2026-09-30T03:59:00Z','2026-10-01T03:59:59Z','Old September 21 intro',13000),($2,'2026-12-14','2027-02-12','upcoming','2026-12-12T23:59:00Z',null,null,15099)", [fall, winter]);
  await db.query("insert into applications values(1,$1,'enrolled'),(2,$1,'accepted'),(3,$1,'draft')", [fall]);
  await db.query("insert into enrollments values(1,$1)", [fall]);
  return db;
}

test("Fall rollout aligns Eastern deadlines, preserves membership and Winter, and can run twice", async () => {
  const db = await setup();
  try {
    const before = (await db.query("select * from cohorts where id=$1", [winter])).rows;
    const applications = (await db.query("select * from applications order by id")).rows;
    const enrollments = (await db.query("select * from enrollments")).rows;
    await db.exec(migration);
    await db.exec(migration);
    const result = (await db.query<any>("select *, applications_close_at=late_entry_until same_deadline from cohorts where id=$1", [fall])).rows[0];
    assert.equal(result.same_deadline, true);
    assert.equal(new Date(result.late_entry_until).toISOString(), "2026-10-01T03:59:59.999Z");
    assert.equal(result.status, "active");
    assert.equal(result.price_cents, 13000);
    assert.match(result.catch_up_plan, /Week 2 customer-interview/);
    assert.doesNotMatch(result.catch_up_plan, /September 21/);
    assert.deepEqual((await db.query("select * from cohorts where id=$1", [winter])).rows, before);
    assert.deepEqual((await db.query("select * from applications order by id")).rows, applications);
    assert.deepEqual((await db.query("select * from enrollments")).rows, enrollments);
  } finally { await db.close(); }
});

test("the rollout fails closed if Fall's calendar has changed", async () => {
  const db = await setup();
  try {
    await db.query("update cohorts set starts_on='2026-10-01' where id=$1", [fall]);
    await assert.rejects(db.exec(migration), /Fall calendar differs/);
    await db.exec("rollback");
    assert.equal((await db.query<any>("select catch_up_plan from cohorts where id=$1", [fall])).rows[0].catch_up_plan, "Old September 21 intro");
  } finally { await db.close(); }
});
