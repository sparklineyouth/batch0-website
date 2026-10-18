import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATION_CHECKS } from "./migration-plan.ts";
import { FOLLOWUP_COLUMNS, FOLLOWUP_NOTE_MAX } from "./student-followups.ts";

/**
 * Migration 0107 (student follow-ups), executed against a throwaway Postgres
 * with Supabase's default grants — applied, re-applied, then used the way
 * app/admin/progress/actions.ts uses it (as the table owner, standing in for
 * the service role) and probed as signed-in users and anon.
 *
 * What it proves: one open follow-up per student, however two people race
 * for it, and a new one once it's closed; the note and the closed state are
 * checked; updated_at moves on every save (the drawer's edit token); deleting
 * a student deletes their follow-ups and deleting an owner leaves the
 * follow-up ownerless; and nobody signed in can read or write any of it.
 */

const migration = await readFile(
  new URL("../supabase/migrations/0107_student_followups.sql", import.meta.url),
  "utf8",
);

const STUDENT = "11111111-1111-4111-8111-111111111111";
const OTHER_STUDENT = "22222222-2222-4222-8222-222222222222";
const STAFF = "33333333-3333-4333-8333-333333333333";
const SECOND_STAFF = "44444444-4444-4444-8444-444444444444";

async function setup(apply = true) {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    end $$;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;

    -- Supabase's default privileges: every table a later migration creates is
    -- granted to both API roles, so a missing revoke would show up here.
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;

    create table public.profiles (id uuid primary key, role text not null default 'student', full_name text);
    -- 0001's trigger function.
    create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
      begin new.updated_at = now(); return new; end $$;

    insert into public.profiles (id, role, full_name) values
      ('${STUDENT}', 'student', 'Ada'), ('${OTHER_STUDENT}', 'student', 'Grace'),
      ('${STAFF}', 'admin', 'Sam'), ('${SECOND_STAFF}', 'admin', 'Kim');
  `);
  if (apply) await db.exec(migration);
  return db;
}

async function verified(db: PGlite): Promise<boolean | undefined> {
  return (await db.query<{ ok: boolean }>(MIGRATION_CHECKS["0107"])).rows[0]?.ok;
}

/** Run `sql` as a signed-in user (or anon), then drop back to the owner. */
async function as<T = any>(db: PGlite, role: "authenticated" | "anon", uid: string, sql: string, params: unknown[] = []) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try {
    return await db.query<T>(sql, params);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

const START = `insert into public.student_followups (student_id, owner_id, next_check_on, note, created_by)
  values ($1, $2, $3, $4, $2) returning id, updated_at`;

test("0107's verify query fails before it runs and passes after, twice over", async () => {
  const db = await setup(false);
  try {
    assert.equal(await verified(db), false);
    await db.exec(migration);
    await db.exec(migration);
    assert.equal(await verified(db), true);
  } finally {
    await db.close();
  }
});

test("every column the app selects exists", async () => {
  const db = await setup();
  try {
    await db.query(`select ${FOLLOWUP_COLUMNS} from public.student_followups limit 0`);
  } finally {
    await db.close();
  }
});

test("one open follow-up per student: the second person is refused, a closed one makes room", async () => {
  const db = await setup();
  try {
    const first = await db.query<{ id: string }>(START, [STUDENT, STAFF, "2026-10-20", "Missed weeks 3 and 4."]);
    // Someone else, a moment later, about the same student.
    await assert.rejects(
      db.query(START, [STUDENT, SECOND_STAFF, "2026-10-21", "No update this week."]),
      (err: { code?: string }) => err?.code === "23505",
    );
    // Another student is unaffected.
    await db.query(START, [OTHER_STUDENT, SECOND_STAFF, "2026-10-21", "Asked about Demo Day."]);

    await db.query(
      `update public.student_followups set status = 'closed', closed_at = now(), closed_by = $2 where id = $1`,
      [first.rows[0].id, STAFF],
    );
    await db.query(START, [STUDENT, SECOND_STAFF, "2026-10-28", "Checking week 6."]);
    const rows = await db.query<{ status: string; n: number }>(
      `select status, count(*)::int as n from public.student_followups where student_id = $1 group by status order by status`,
      [STUDENT],
    );
    assert.deepEqual(rows.rows, [
      { status: "closed", n: 1 },
      { status: "open", n: 1 },
    ]);
  } finally {
    await db.close();
  }
});

test("the note is required and bounded; closed means closed_at, and only then", async () => {
  const db = await setup();
  try {
    await assert.rejects(db.query(START, [STUDENT, STAFF, "2026-10-20", "   "]), (e: { code?: string }) => e?.code === "23514");
    await assert.rejects(
      db.query(START, [STUDENT, STAFF, "2026-10-20", "a".repeat(FOLLOWUP_NOTE_MAX + 1)]),
      (e: { code?: string }) => e?.code === "23514",
    );
    await db.query(START, [STUDENT, STAFF, "2026-10-20", "é".repeat(FOLLOWUP_NOTE_MAX)]);
    await assert.rejects(
      db.query(`update public.student_followups set status = 'closed' where student_id = $1`, [STUDENT]),
      (e: { code?: string }) => e?.code === "23514",
    );
    await assert.rejects(
      db.query(`update public.student_followups set closed_at = now() where student_id = $1`, [STUDENT]),
      (e: { code?: string }) => e?.code === "23514",
    );
    await assert.rejects(
      db.query(`update public.student_followups set status = 'snoozed' where student_id = $1`, [STUDENT]),
      (e: { code?: string }) => e?.code === "23514",
    );
  } finally {
    await db.close();
  }
});

test("every save moves updated_at, so a stale edit matches nothing", async () => {
  const db = await setup();
  try {
    const { rows } = await db.query<{ id: string; updated_at: string }>(START, [STUDENT, STAFF, "2026-10-20", "First note."]);
    const token = rows[0].updated_at;
    await new Promise((r) => setTimeout(r, 5));
    // Someone else saves first, from the same version.
    const first = await db.query(
      `update public.student_followups set note = 'Theirs.' where id = $1 and status = 'open' and updated_at = $2 returning id`,
      [rows[0].id, token],
    );
    assert.equal(first.rows.length, 1);
    // The second save names the version it started from, which is gone.
    const second = await db.query(
      `update public.student_followups set note = 'Mine.' where id = $1 and status = 'open' and updated_at = $2 returning id`,
      [rows[0].id, token],
    );
    assert.equal(second.rows.length, 0);
    const note = await db.query<{ note: string }>(`select note from public.student_followups where id = $1`, [rows[0].id]);
    assert.equal(note.rows[0].note, "Theirs.");
  } finally {
    await db.close();
  }
});

test("deleting a student deletes their follow-ups; deleting an owner leaves it without one", async () => {
  const db = await setup();
  try {
    await db.query(START, [STUDENT, STAFF, "2026-10-20", "About Ada."]);
    await db.query(START, [OTHER_STUDENT, STAFF, "2026-10-20", "About Grace."]);
    await db.query(`delete from public.profiles where id = $1`, [STUDENT]);
    await db.query(`delete from public.profiles where id = $1`, [STAFF]);
    const rows = await db.query<{ student_id: string; owner_id: string | null; created_by: string | null }>(
      `select student_id, owner_id, created_by from public.student_followups`,
    );
    assert.deepEqual(rows.rows, [{ student_id: OTHER_STUDENT, owner_id: null, created_by: null }]);
  } finally {
    await db.close();
  }
});

test("nobody signed in reads or writes it — staff included; only the server does", async () => {
  const db = await setup();
  try {
    await db.query(START, [STUDENT, STAFF, "2026-10-20", "Not for the browser."]);
    for (const [role, uid] of [
      ["authenticated", STAFF],
      ["authenticated", STUDENT],
      ["anon", ""],
    ] as const) {
      await assert.rejects(as(db, role, uid, `select note from public.student_followups`), /permission denied/, `${role} ${uid} read`);
      await assert.rejects(
        as(db, role, uid, `insert into public.student_followups (student_id, next_check_on, note) values ($1, '2026-10-20', 'x')`, [OTHER_STUDENT]),
        /permission denied/,
      );
      await assert.rejects(as(db, role, uid, `update public.student_followups set note = 'x'`), /permission denied/);
      await assert.rejects(as(db, role, uid, `delete from public.student_followups`), /permission denied/);
    }
    const rls = await db.query<{ on: boolean; policies: number }>(
      `select c.relrowsecurity as on,
              (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'student_followups') as policies
       from pg_class c where c.oid = 'public.student_followups'::regclass`,
    );
    assert.deepEqual(rls.rows[0], { on: true, policies: 0 });
  } finally {
    await db.close();
  }
});
