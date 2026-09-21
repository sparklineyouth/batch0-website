/** Isolated PostgreSQL integration test for migration 0077; NEVER connects to
 * linked Supabase.
 *
 * Run: node --test scripts/test-profile-privileges-db.mts
 * Requires @electric-sql/pglite (dev dependency), or set BATCH0_PGLITE_MODULE
 * to an absolute installed module path.
 *
 * Why this exists: 0077 closes a live privilege escalation — `profiles self
 * update` (0001) restricts which ROW you may update and says nothing about
 * which COLUMNS, so a signed-in student could PATCH `role = 'admin'` onto
 * their own profile over PostgREST with the public anon key. That was
 * confirmed against the real database before this migration was written.
 *
 * A fix for something like that must not be verified by reading it. This
 * executes the REAL migration file and then tries the actual attack, as the
 * actual attacker: as a non-admin user, in their own row.
 *
 * What it covers:
 *   - the migration applies cleanly, and is idempotent
 *   - a student CANNOT promote themselves to admin  <- the vulnerability
 *   - a student cannot rewrite the other guarded columns either
 *   - a student CAN still change their own full_name (the settings page)
 *   - an admin can still change roles from the browser
 *   - the server (service role, auth.uid() IS NULL) is unaffected
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

async function q<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<{ rows: T[] }> {
  return (await db.query(sql, params)) as { rows: T[] };
}

const STUDENT = "11111111-1111-1111-1111-111111111111";
const ADMIN = "22222222-2222-2222-2222-222222222222";

/**
 * The slice of 0001 that 0077 depends on, plus a settable `auth.uid()`.
 *
 * Hand-built rather than replaying seventy-six files: PGlite has no Supabase
 * auth schema, and replaying them all would be testing those files, not this
 * one. What matters is that the shape here matches production — the same
 * self-update policy, the same is_admin(), the same columns.
 */
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema if not exists auth;

  -- Stands in for Supabase's auth.uid(): reads a GUC the tests set, so a
  -- statement can run "as" a given user. NULL means the service role, which
  -- is exactly how a service-role JWT (no 'sub' claim) behaves in production.
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('test.uid', true), '')::uuid
  $$;

  create table public.profiles (
    id uuid primary key,
    email text not null,
    full_name text,
    role text not null default 'student',
    stripe_customer_id text,
    discord_user_id text,
    discord_username text,
    discord_linked_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create or replace function public.is_admin(uid uuid) returns boolean
    language sql stable security definer as $$
      select exists (
        select 1 from public.profiles p where p.id = uid and p.role = 'admin'
      )
    $$;

  create or replace function public.touch_updated_at() returns trigger
    language plpgsql as $$
    begin new.updated_at = now(); return new; end $$;

  create trigger touch_profiles before update on public.profiles
    for each row execute procedure public.touch_updated_at();
`);

await db.exec(`
  insert into public.profiles (id, email, full_name, role) values
    ('${STUDENT}', 'student@example.invalid', 'A Student', 'student'),
    ('${ADMIN}',   'admin@example.invalid',   'An Admin',  'admin');
`);

/** Run a statement as a particular signed-in user (NULL = the server). */
async function as(uid: string | null, sql: string): Promise<void> {
  await db.exec(`set local test.uid = '${uid ?? ""}';`);
  await db.exec(sql);
}

/** Run `sql` as `uid` and return the error message, or null if it succeeded. */
async function attempt(uid: string | null, sql: string): Promise<string | null> {
  try {
    await db.exec("begin;");
    await as(uid, sql);
    await db.exec("commit;");
    return null;
  } catch (err) {
    await db.exec("rollback;").catch(() => {});
    return err instanceof Error ? err.message : String(err);
  }
}

async function roleOf(id: string): Promise<string> {
  const { rows } = await q<{ role: string }>(
    "select role from public.profiles where id = $1",
    [id],
  );
  return rows[0].role;
}

const migration = await readFile(
  new URL("../supabase/migrations/0077_lock_profile_privileges.sql", import.meta.url),
  "utf8",
);

test("0077 applies cleanly and is idempotent", async () => {
  await db.exec(migration);
  // Re-running a migration is routine here — they are applied by hand.
  await db.exec(migration);

  const { rows } = await q(
    `select 1 from pg_trigger
      where tgname = 'guard_profile_privileges'
        and tgrelid = 'public.profiles'::regclass`,
  );
  assert.equal(rows.length, 1, "the guard trigger should be installed");
});

test("a student CANNOT promote themselves to admin", async () => {
  // This is the exploit, exactly: the owner of the row, updating their own
  // row, setting role. RLS permits the row; the trigger must refuse the
  // column.
  const err = await attempt(
    STUDENT,
    `update public.profiles set role = 'admin' where id = '${STUDENT}'`,
  );
  assert.ok(err, "the update should have been rejected");
  assert.match(err!, /profiles\.role cannot be changed/);
  assert.equal(await roleOf(STUDENT), "student", "role must be unchanged");
});

test("a student cannot rewrite the other guarded columns", async () => {
  for (const [col, value] of [
    ["email", "'someone-else@example.invalid'"],
    ["stripe_customer_id", "'cus_stolen'"],
    ["discord_user_id", "'999999999'"],
  ] as const) {
    const err = await attempt(
      STUDENT,
      `update public.profiles set ${col} = ${value} where id = '${STUDENT}'`,
    );
    assert.ok(err, `${col} should be refused`);
    assert.match(err!, new RegExp(`profiles\\.${col} cannot be changed`));
  }
});

test("a student CAN still change their own name (the settings page)", async () => {
  // The guard must not break the one profile field the browser is meant to
  // write. If this fails, /dashboard/settings is broken.
  const err = await attempt(
    STUDENT,
    `update public.profiles set full_name = 'New Name' where id = '${STUDENT}'`,
  );
  assert.equal(err, null, `renaming should be allowed, got: ${err}`);

  const { rows } = await q<{ full_name: string }>(
    "select full_name from public.profiles where id = $1",
    [STUDENT],
  );
  assert.equal(rows[0].full_name, "New Name");
});

test("an admin can still change a role from the browser", async () => {
  const err = await attempt(
    ADMIN,
    `update public.profiles set role = 'mentor' where id = '${STUDENT}'`,
  );
  assert.equal(err, null, `an admin should be allowed, got: ${err}`);
  assert.equal(await roleOf(STUDENT), "mentor");
});

test("the server (service role) is unaffected", async () => {
  // Every privileged write in the app goes through createAdminClient(), where
  // auth.uid() is NULL. Admin role changes, Stripe linking, Discord linking
  // and the signup trigger all depend on this staying open.
  const err = await attempt(
    null,
    `update public.profiles set role = 'student', stripe_customer_id = 'cus_ok'
       where id = '${STUDENT}'`,
  );
  assert.equal(err, null, `the service role should be allowed, got: ${err}`);
  assert.equal(await roleOf(STUDENT), "student");
});

test("an admin cannot be tricked by a student re-running the exploit", async () => {
  // Regression guard: the student is back to 'student' after the test above,
  // so the original attack must still fail on a second attempt.
  const err = await attempt(
    STUDENT,
    `update public.profiles set role = 'admin' where id = '${STUDENT}'`,
  );
  assert.ok(err, "the exploit must remain closed");
  assert.equal(await roleOf(STUDENT), "student");
});
