import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATION_CHECKS } from "./migration-plan.ts";

// Executes supabase/migrations/0102_email_outbox_dedupe_index.sql against
// email_outbox as 0052 leaves it (the columns that matter here, and 0052's
// partial dedupe index), then runs the statement PostgREST builds for
// fanOutScheduled's `.upsert(rows, { onConflict: "dedupe_key",
// ignoreDuplicates: true })` in lib/email/queue.ts.

const migration = await readFile(
  new URL("../supabase/migrations/0102_email_outbox_dedupe_index.sql", import.meta.url),
  "utf8",
);

const UPSERT = `insert into public.email_outbox (to_email, dedupe_key) values ($1, $2)
  on conflict (dedupe_key) do nothing returning id`;

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create table public.email_outbox (
      id uuid primary key default gen_random_uuid(),
      to_email text not null,
      dedupe_key text
    );
    create unique index email_outbox_dedupe_key_idx
      on public.email_outbox (dedupe_key) where dedupe_key is not null;
  `);
  return db;
}

async function verified(db: PGlite): Promise<boolean | undefined> {
  return (await db.query<{ ok: boolean }>(MIGRATION_CHECKS["0102"])).rows[0]?.ok;
}

test("before 0102 the fan-out's upsert can't use 0052's partial index: 42P10, nothing queued", async () => {
  const db = await setup();
  try {
    await assert.rejects(db.query(UPSERT, ["a@example.com", "sched:1"]), (err: { code?: string }) => err?.code === "42P10");
    assert.equal(await verified(db), false);
  } finally {
    await db.close();
  }
});

test("0102: the upsert works, a re-run collapses, and keyless one-off sends never collide", async () => {
  const db = await setup();
  try {
    await db.exec(`
      insert into public.email_outbox (to_email, dedupe_key) values
        ('x@example.com', 'k1'), ('y@example.com', null), ('z@example.com', null);
    `);
    await db.exec(migration);
    assert.equal(await verified(db), true);

    assert.equal((await db.query(UPSERT, ["a@example.com", "sched:1"])).rows.length, 1);
    assert.equal((await db.query(UPSERT, ["a@example.com", "sched:1"])).rows.length, 0, "the same occurrence again is one email");
    assert.equal((await db.query(UPSERT, ["b@example.com", "k1"])).rows.length, 0, "a key already queued still wins");
    await db.query("insert into public.email_outbox (to_email) values ('w@example.com')");
    const keyless = await db.query<{ n: number }>("select count(*)::int as n from public.email_outbox where dedupe_key is null");
    assert.equal(keyless.rows[0].n, 3);
    await assert.rejects(
      db.query("insert into public.email_outbox (to_email, dedupe_key) values ('c@example.com', 'k1')"),
      (err: { code?: string }) => err?.code === "23505",
      "a plain insert of a taken key is still refused",
    );
    const indexes = await db.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'public' and tablename = 'email_outbox' order by 1",
    );
    assert.deepEqual(indexes.rows.map((r) => r.indexname), ["email_outbox_dedupe_key_uniq", "email_outbox_pkey"]);
  } finally {
    await db.close();
  }
});

test("0102 is idempotent, and does nothing where 0052 never ran", async () => {
  const db = await setup();
  try {
    await db.exec(migration);
    await db.exec(migration);
    assert.equal(await verified(db), true);
  } finally {
    await db.close();
  }
  const bare = new PGlite();
  try {
    await bare.exec(migration);
    assert.equal(await verified(bare), false);
  } finally {
    await bare.close();
  }
});
