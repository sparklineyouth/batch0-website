/** Isolated PostgreSQL integration test for migration 0071; NEVER connects to
 * linked Supabase.
 *
 * Run: node --test scripts/test-scholarships-db.mts
 * Requires @electric-sql/pglite (dev dependency), or set BATCH0_PGLITE_MODULE
 * to an absolute installed module path.
 *
 * Why this exists: 0071 is applied by a human pasting it into the Supabase SQL
 * editor, so a syntax error or a constraint that doesn't do what its comment
 * claims is discovered in production, by hand, at the worst moment. Everything
 * below executes the REAL migration file — not a paraphrase of it.
 *
 * What it covers:
 *   - the migration applies cleanly, and is idempotent (re-running is a no-op)
 *   - scholarships_award_shape rejects a scholarship worth nothing
 *   - the one-live-award-per-student index actually holds
 *   - the answer-store columns and the interview_requests FK exist
 *   - touch_updated_at is wired to both new tables
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const packagePath = process.env.BATCH0_PGLITE_MODULE;
const moduleName = packagePath
  ? pathToFileURL(packagePath).href
  : "@electric-sql/pglite";
const { PGlite } = await import(moduleName);
const db = new PGlite();

/**
 * Typed wrapper over PGlite's untyped `query`.
 *
 * The module is imported dynamically (so BATCH0_PGLITE_MODULE can redirect it),
 * which makes `db` an `any` — and an untyped call can't take type arguments.
 * Funnelling every read through here keeps the assertions typed without
 * scattering casts, and keeps this file passing `tsc --noEmit`, which does
 * cover scripts/*.mts.
 */
async function q<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<{ rows: T[] }> {
  return (await db.query(sql, params)) as { rows: T[] };
}

// The slice of 0001..0070 that 0071 actually depends on. Hand-built rather
// than replaying every migration: PGlite has no Supabase auth schema, and
// replaying seventy files would test those files, not this one.
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select null::uuid $$;

  create table public.profiles (
    id uuid primary key default gen_random_uuid(),
    email text not null,
    full_name text
  );
  create table public.cohorts (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    price_cents integer
  );
  create table public.applications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references public.profiles(id) on delete cascade,
    cohort_id uuid references public.cohorts(id),
    status text not null default 'draft'
  );
  create table public.call_invites (
    id uuid primary key default gen_random_uuid()
  );
  create table public.interview_requests (
    id uuid primary key default gen_random_uuid(),
    student_id uuid not null references public.profiles(id) on delete cascade,
    cohort_id uuid references public.cohorts(id) on delete set null,
    status text not null default 'requested',
    call_invite_id uuid references public.call_invites(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create table public.app_roles (
    slug text primary key,
    permissions text[] not null default '{}'
  );
  insert into public.app_roles values ('admin', array['*']), ('mentor', array['mentor.panel']);

  -- 0001_init.sql:324 — the shared trigger function 0071 attaches.
  create or replace function public.touch_updated_at()
  returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end;
  $$;

  -- 0048_custom_roles.sql — the RLS predicates 0071 uses.
  create or replace function public.has_permission(uid uuid, perm text)
  returns boolean language sql stable as $$
    select exists (
      select 1 from public.app_roles r
      where r.permissions @> array['*'] or r.permissions @> array[perm]
    ) $$;
  create or replace function public.is_admin(uid uuid)
  returns boolean language sql stable as $$ select false $$;
`);

const MIGRATION = await readFile(
  new URL("../supabase/migrations/0071_scholarships.sql", import.meta.url),
  "utf8",
);

// PGlite has no PostgREST, so the migration's closing NOTIFY is meaningless
// here — and `notify` with a payload is fine in Postgres, so it is left in.
await db.exec(MIGRATION);

async function newProfile(email: string): Promise<string> {
  const r = await q<{ id: string }>(
    "insert into public.profiles (email) values ($1) returning id",
    [email],
  );
  return r.rows[0].id;
}

async function newCohort(name: string): Promise<string> {
  const r = await q<{ id: string }>(
    "insert into public.cohorts (name, price_cents) values ($1, 13000) returning id",
    [name],
  );
  return r.rows[0].id;
}

async function newScholarship(
  over: Partial<{
    slug: string;
    name: string;
    award_type: string;
    award_cents: number;
    mentor_calls: number;
  }> = {},
): Promise<string> {
  const v = {
    slug: over.slug ?? `s-${Math.floor(Math.random() * 1e9).toString(36)}`,
    name: over.name ?? "Need-based grant",
    award_type: over.award_type ?? "discount",
    award_cents: over.award_cents ?? 5000,
    mentor_calls: over.mentor_calls ?? 0,
  };
  const r = await q<{ id: string }>(
    `insert into public.scholarships (slug, name, award_type, award_cents, mentor_calls)
     values ($1,$2,$3,$4,$5) returning id`,
    [v.slug, v.name, v.award_type, v.award_cents, v.mentor_calls],
  );
  return r.rows[0].id;
}

async function fails(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err: any) {
    return String(err?.message ?? err);
  }
  assert.fail("expected that to be rejected, but it succeeded");
}

// ---------------------------------------------------------------------------

test("the migration is idempotent — re-running changes nothing", async () => {
  // Every migration in this repo promises this in its header, and 0071 is
  // pasted by hand, so a double-paste has to be harmless.
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
  const r = await q<{ n: number }>(
    "select count(*)::int as n from public.scholarships",
  );
  assert.equal(r.rows[0].n, 0);
});

test("both new tables exist with RLS enabled", async () => {
  const r = await q<{ relname: string; relrowsecurity: boolean }>(
    `select relname, relrowsecurity from pg_class
     where relname in ('scholarships','scholarship_applications')
     order by relname`,
  );
  assert.deepEqual(
    r.rows.map((x: { relname: string }) => x.relname),
    ["scholarship_applications", "scholarships"],
  );
  assert.ok(r.rows.every((x: { relrowsecurity: boolean }) => x.relrowsecurity), "RLS must be enabled");
});

test("scholarships_award_shape rejects an award worth nothing", async () => {
  // A discount scholarship with no amount and no percentage is a form that
  // wastes an applicant's time. Same for a calls award granting zero calls.
  const a = await fails(() =>
    q(
      `insert into public.scholarships (slug, name, award_type, award_cents)
       values ('empty-money','Empty','discount',0)`,
    ),
  );
  assert.match(a, /scholarships_award_shape/);

  const b = await fails(() =>
    q(
      `insert into public.scholarships (slug, name, award_type, mentor_calls)
       values ('empty-calls','Empty','mentor_calls',0)`,
    ),
  );
  assert.match(b, /scholarships_award_shape/);
});

test("a percentage-only scholarship is valid", async () => {
  await q(
    `insert into public.scholarships (slug, name, award_type, award_cents, award_percent)
     values ('half','Half tuition','discount',0,50)`,
  );
  const r = await q<{ award_percent: number }>(
    "select award_percent from public.scholarships where slug = 'half'",
  );
  assert.equal(r.rows[0].award_percent, 50);
});

test("award_percent is bounded to 1..100", async () => {
  const over = await fails(() =>
    q(
      `insert into public.scholarships (slug, name, award_percent) values ('over','Over',150)`,
    ),
  );
  assert.match(over, /award_percent/);
});

test("the closing date must follow the opening date", async () => {
  const msg = await fails(() =>
    q(
      `insert into public.scholarships (slug, name, award_cents, opens_at, closes_at)
       values ('backwards','Backwards',5000,'2026-10-01','2026-09-01')`,
    ),
  );
  assert.match(msg, /scholarships_window/);
});

test("the slug format constraint holds", async () => {
  const msg = await fails(() =>
    q(
      `insert into public.scholarships (slug, name, award_cents) values ('Bad Slug','X',5000)`,
    ),
  );
  assert.match(msg, /scholarships_slug_format/);
});

test("mentor_calls is capped at 20", async () => {
  const msg = await fails(() =>
    q(
      `insert into public.scholarships (slug, name, award_type, mentor_calls)
       values ('too-many','Too many','mentor_calls',99)`,
    ),
  );
  assert.match(msg, /mentor_calls/);
});

test("one application per student per scholarship", async () => {
  const user = await newProfile("dupe@example.com");
  const s = await newScholarship();
  await q(
    "insert into public.scholarship_applications (scholarship_id, user_id) values ($1,$2)",
    [s, user],
  );
  const msg = await fails(() =>
    q(
      "insert into public.scholarship_applications (scholarship_id, user_id) values ($1,$2)",
      [s, user],
    ),
  );
  assert.match(msg, /duplicate key|unique/i);
});

test("ONE LIVE AWARD PER STUDENT PER COHORT is enforced by the database", async () => {
  // The rule the UI states and the eligibility check enforces. This index is
  // the backstop that survives a bug in either.
  const user = await newProfile("oneaward@example.com");
  const cohort = await newCohort("Cohort 1");
  const a = await newScholarship({ slug: "need-a" });
  const b = await newScholarship({ slug: "merit-b" });

  await q(
    `insert into public.scholarship_applications (scholarship_id, user_id, cohort_id, status)
     values ($1,$2,$3,'awarded')`,
    [a, user, cohort],
  );

  const msg = await fails(() =>
    q(
      `insert into public.scholarship_applications (scholarship_id, user_id, cohort_id, status)
       values ($1,$2,$3,'awarded')`,
      [b, user, cohort],
    ),
  );
  assert.match(msg, /duplicate key|unique/i);
});

test("declined and withdrawn rows never collide — the index is partial", async () => {
  // A student may accumulate several of these; if the index weren't partial
  // the second decline would fail and the reviewer would be stuck.
  const user = await newProfile("many@example.com");
  const cohort = await newCohort("Cohort 2");
  for (const [i, status] of ["declined", "withdrawn", "declined"].entries()) {
    const s = await newScholarship({ slug: `decl-${i}` });
    await q(
      `insert into public.scholarship_applications (scholarship_id, user_id, cohort_id, status)
       values ($1,$2,$3,$4)`,
      [s, user, cohort, status],
    );
  }
  const r = await q<{ n: number }>(
    "select count(*)::int as n from public.scholarship_applications where user_id = $1",
    [user],
  );
  assert.equal(r.rows[0].n, 3);
});

test("a student can hold an award in a second cohort", async () => {
  // The index is (user_id, cohort_id), not (user_id) — a returning student
  // must not be blocked forever by an award from a past cohort.
  const user = await newProfile("returning@example.com");
  const c1 = await newCohort("Cohort A");
  const c2 = await newCohort("Cohort B");
  const a = await newScholarship({ slug: "ret-a" });
  const b = await newScholarship({ slug: "ret-b" });

  await q(
    `insert into public.scholarship_applications (scholarship_id, user_id, cohort_id, status)
     values ($1,$2,$3,'awarded')`,
    [a, user, c1],
  );
  await q(
    `insert into public.scholarship_applications (scholarship_id, user_id, cohort_id, status)
     values ($1,$2,$3,'awarded')`,
    [b, user, c2],
  );
  const r = await q<{ n: number }>(
    "select count(*)::int as n from public.scholarship_applications where user_id = $1 and status = 'awarded'",
    [user],
  );
  assert.equal(r.rows[0].n, 2);
});

test("status and fulfillment only accept their documented values", async () => {
  const user = await newProfile("bogus@example.com");
  const s = await newScholarship({ slug: "bogus" });

  const badStatus = await fails(() =>
    q(
      "insert into public.scholarship_applications (scholarship_id, user_id, status) values ($1,$2,'approved')",
      [s, user],
    ),
  );
  assert.match(badStatus, /status/);

  const badFulfillment = await fails(() =>
    q(
      "insert into public.scholarship_applications (scholarship_id, user_id, fulfillment) values ($1,$2,'paid')",
      [s, user],
    ),
  );
  assert.match(badFulfillment, /fulfillment/);
});

test("deleting a scholarship cascades its applications", async () => {
  // The reason deleteScholarship() refuses once anyone has applied: the FK
  // really does take the award rows with it.
  const user = await newProfile("cascade@example.com");
  const s = await newScholarship({ slug: "cascade" });
  await q(
    "insert into public.scholarship_applications (scholarship_id, user_id) values ($1,$2)",
    [s, user],
  );
  await q("delete from public.scholarships where id = $1", [s]);
  const r = await q<{ n: number }>(
    "select count(*)::int as n from public.scholarship_applications where scholarship_id = $1",
    [s],
  );
  assert.equal(r.rows[0].n, 0);
});

test("the answer-store columns exist on applications and default to {}", async () => {
  const user = await newProfile("answers@example.com");
  const r = await q<{
    custom_answers: unknown;
    scholarship_answers: unknown;
  }>(
    `insert into public.applications (user_id) values ($1)
     returning custom_answers, scholarship_answers`,
    [user],
  );
  assert.deepEqual(r.rows[0].custom_answers, {});
  assert.deepEqual(r.rows[0].scholarship_answers, {});
});

test("interview_requests carries the scholarship link, nullable and set-null", async () => {
  const user = await newProfile("call@example.com");
  const s = await newScholarship({
    slug: "learner",
    award_type: "mentor_calls",
    award_cents: 0,
    mentor_calls: 3,
  });
  const app = await q<{ id: string }>(
    "insert into public.scholarship_applications (scholarship_id, user_id, status, mentor_calls_awarded) values ($1,$2,'awarded',3) returning id",
    [s, user],
  );
  const appId = app.rows[0].id;

  const req = await q<{ id: string }>(
    "insert into public.interview_requests (student_id, scholarship_application_id) values ($1,$2) returning id",
    [user, appId],
  );

  // Deleting the award must NOT erase the record of a call that happened.
  await q("delete from public.scholarship_applications where id = $1", [appId]);
  const after = await q<{ scholarship_application_id: string | null }>(
    "select scholarship_application_id from public.interview_requests where id = $1",
    [req.rows[0].id],
  );
  assert.equal(after.rows.length, 1, "the request itself must survive");
  assert.equal(after.rows[0].scholarship_application_id, null);
});

test("touch_updated_at fires on both new tables", async () => {
  const s = await newScholarship({ slug: "touched" });
  const before = await q<{ updated_at: string }>(
    "select updated_at from public.scholarships where id = $1",
    [s],
  );
  await q(
    "update public.scholarships set name = 'Renamed' where id = $1",
    [s],
  );
  const after = await q<{ updated_at: string }>(
    "select updated_at from public.scholarships where id = $1",
    [s],
  );
  assert.ok(
    new Date(after.rows[0].updated_at) >= new Date(before.rows[0].updated_at),
    "scholarships.updated_at must advance",
  );

  const user = await newProfile("touch2@example.com");
  const app = await q<{ id: string }>(
    "insert into public.scholarship_applications (scholarship_id, user_id) values ($1,$2) returning id",
    [s, user],
  );
  await q(
    "update public.scholarship_applications set status = 'submitted' where id = $1",
    [app.rows[0].id],
  );
  const r = await q<{ n: number }>(
    `select count(*)::int as n from pg_trigger
     where tgname = 'touch_scholarship_applications'`,
  );
  assert.equal(r.rows[0].n, 1);
});

test("migration 0071 grants no role a scholarship permission", async () => {
  // Deliberate: both keys are admin-area, so granting either to `mentor` would
  // hand every mentor the whole admin panel. lib/permissions.test.ts pins the
  // code side of the same rule.
  const r = await q<{ slug: string; permissions: string[] }>(
    "select slug, permissions from public.app_roles order by slug",
  );
  const mentor = r.rows.find((x: { slug: string }) => x.slug === "mentor");
  assert.ok(mentor);
  assert.deepEqual(mentor.permissions, ["mentor.panel"]);
});
