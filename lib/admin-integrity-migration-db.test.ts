import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATION_CHECKS } from "./migration-plan.ts";

/**
 * Migration 0103, executed for real against a throwaway Postgres.
 *
 * The move is only correct if it is ONE transaction that the existing guards
 * can abort, so the fixture runs the real 0081 file first: its enrollment
 * capacity trigger and its "active checkout" application guard are the
 * failures a move has to survive, and they're tested here as they ship, not
 * as stubs. Every rollback case below checks the whole picture afterwards
 * (enrollment, application, scholarship rows), because the old action's bug
 * was a half-done move that reported success.
 *
 * The full-admin triggers are tested the same way: real updates and deletes,
 * one statement demoting several admins, an authenticated admin editing from
 * the browser, and the advisory lock the concurrency argument rests on.
 * PGlite is a single connection, so two sessions racing can't be staged
 * here; what can be shown is that every removal takes the shared lock before
 * it counts, which is what serialises them in Postgres.
 */

const migration0081 = await readFile(
  new URL("../supabase/migrations/0081_parent_checkout.sql", import.meta.url),
  "utf8",
);
const migration = await readFile(
  new URL("../supabase/migrations/0103_admin_integrity.sql", import.meta.url),
  "utf8",
);

const STUDENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADMIN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FALL = "f0000000-0000-4000-8000-000000000001";
const WINTER = "f0000000-0000-4000-8000-000000000002";
const SPRING = "f0000000-0000-4000-8000-000000000003";
const SCHOLARSHIP = "50000000-0000-4000-8000-000000000001";

/**
 * 0001..0102, reduced to the objects 0081 and 0103 touch. Shapes follow
 * production (0001 enrollments/applications, 0048 app_roles and the
 * profiles.role foreign key, 0071 scholarship_applications and its one-award
 * index).
 */
async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.app_roles (
      slug text primary key,
      label text not null,
      permissions text[] not null default '{}'
    );
    insert into public.app_roles values
      ('student', 'Student', array['student.dashboard']),
      ('admin', 'Admin', array['*']),
      ('owner', 'Owner', array['*']),
      ('intern', 'Intern', array['people.view','people.roles']);
    create table public.profiles (
      id uuid primary key,
      email text not null default '',
      role text not null default 'student'
        references public.app_roles(slug) on update cascade on delete restrict
    );
    create table public.cohorts (
      id uuid primary key, name text not null, status text not null default 'upcoming',
      starts_on date, ends_on date, applications_close_at timestamptz,
      capacity integer not null default 24, price_cents integer not null default 0
    );
    create table public.applications (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references public.profiles(id) on delete cascade,
      cohort_id uuid references public.cohorts(id),
      status text not null default 'draft',
      paid_at timestamptz, stripe_session_id text, stripe_payment_intent_id text,
      reviewed_by uuid, reviewed_at timestamptz, review_notes text,
      created_at timestamptz not null default now(),
      unique (user_id, cohort_id)
    );
    create table public.enrollments (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references public.profiles(id) on delete cascade,
      cohort_id uuid not null references public.cohorts(id) on delete cascade,
      application_id uuid references public.applications(id) on delete set null,
      enrolled_at timestamptz not null default now(),
      unique (user_id, cohort_id)
    );
    create table public.payments (
      id uuid primary key default gen_random_uuid(), user_id uuid, application_id uuid, cohort_id uuid,
      stripe_session_id text, stripe_payment_intent_id text, amount_cents integer,
      amount_refunded_cents integer not null default 0, currency text, status text,
      stripe_receipt_url text, paid_at timestamptz, created_at timestamptz default now()
    );
    create table public.scholarship_applications (
      id uuid primary key default gen_random_uuid(),
      scholarship_id uuid not null,
      user_id uuid not null references public.profiles(id) on delete cascade,
      application_id uuid,
      cohort_id uuid,
      status text not null default 'draft',
      created_at timestamptz not null default now()
    );
    create unique index scholarship_applications_one_award_idx
      on public.scholarship_applications (user_id, cohort_id) where status = 'awarded';
  `);
  await db.exec(migration0081);
  await db.query(
    `insert into public.cohorts (id, name, starts_on, ends_on, capacity) values
       ($1, 'Fall', current_date + 10, current_date + 70, 24),
       ($2, 'Winter', current_date + 80, current_date + 140, 24),
       ($3, 'Spring', current_date + 150, current_date + 210, 24)`,
    [FALL, WINTER, SPRING],
  );
  await db.query(
    `insert into public.profiles (id, email, role) values
       ($1, 'student@example.test', 'student'), ($2, 'other@example.test', 'student'),
       ($3, 'a@example.test', 'admin'), ($4, 'b@example.test', 'admin')`,
    [STUDENT, OTHER, ADMIN_A, ADMIN_B],
  );
  await db.exec(migration);
  return db;
}

type MoveResult = {
  ok: boolean;
  code?: string;
  status?: string;
  from_cohort_id?: string | null;
  application_id?: string | null;
  enrollment?: string;
  scholarship_application_ids?: string[];
};

async function move(db: PGlite, to: string, from: string | null = null, user = STUDENT): Promise<MoveResult> {
  const r = await db.query<{ r: MoveResult }>(
    "select public.admin_move_student_cohort($1, $2, $3) as r",
    [user, to, from],
  );
  return r.rows[0].r;
}

/** Where the student stands, in one comparable value. */
async function picture(db: PGlite, user = STUDENT) {
  const enrollments = (
    await db.query<{ cohort_id: string; application_id: string | null }>(
      "select cohort_id, application_id from public.enrollments where user_id = $1 order by cohort_id",
      [user],
    )
  ).rows;
  const applications = (
    await db.query<{ id: string; cohort_id: string | null; status: string }>(
      "select id, cohort_id, status from public.applications where user_id = $1 order by created_at",
      [user],
    )
  ).rows;
  const scholarships = (
    await db.query<{ cohort_id: string | null; status: string }>(
      "select cohort_id, status from public.scholarship_applications where user_id = $1 order by status, cohort_id",
      [user],
    )
  ).rows;
  return { enrollments, applications, scholarships };
}

async function application(db: PGlite, cohort: string, status: string, ageMinutes = 0, user = STUDENT) {
  const r = await db.query<{ id: string }>(
    `insert into public.applications (user_id, cohort_id, status, created_at)
     values ($1, $2, $3, now() - make_interval(mins => $4)) returning id`,
    [user, cohort, status, ageMinutes],
  );
  return r.rows[0].id;
}

async function enroll(db: PGlite, cohort: string, applicationId: string | null, user = STUDENT) {
  await db.query(
    `insert into public.enrollments (user_id, cohort_id, application_id, enrolled_at)
     values ($1, $2, $3, now() - interval '30 days')`,
    [user, cohort, applicationId],
  );
}

async function scholarship(db: PGlite, cohort: string, status: string, user = STUDENT) {
  await db.query(
    "insert into public.scholarship_applications (scholarship_id, user_id, cohort_id, status) values ($1, $2, $3, $4)",
    [SCHOLARSHIP, user, cohort, status],
  );
}

async function rejects(p: Promise<unknown>, re: RegExp) {
  await assert.rejects(p, (err: any) => {
    assert.match(String(err?.message ?? err), re);
    return true;
  });
}

// ---------------------------------------------------------------------------
// The move
// ---------------------------------------------------------------------------

test("0103: a roster-only student (enrolled, no application) keeps their access when moved", async () => {
  const db = await setup();
  try {
    await enroll(db, FALL, null);
    const res = await move(db, WINTER);
    assert.equal(res.ok, true);
    assert.equal(res.enrollment, "moved");
    assert.equal(res.application_id, null);
    assert.equal(res.from_cohort_id, FALL);
    const after = await picture(db);
    assert.deepEqual(after.enrollments, [{ cohort_id: WINTER, application_id: null }]);
    // Their time in the new cohort starts now (assignments count from it).
    const fresh = await db.query<{ fresh: boolean }>(
      "select enrolled_at > now() - interval '1 minute' as fresh from public.enrollments where user_id = $1",
      [STUDENT],
    );
    assert.equal(fresh.rows[0].fresh, true);
  } finally {
    await db.close();
  }
});

test("0103: a paid applicant moves with their application and live scholarship rows", async () => {
  const db = await setup();
  try {
    const app = await application(db, FALL, "enrolled");
    await enroll(db, FALL, app);
    await scholarship(db, FALL, "awarded");
    await scholarship(db, FALL, "submitted");
    await scholarship(db, FALL, "declined");
    const res = await move(db, WINTER, FALL);
    assert.equal(res.ok, true);
    assert.equal(res.application_id, app);
    assert.equal(res.scholarship_application_ids?.length, 2);
    const after = await picture(db);
    assert.deepEqual(after.enrollments, [{ cohort_id: WINTER, application_id: app }]);
    assert.deepEqual(after.applications, [{ id: app, cohort_id: WINTER, status: "enrolled" }]);
    // The declined row is a record of what happened in Fall, and stays there.
    assert.deepEqual(after.scholarships, [
      { cohort_id: WINTER, status: "awarded" },
      { cohort_id: FALL, status: "declined" },
      { cohort_id: WINTER, status: "submitted" },
    ]);
  } finally {
    await db.close();
  }
});

test("0103: a newer draft beside an older enrollment stays put; the enrollment's own application moves", async () => {
  const db = await setup();
  try {
    const paid = await application(db, FALL, "enrolled", 60);
    await enroll(db, FALL, paid);
    const draft = await application(db, SPRING, "draft", 0);
    const res = await move(db, WINTER);
    assert.equal(res.ok, true);
    assert.equal(res.application_id, paid);
    const after = await picture(db);
    assert.deepEqual(after.enrollments, [{ cohort_id: WINTER, application_id: paid }]);
    assert.deepEqual(after.applications, [
      { id: paid, cohort_id: WINTER, status: "enrolled" },
      { id: draft, cohort_id: SPRING, status: "draft" },
    ]);
  } finally {
    await db.close();
  }
});

test("0103: a roster-only enrollment with a newer draft elsewhere moves the enrollment only", async () => {
  const db = await setup();
  try {
    await enroll(db, FALL, null);
    const draft = await application(db, SPRING, "draft");
    const res = await move(db, WINTER);
    assert.equal(res.ok, true);
    assert.equal(res.application_id, null);
    const after = await picture(db);
    assert.deepEqual(after.enrollments, [{ cohort_id: WINTER, application_id: null }]);
    assert.deepEqual(after.applications, [{ id: draft, cohort_id: SPRING, status: "draft" }]);
  } finally {
    await db.close();
  }
});

test("0103: only the intended enrollment moves; a returning student's earlier cohort stays", async () => {
  const db = await setup();
  try {
    const spring = await application(db, SPRING, "enrolled", 600);
    await enroll(db, SPRING, spring);
    const fall = await application(db, FALL, "enrolled", 60);
    await db.query(
      "insert into public.enrollments (user_id, cohort_id, application_id, enrolled_at) values ($1, $2, $3, now())",
      [STUDENT, FALL, fall],
    );
    const res = await move(db, WINTER, FALL);
    assert.equal(res.ok, true);
    const after = await picture(db);
    assert.deepEqual(
      after.enrollments.map((e) => e.cohort_id).sort(),
      [WINTER, SPRING].sort(),
    );
  } finally {
    await db.close();
  }
});

test("0103: a paid application with no enrollment gets one in the new cohort, ahead of a newer draft", async () => {
  const db = await setup();
  try {
    const paid = await application(db, FALL, "paid", 60);
    const draft = await application(db, SPRING, "draft", 0);
    const res = await move(db, WINTER);
    assert.equal(res.ok, true);
    assert.equal(res.enrollment, "created");
    assert.equal(res.application_id, paid);
    const after = await picture(db);
    assert.deepEqual(after.enrollments, [{ cohort_id: WINTER, application_id: paid }]);
    assert.deepEqual(after.applications.find((a) => a.id === draft)?.cohort_id, SPRING);
  } finally {
    await db.close();
  }
});

test("0103: an accepted (unpaid) applicant's application moves and no access is invented", async () => {
  const db = await setup();
  try {
    const app = await application(db, FALL, "accepted");
    const res = await move(db, WINTER);
    assert.equal(res.ok, true);
    assert.equal(res.enrollment, "none");
    const after = await picture(db);
    assert.deepEqual(after.enrollments, []);
    assert.deepEqual(after.applications, [{ id: app, cohort_id: WINTER, status: "accepted" }]);
  } finally {
    await db.close();
  }
});

test("0103: refusals come back before any write", async () => {
  const db = await setup();
  try {
    assert.deepEqual(await move(db, WINTER), { ok: false, code: "nothing_to_move" });
    assert.equal((await move(db, WINTER, null, "99999999-9999-4999-8999-999999999999")).code, "no_profile");
    assert.equal((await move(db, "99999999-9999-4999-8999-999999999999")).code, "no_cohort");

    const app = await application(db, FALL, "enrolled", 60);
    await enroll(db, FALL, app);
    assert.equal((await move(db, FALL)).code, "same_cohort");
    // The page showed them in Spring; they aren't there.
    assert.equal((await move(db, WINTER, SPRING)).code, "stale");

    // Already holding a Winter application.
    const winterDraft = await application(db, WINTER, "draft");
    const clash = await move(db, WINTER);
    assert.equal(clash.code, "application_exists");
    assert.equal(clash.status, "draft");
    await db.query("delete from public.applications where id = $1", [winterDraft]);

    // Two awards can't share a cohort.
    await scholarship(db, FALL, "awarded");
    await scholarship(db, WINTER, "awarded");
    const before = await picture(db);
    assert.equal((await move(db, WINTER)).code, "award_conflict");
    assert.deepEqual(await picture(db), before);
    await db.query("delete from public.scholarship_applications where user_id = $1", [STUDENT]);

    // Already enrolled in the target.
    await db.query(
      "insert into public.enrollments (user_id, cohort_id, enrolled_at) values ($1, $2, now() - interval '90 days')",
      [STUDENT, WINTER],
    );
    assert.equal((await move(db, WINTER, FALL)).code, "already_enrolled");
  } finally {
    await db.close();
  }
});

// Rollback at every write. Each case makes one write fail the way it can in
// production and asserts the student is exactly where they started.

test("0103 rollback: the scholarship write fails, nothing moves", async () => {
  const db = await setup();
  try {
    const app = await application(db, FALL, "enrolled");
    await enroll(db, FALL, app);
    await scholarship(db, FALL, "submitted");
    await db.exec(`
      create function public.fail_scholarship_write() returns trigger language plpgsql as $$
      begin raise exception 'simulated scholarship write failure'; end $$;
      create trigger fail_scholarship_write before update on public.scholarship_applications
        for each row execute function public.fail_scholarship_write();
    `);
    const before = await picture(db);
    await rejects(move(db, WINTER), /simulated scholarship write failure/);
    assert.deepEqual(await picture(db), before);
  } finally {
    await db.close();
  }
});

test("0103 rollback: the application write fails (an active checkout), scholarships come back", async () => {
  const db = await setup();
  try {
    const app = await application(db, FALL, "accepted");
    await scholarship(db, FALL, "submitted");
    // 0081's guard: an application holding a seat can't be transferred.
    await db.query(
      `insert into public.checkout_reservations (application_id, cohort_id, user_id, quote, expires_at)
       values ($1, $2, $3, '{}'::jsonb, now() + interval '30 minutes')`,
      [app, FALL, STUDENT],
    );
    const before = await picture(db);
    await rejects(move(db, WINTER), /active checkout/);
    assert.deepEqual(await picture(db), before);
  } finally {
    await db.close();
  }
});

test("0103 rollback: the enrollment update fails (the cohort is full), application and scholarships stay", async () => {
  const db = await setup();
  try {
    const app = await application(db, FALL, "enrolled");
    await enroll(db, FALL, app);
    await scholarship(db, FALL, "awarded");
    await db.query("update public.cohorts set capacity = 1 where id = $1", [WINTER]);
    await enroll(db, WINTER, null, OTHER);
    const before = await picture(db);
    await rejects(move(db, WINTER), /full/);
    assert.deepEqual(await picture(db), before);
  } finally {
    await db.close();
  }
});

test("0103 rollback: the enrollment insert fails (the cohort is full), the paid application stays", async () => {
  const db = await setup();
  try {
    await application(db, FALL, "paid");
    await scholarship(db, FALL, "submitted");
    await db.query("update public.cohorts set capacity = 1 where id = $1", [WINTER]);
    await enroll(db, WINTER, null, OTHER);
    const before = await picture(db);
    await rejects(move(db, WINTER), /full/);
    assert.deepEqual(await picture(db), before);
  } finally {
    await db.close();
  }
});

test("0103: the move function is the service role's alone", async () => {
  const db = await setup();
  try {
    const priv = await db.query<{ anon: boolean; authed: boolean; service: boolean }>(
      `select has_function_privilege('anon', 'public.admin_move_student_cohort(uuid, uuid, uuid)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.admin_move_student_cohort(uuid, uuid, uuid)', 'execute') as authed,
              has_function_privilege('service_role', 'public.admin_move_student_cohort(uuid, uuid, uuid)', 'execute') as service`,
    );
    assert.deepEqual(priv.rows[0], { anon: false, authed: false, service: true });
    const definer = await db.query<{ secdef: boolean; config: string[] }>(
      "select prosecdef as secdef, proconfig as config from pg_proc where proname = 'admin_move_student_cohort'",
    );
    assert.equal(definer.rows[0].secdef, true);
    assert.ok(definer.rows[0].config.some((c) => c.startsWith("search_path=")));
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// At least one full admin
// ---------------------------------------------------------------------------

async function roleOf(db: PGlite, id: string) {
  return (await db.query<{ role: string }>("select role from public.profiles where id = $1", [id])).rows[0]?.role;
}

test("0103: the last full admin can't be demoted, by any writer", async () => {
  const db = await setup();
  try {
    await db.query("update public.profiles set role = 'student' where id = $1", [ADMIN_B]);
    await rejects(
      db.query("update public.profiles set role = 'student' where id = $1", [ADMIN_A]),
      /at least one full admin/,
    );
    assert.equal(await roleOf(db, ADMIN_A), "admin");
    // A '*' role to another '*' role keeps full access, so it's allowed.
    await db.query("update public.profiles set role = 'owner' where id = $1", [ADMIN_A]);
    assert.equal(await roleOf(db, ADMIN_A), "owner");
    // Everyone else's role changes are untouched.
    await db.query("update public.profiles set role = 'intern' where id = $1", [STUDENT]);
    assert.equal(await roleOf(db, STUDENT), "intern");
  } finally {
    await db.close();
  }
});

test("0103: one statement demoting every admin is refused whole", async () => {
  const db = await setup();
  try {
    await rejects(
      db.query("update public.profiles set role = 'student' where id in ($1, $2)", [ADMIN_A, ADMIN_B]),
      /at least one full admin/,
    );
    assert.equal(await roleOf(db, ADMIN_A), "admin");
    assert.equal(await roleOf(db, ADMIN_B), "admin");
  } finally {
    await db.close();
  }
});

test("0103: the last full admin's profile can't be deleted; another admin's can", async () => {
  const db = await setup();
  try {
    await db.query("delete from public.profiles where id = $1", [ADMIN_B]);
    await rejects(db.query("delete from public.profiles where id = $1", [ADMIN_A]), /at least one full admin/);
    assert.equal(await roleOf(db, ADMIN_A), "admin");
  } finally {
    await db.close();
  }
});

test("0103: a '*' role can't lose the wildcard while its members are the only full admins", async () => {
  const db = await setup();
  try {
    await rejects(
      db.query("update public.app_roles set permissions = array['people.view'] where slug = 'admin'"),
      /at least one full admin/,
    );
    // An empty '*' role takes access from nobody.
    await db.query("update public.app_roles set permissions = array['people.view'] where slug = 'owner'");
    await db.query("update public.app_roles set permissions = array['*'] where slug = 'owner'");
    // With a full admin elsewhere, the admin role may be narrowed.
    await db.query("update public.profiles set role = 'owner' where id = $1", [ADMIN_B]);
    await db.query("update public.app_roles set permissions = array['people.view'] where slug = 'admin'");
    assert.deepEqual(
      (await db.query<{ n: number }>(
        "select count(*)::int as n from public.profiles p join public.app_roles r on r.slug = p.role where r.permissions @> array['*']",
      )).rows[0].n,
      1,
    );
  } finally {
    await db.close();
  }
});

test("0103: an admin editing from the browser hits the same rule", async () => {
  const db = await setup();
  try {
    await db.query("update public.profiles set role = 'student' where id = $1", [ADMIN_B]);
    await db.exec("grant select, update on public.profiles to authenticated; grant select on public.app_roles to authenticated;");
    await db.exec("set role authenticated");
    try {
      await rejects(
        db.query("update public.profiles set role = 'student' where id = $1", [ADMIN_A]),
        /at least one full admin/,
      );
    } finally {
      await db.exec("reset role");
    }
    assert.equal(await roleOf(db, ADMIN_A), "admin");
  } finally {
    await db.close();
  }
});

test("0103: every removal of full access takes the shared lock before counting", async () => {
  const db = await setup();
  try {
    const advisory = async () =>
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()",
        )
      ).rows[0].n;
    await db.exec("begin");
    await db.query("update public.profiles set role = 'intern' where id = $1", [STUDENT]);
    assert.equal(await advisory(), 0, "an ordinary role change takes no lock");
    await db.query("update public.profiles set role = 'student' where id = $1", [ADMIN_B]);
    assert.equal(await advisory(), 1, "demoting a full admin holds the lock until commit");
    await db.exec("rollback");
    assert.equal(await advisory(), 0);
  } finally {
    await db.close();
  }
});

test("0103 is idempotent, and its verify query passes only once it has run", async () => {
  const db = await setup();
  try {
    const check = MIGRATION_CHECKS["0103"];
    assert.ok(check, "0103 needs a verify query in MIGRATION_CHECKS");
    assert.equal((await db.query<{ ok: boolean }>(check)).rows[0].ok, true);
    await db.exec(migration);
    assert.equal((await db.query<{ ok: boolean }>(check)).rows[0].ok, true);
    const triggers = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_trigger where tgname in ('keep_a_full_admin', 'keep_a_full_admin_role')",
    );
    assert.equal(triggers.rows[0].n, 2);
    // And before it ran, the query says so.
    await db.exec(`
      drop trigger keep_a_full_admin on public.profiles;
      drop trigger keep_a_full_admin_role on public.app_roles;
      drop function public.admin_move_student_cohort(uuid, uuid, uuid);
    `);
    assert.equal((await db.query<{ ok: boolean }>(check)).rows[0].ok, false);
  } finally {
    await db.close();
  }
});
