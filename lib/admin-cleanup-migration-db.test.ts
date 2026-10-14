import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATION_PROBES } from "./pending-migrations.ts";

// Executes supabase/migrations/0100_admin_cleanup.sql against a minimal
// fixture of the two tables it touches (shapes from 0039 and 0048).

const migration = await readFile(
  new URL("../supabase/migrations/0100_admin_cleanup.sql", import.meta.url),
  "utf8",
);
const admin = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create table public.profiles (id uuid primary key);
    create table public.app_roles (
      slug text primary key,
      permissions text[] not null default '{}'
    );
    create table public.founder_passes (
      id uuid primary key default gen_random_uuid(),
      serial integer not null unique,
      code_hash text not null unique,
      batch text not null default 'cards-01',
      redeemed_by uuid references public.profiles(id) on delete set null,
      revoked_at timestamptz
    );
  `);
  await db.query("insert into public.profiles values ($1)", [admin]);
  await db.exec(`
    insert into public.app_roles (slug, permissions) values
      ('admin', array['*']),
      ('intern', array['applications.view','ai_usage.view','pulse.view']),
      ('analyst', array['ai_usage.view']),
      ('student', array['student.dashboard']);
  `);
  await db.query(
    `insert into public.founder_passes (serial, code_hash, batch, redeemed_by, revoked_at) values
       (1, 'h1', 'cards-01', null, null),
       (2, 'h2', 'virtual-01', $1, null),
       (3, 'h3', 'selftest', null, now()),
       (-1, 'p1', 'selftest', null, null),
       (-2, 'p2', 'selftest', $1, null)`,
    [admin],
  );
  return db;
}

test("0100 strips ai_usage.view from every role and touches nothing else", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    const roles = (
      await db.query<{ slug: string; permissions: string[] }>(
        "select slug, permissions from public.app_roles order by slug",
      )
    ).rows;
    assert.deepEqual(roles, [
      { slug: "admin", permissions: ["*"] },
      { slug: "analyst", permissions: [] },
      { slug: "intern", permissions: ["applications.view", "pulse.view"] },
      { slug: "student", permissions: ["student.dashboard"] },
    ]);
  } finally {
    await db.close();
  }
});

test("0100 deletes only negative-serial self-check probes", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    const serials = (
      await db.query<{ serial: number }>("select serial from public.founder_passes order by serial")
    ).rows.map((r) => r.serial);
    // A real pass in a batch that happens to be named 'selftest' survives.
    assert.deepEqual(serials, [1, 2, 3]);
  } finally {
    await db.close();
  }
});

test("0100 is idempotent", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    await db.exec(migration);
    const intern = (
      await db.query<{ permissions: string[] }>(
        "select permissions from public.app_roles where slug = 'intern'",
      )
    ).rows[0];
    assert.deepEqual(intern.permissions, ["applications.view", "pulse.view"]);
    const count = (
      await db.query<{ n: number }>("select count(*)::int as n from public.founder_passes")
    ).rows[0].n;
    assert.equal(count, 3);
  } finally {
    await db.close();
  }
});

/**
 * The admin overview's leftover probe for `migration`, as SQL: PostgREST's
 * `cs` filter is `@>`. Run against the fixture, it proves the probe names
 * real columns and sees exactly what the migration removes.
 */
function leftoverProbeSql(migration: string): string {
  const p = MIGRATION_PROBES.find((x) => x.migration === migration && x.leftover);
  assert.ok(p?.leftover, `no leftover probe for ${migration}`);
  const values = p.leftover.values.map((v) => `'${v}'`).join(", ");
  return `select ${p.columns} from public.${p.table} where ${p.leftover.column} @> array[${values}]::text[] limit 1`;
}

test("the overview's 0100 probe finds a stale role before 0100 and none after", async () => {
  const db = await setup();
  try {
    const sql = leftoverProbeSql("0100");
    assert.equal((await db.query(sql)).rows.length, 1);
    await db.exec(migration);
    assert.equal((await db.query(sql)).rows.length, 0);
  } finally {
    await db.close();
  }
});
