import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0096 (events.live_primary_host_id), executed for real: applied,
 * re-applied, and its foreign key exercised — a deleted profile must free the
 * primary seat rather than block the delete or leave a dangling id.
 */

const migration = await readFile(
  new URL("../supabase/migrations/0096_live_stage.sql", import.meta.url),
  "utf8",
);

const HOST = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";
const NOBODY = "33333333-3333-4333-8333-333333333333";

/** The shape 0096 assumes: events and profiles, reduced to what it touches. */
async function setup() {
  const db = new PGlite();
  await db.exec(`
    create table public.profiles (id uuid primary key, full_name text);
    create table public.events (
      id uuid primary key,
      title text not null,
      starts_at timestamptz not null,
      live_started_at timestamptz,
      live_ended_at timestamptz
    );
  `);
  return db;
}

test("0096 applies and re-applies cleanly", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(migration);
  const col = await db.query<{ data_type: string; is_nullable: string }>(
    `select data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'events'
        and column_name = 'live_primary_host_id'`,
  );
  assert.equal(col.rows.length, 1);
  assert.equal(col.rows[0].data_type, "uuid");
  assert.equal(col.rows[0].is_nullable, "YES");
  // Re-applying must not stack a second foreign key.
  const fks = await db.query<{ n: number }>(
    `select count(*)::int as n from pg_constraint
      where conrelid = 'public.events'::regclass and contype = 'f'`,
  );
  assert.equal(fks.rows[0].n, 1);
});

test("existing events start with no primary", async () => {
  const db = await setup();
  await db.exec(
    `insert into public.events (id, title, starts_at) values ('${EVENT}', 'W', now())`,
  );
  await db.exec(migration);
  const r = await db.query<{ p: string | null }>(
    `select live_primary_host_id as p from public.events where id = '${EVENT}'`,
  );
  assert.equal(r.rows[0].p, null);
});

test("the primary must be a real profile, and deleting it frees the seat", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(`
    insert into public.profiles (id, full_name) values ('${HOST}', 'Ana');
    insert into public.events (id, title, starts_at, live_primary_host_id)
      values ('${EVENT}', 'W', now(), '${HOST}');
  `);
  await assert.rejects(
    db.exec(
      `update public.events set live_primary_host_id = '${NOBODY}' where id = '${EVENT}'`,
    ),
    /foreign key/i,
  );
  await db.exec(`delete from public.profiles where id = '${HOST}'`);
  const r = await db.query<{ p: string | null }>(
    `select live_primary_host_id as p from public.events where id = '${EVENT}'`,
  );
  assert.equal(r.rows[0].p, null);
});
