/** Isolated PostgreSQL integration test for migration 0092; NEVER connects to
 * linked Supabase.
 *
 * Run: node --test scripts/test-call-cohosts-db.mts
 * Requires @electric-sql/pglite (dev dependency), or set BATCH0_PGLITE_MODULE
 * to an absolute installed module path.
 *
 * Why this exists: 0092 rewrites the read and update policies on
 * `call_invites` — the table of private calls with minors — and gives the new
 * `call_invite_cohosts` table a read policy that looks back at call_invites.
 * Two policies that each consult the other's table are the textbook way to
 * get "infinite recursion detected in policy", which Postgres reports only
 * when a query actually runs, as a signed-in user. And the whole point of
 * these policies is who they let in and who they keep out, which reading the
 * SQL cannot prove. So this executes the REAL 0059 and the REAL 0092, then
 * queries AS each kind of person, with RLS in force.
 *
 * What it covers:
 *   - 0092 applies on top of 0059, and re-applies without changing anything
 *   - a co-host can read the call and who else is on it
 *   - an unrelated mentor can read neither
 *   - the student can read both — they should know who will be in the room
 *   - an admin can read both (the safeguarding view), without being on it
 *   - reading across both tables raises no recursion error, for anyone
 *   - nobody signed in can add themselves (or anyone) as a co-host
 *   - a co-host can update the call; an outsider's update touches nothing
 *   - co-host rows go with their call, and with their profile
 *   - run over the earlier 0087 draft, it drops that draft's uid-taking
 *     is_call_participant(uuid, uuid)
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
 * Typed wrapper over PGlite's untyped `query` — see the same helper in
 * scripts/test-scholarships-db.mts for why it exists (`db` is `any`, because
 * the module is imported dynamically).
 */
async function q<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<{ rows: T[] }> {
  return (await db.query(sql, params)) as { rows: T[] };
}

const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";
const HOST = "aaaaaaaa-0000-4000-8000-000000000002"; // mentor who sent it
const COHOST = "aaaaaaaa-0000-4000-8000-000000000003"; // investor added to it
const OTHER_MENTOR = "aaaaaaaa-0000-4000-8000-000000000004"; // not on it
const STUDENT = "aaaaaaaa-0000-4000-8000-000000000005";
const OTHER_STUDENT = "aaaaaaaa-0000-4000-8000-000000000006";
const LEAVER = "aaaaaaaa-0000-4000-8000-000000000007"; // a co-host whose account goes

/**
 * The slice of 0001..0091 that 0059 and 0092 depend on, plus a settable
 * `auth.uid()`. Hand-built rather than replaying ninety files: PGlite has no
 * Supabase auth schema, and replaying them all would be testing those files,
 * not these two. What matters is that the shape here matches production —
 * the same is_admin() (0048: the '*' wildcard), the same Supabase default
 * grants, so a missing write policy is tested for real rather than passing
 * because `authenticated` had no table privilege to begin with.
 */
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema if not exists auth;

  -- The signed-in user, as PostgREST would set it. Empty means the service
  -- role (no 'sub' claim), which is how every server action reaches the DB.
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;

  -- Supabase's default privileges: every table and function a later
  -- migration creates in public is granted to both API roles.
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;

  create table public.profiles (
    id uuid primary key,
    full_name text,
    role text not null default 'student'
  );
  create table public.app_roles (
    slug text primary key,
    permissions text[] not null default '{}'
  );
  insert into public.app_roles values
    ('admin', array['*']),
    ('mentor', array['mentor.panel']),
    ('investor', array['investor.panel']),
    ('student', array['student.dashboard']);

  -- 0048_custom_roles.sql — the RLS predicates 0059 and 0092 use.
  create or replace function public.is_admin(uid uuid)
  returns boolean language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from public.profiles p
      join public.app_roles r on r.slug = p.role
      where p.id = uid and r.permissions @> array['*']::text[]
    ) $$;
  create or replace function public.has_permission(uid uuid, perm text)
  returns boolean language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from public.profiles p
      join public.app_roles r on r.slug = p.role
      where p.id = uid
        and (r.permissions @> array['*']::text[] or r.permissions @> array[perm])
    ) $$;

  -- 0001_init.sql — the shared trigger function 0059 attaches.
  create or replace function public.touch_updated_at()
  returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end $$;

  insert into public.profiles (id, full_name, role) values
    ('${ADMIN}', 'An Admin', 'admin'),
    ('${HOST}', 'Marcus Mentor', 'mentor'),
    ('${COHOST}', 'Priya Investor', 'investor'),
    ('${OTHER_MENTOR}', 'Other Mentor', 'mentor'),
    ('${STUDENT}', 'Ana Student', 'student'),
    ('${OTHER_STUDENT}', 'Ben Student', 'student'),
    ('${LEAVER}', 'Leaving Mentor', 'mentor');
`);

const CALLS = await readFile(
  new URL("../supabase/migrations/0059_call_invites.sql", import.meta.url),
  "utf8",
);
const COHOSTS = await readFile(
  new URL("../supabase/migrations/0092_call_cohosts.sql", import.meta.url),
  "utf8",
);

// PGlite has no PostgREST listening, so 0092's closing `notify pgrst` goes
// nowhere — and NOTIFY with a payload is valid Postgres, so it stays in.
await db.exec(CALLS);
await db.exec(COHOSTS);

/** One call: HOST invited STUDENT, with COHOST and LEAVER on the staff side. */
async function seedCall(): Promise<string> {
  const { rows } = await q<{ id: string }>(
    `insert into public.call_invites (host_id, invitee_id, starts_at, topic, status)
     values ($1, $2, now() + interval '1 day' + (random() * interval '1 hour'), 'Panel', 'accepted')
     returning id`,
    [HOST, STUDENT],
  );
  const id = rows[0].id;
  await q(
    `insert into public.call_invite_cohosts (invite_id, profile_id) values ($1, $2), ($1, $3)`,
    [id, COHOST, LEAVER],
  );
  return id;
}

/** Run `sql` as a signed-in user, with RLS in force, then drop back to the owner. */
async function as<T = Record<string, unknown>>(
  uid: string,
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: T[] }> {
  await db.exec(
    `set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`,
  );
  try {
    return await q<T>(sql, params);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

/** The error a statement raises as `uid`, or null if it ran. */
async function refusal(uid: string, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await as(uid, sql, params);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

type Policy = {
  tablename: string;
  policyname: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
};

async function policies(): Promise<Policy[]> {
  const { rows } = await q<Policy>(
    `select tablename, policyname, cmd, qual, with_check from pg_policies
      where tablename in ('call_invites', 'call_invite_cohosts')
      order by tablename, policyname`,
  );
  return rows;
}

test("0092 applies on top of 0059, and re-applies without changing anything", async () => {
  const before = await policies();
  const id = await seedCall();

  // Re-running is routine here — migrations are pasted by hand.
  await db.exec(COHOSTS);
  await db.exec(COHOSTS);

  assert.deepEqual(await policies(), before, "re-running must leave the policies as they were");
  const { rows } = await q<{ n: number }>(
    "select count(*)::int as n from public.call_invite_cohosts where invite_id = $1",
    [id],
  );
  assert.equal(rows[0].n, 2, "re-running must not touch existing co-hosts");

  // Signed-in users get exactly one policy on the join table, and it reads.
  const cohostPolicies = before.filter((p) => p.tablename === "call_invite_cohosts");
  assert.deepEqual(
    cohostPolicies.map((p) => p.cmd),
    ["SELECT"],
    "call_invite_cohosts must have a read policy and no write policy",
  );
  // 0059's insert and delete policies are untouched; read and update gained
  // the co-host clause and kept every clause they had.
  const names = before
    .filter((p) => p.tablename === "call_invites")
    .map((p) => p.policyname);
  assert.deepEqual(names, [
    "call_invites host delete",
    "call_invites host insert",
    "call_invites read",
    "call_invites update",
  ]);
  const rewritten = before.filter(
    (p) => p.policyname === "call_invites read" || p.policyname === "call_invites update",
  );
  for (const p of rewritten) {
    for (const clause of ["is_admin", "host_id", "invitee_id", "is_call_cohost"]) {
      assert.match(p.qual ?? "", new RegExp(clause), `${p.policyname} lost ${clause}`);
    }
  }
});

test("the foreign keys carry the names lib/calls.ts embeds by", async () => {
  // PostgREST embeds are hinted by constraint name (COHOSTS_EMBED). A hint
  // that names no constraint is PGRST200 — the same error as "0092 hasn't
  // run", which the reads deliberately fall back on. So a misnamed hint would
  // not fail loudly: every call would quietly read as having no co-hosts.
  const { rows } = await q<{ conname: string }>(
    `select conname from pg_constraint
      where conrelid = 'public.call_invite_cohosts'::regclass and contype = 'f'
      order by conname`,
  );
  assert.deepEqual(
    rows.map((r) => r.conname),
    ["call_invite_cohosts_invite_id_fkey", "call_invite_cohosts_profile_id_fkey"],
  );
  const calls = await readFile(new URL("../lib/calls.ts", import.meta.url), "utf8");
  for (const r of rows) {
    assert.ok(calls.includes(`!${r.conname}`), `lib/calls.ts should embed by ${r.conname}`);
  }
});

test("a co-host can read the call and everyone else on it", async () => {
  const id = await seedCall();
  const invite = await as(COHOST, "select id, host_id from public.call_invites where id = $1", [id]);
  assert.equal(invite.rows.length, 1, "the co-host must see the call they are on");
  const team = await as<{ profile_id: string }>(
    COHOST,
    "select profile_id from public.call_invite_cohosts where invite_id = $1 order by profile_id",
    [id],
  );
  assert.deepEqual(
    team.rows.map((r) => r.profile_id).sort(),
    [COHOST, LEAVER].sort(),
  );
});

test("an unrelated mentor can read neither the call nor who is on it", async () => {
  const id = await seedCall();
  const invite = await as(OTHER_MENTOR, "select id from public.call_invites where id = $1", [id]);
  const team = await as(OTHER_MENTOR, "select 1 from public.call_invite_cohosts where invite_id = $1", [id]);
  assert.equal(invite.rows.length + team.rows.length, 0, "a mentor not on the call sees nothing");

  const student = await as(OTHER_STUDENT, "select id from public.call_invites where id = $1", [id]);
  const studentTeam = await as(OTHER_STUDENT, "select 1 from public.call_invite_cohosts where invite_id = $1", [id]);
  assert.equal(student.rows.length + studentTeam.rows.length, 0, "another student sees nothing");
});

test("the student, the host and an admin can read the call and its team", async () => {
  const id = await seedCall();
  for (const [who, uid] of [
    ["student", STUDENT],
    ["host", HOST],
    ["admin (not on the call)", ADMIN],
  ] as const) {
    const invite = await as(uid, "select id from public.call_invites where id = $1", [id]);
    const team = await as(uid, "select profile_id from public.call_invite_cohosts where invite_id = $1", [id]);
    assert.equal(invite.rows.length, 1, `${who} should see the call`);
    assert.equal(team.rows.length, 2, `${who} should see who else is on it`);
  }
});

test("reading across both tables raises no policy recursion, for anyone", async () => {
  await seedCall();
  // Each table's policy consults the other table. Written as plain
  // subqueries that is "infinite recursion detected in policy" the moment a
  // signed-in user reads either one — so read both, joined both ways, as
  // every kind of person.
  const reads = [
    `select ci.id,
            (select count(*) from public.call_invite_cohosts cc where cc.invite_id = ci.id) as team
       from public.call_invites ci`,
    `select cc.invite_id, ci.topic
       from public.call_invite_cohosts cc
       left join public.call_invites ci on ci.id = cc.invite_id`,
  ];
  for (const uid of [ADMIN, HOST, COHOST, OTHER_MENTOR, STUDENT, OTHER_STUDENT]) {
    for (const sql of reads) {
      const err = await refusal(uid, sql);
      assert.equal(err, null, `reading as ${uid} failed: ${err}`);
    }
  }
});

test("the predicates answer only about the signed-in user", async () => {
  const id = await seedCall();
  const ask = (uid: string) =>
    as<{ cohost: boolean; participant: boolean }>(
      uid,
      "select public.is_call_cohost($1) as cohost, public.is_call_participant($1) as participant",
      [id],
    );
  assert.deepEqual((await ask(COHOST)).rows[0], { cohost: true, participant: true });
  assert.deepEqual((await ask(STUDENT)).rows[0], { cohost: false, participant: true });
  assert.deepEqual((await ask(HOST)).rows[0], { cohost: false, participant: true });
  assert.deepEqual((await ask(OTHER_MENTOR)).rows[0], { cohost: false, participant: false });
  // They take no user id, so nobody can ask "is THIS person on THAT call"
  // about someone else over /rest/v1/rpc.
  const { rows } = await q<{ n: number }>(
    `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('is_call_cohost', 'is_call_participant')
        and p.pronargs <> 1`,
  );
  assert.equal(rows[0].n, 0);
});

test("0092 over the earlier draft drops its uid-taking predicate", async () => {
  // The draft of this migration (numbered 0087, never merged) created a
  // two-argument is_call_participant(invite, uid) and a read policy that
  // called it. `create or replace` with a new signature only adds an
  // overload, so without an explicit drop a database that ran the draft
  // keeps a function any signed-in user can ask about anyone. Recreate the
  // draft's state, re-run 0092, and check the oracle is gone.
  const id = await seedCall();
  const before = await policies();
  await db.exec(`
    create or replace function public.is_call_participant(p_invite uuid, uid uuid)
    returns boolean language sql stable security definer set search_path = public as $$
      select exists (
        select 1 from public.call_invites ci
        where ci.id = p_invite and (ci.host_id = uid or ci.invitee_id = uid)
      ) or exists (
        select 1 from public.call_invite_cohosts cc
        where cc.invite_id = p_invite and cc.profile_id = uid
      ) $$;
    drop policy if exists "call_invite_cohosts read" on public.call_invite_cohosts;
    create policy "call_invite_cohosts read" on public.call_invite_cohosts
      for select using (
        public.is_admin(auth.uid())
        or public.is_call_participant(invite_id, auth.uid())
      );
  `);
  // The draft's oracle, as an unrelated student: it answers about the host.
  const leaked = await as<{ on: boolean }>(
    OTHER_STUDENT,
    "select public.is_call_participant($1::uuid, $2::uuid) as on",
    [id, HOST],
  );
  assert.equal(leaked.rows[0].on, true, "the draft's state should reproduce the oracle");

  await db.exec(COHOSTS);

  const { rows } = await q<{ n: number }>(
    `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'is_call_participant' and p.pronargs = 2`,
  );
  assert.equal(rows[0].n, 0, "the two-argument predicate must be dropped");
  assert.deepEqual(await policies(), before, "the policies must be 0092's again");
  const err = await refusal(
    OTHER_STUDENT,
    "select public.is_call_participant($1::uuid, $2::uuid)",
    [id, HOST],
  );
  assert.ok(err, "nobody can ask about someone else any more");
});

test("nobody signed in can put themselves, or anyone, on a call", async () => {
  const id = await seedCall();
  // The outsider adding themselves is the attack; the host and an admin are
  // refused too, because every co-host write goes through a server action
  // that checks roles first, on the service role.
  for (const uid of [OTHER_MENTOR, HOST, ADMIN, STUDENT]) {
    const err = await refusal(
      uid,
      "insert into public.call_invite_cohosts (invite_id, profile_id) values ($1, $2)",
      [id, OTHER_MENTOR],
    );
    assert.ok(err, `${uid} must not be able to add a co-host`);
    assert.match(err!, /row-level security/i);
  }
  // Nor take someone off one: with no delete policy the row is invisible to
  // the delete, so it is simply still there.
  await as(COHOST, "delete from public.call_invite_cohosts where invite_id = $1", [id]);
  const { rows } = await q<{ n: number }>(
    "select count(*)::int as n from public.call_invite_cohosts where invite_id = $1",
    [id],
  );
  assert.equal(rows[0].n, 2);
});

test("a co-host can update the call; an outsider's update touches nothing", async () => {
  const id = await seedCall();
  const mine = await as<{ id: string }>(
    COHOST,
    "update public.call_invites set status = 'cancelled' where id = $1 returning id",
    [id],
  );
  assert.equal(mine.rows.length, 1, "a co-host may cancel, as the host may");

  const id2 = await seedCall();
  const theirs = await as<{ id: string }>(
    OTHER_MENTOR,
    "update public.call_invites set status = 'cancelled' where id = $1 returning id",
    [id2],
  );
  assert.equal(theirs.rows.length, 0, "a mentor not on the call changes nothing");
  const { rows } = await q<{ status: string }>(
    "select status from public.call_invites where id = $1",
    [id2],
  );
  assert.equal(rows[0].status, "accepted");
});

test("co-host rows go with their call, and with their profile", async () => {
  const id = await seedCall();
  await q("delete from public.profiles where id = $1", [LEAVER]);
  let { rows } = await q<{ profile_id: string }>(
    "select profile_id from public.call_invite_cohosts where invite_id = $1",
    [id],
  );
  assert.deepEqual(rows.map((r) => r.profile_id), [COHOST], "a deleted account drops off the call");

  await q("delete from public.call_invites where id = $1", [id]);
  ({ rows } = await q<{ profile_id: string }>(
    "select profile_id from public.call_invite_cohosts where invite_id = $1",
    [id],
  ));
  assert.equal(rows.length, 0, "a deleted call takes its co-hosts with it");

  // The same person twice on one call is refused by the key, so a retried
  // write cannot double anyone up.
  await q(
    "insert into public.profiles (id, full_name, role) values ($1, 'Leaving Mentor', 'mentor') on conflict do nothing",
    [LEAVER],
  );
  const id2 = await seedCall();
  await assert.rejects(
    q("insert into public.call_invite_cohosts (invite_id, profile_id) values ($1, $2)", [id2, COHOST]),
    /duplicate key|unique/i,
  );
});
