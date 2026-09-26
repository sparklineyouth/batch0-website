import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration 0087, executed for real against a throwaway Postgres — on top of
 * the REAL 0036 and 0047 it amends, with pre-0087 rows in place, then applied a
 * second time.
 *
 * 0087 widens a CHECK on a table with live rows, drops a unique index and an
 * RLS policy, backfills two tables from existing data, and `create or replace`s
 * a view (which only works if every existing column keeps its name and
 * position). Each of those fails at apply time, not at read time, so this is
 * the cheapest place to find out.
 *
 * As in webinars-migration-db.test.ts, auth.uid() is a stub returning null:
 * this proves the DDL applies and re-applies, not what the policies decide.
 */

const read = (f: string) =>
  readFile(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8");
const [m0036, m0047, m0087] = await Promise.all([
  read("0036_weekly_challenges.sql"),
  read("0047_challenge_uploads_bucket.sql"),
  read("0087_hackathons.sql"),
]);

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const OLD_CHALLENGE = "33333333-3333-4333-8333-333333333333";

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists storage;
    create schema if not exists auth;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated;
      end if;
    end $$;
    create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;

    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;

    create table public.profiles (id uuid primary key, email text, full_name text, role text, referral_code text);
    create table public.site_settings (key text primary key, value jsonb);
    create or replace function public.is_admin(uid uuid) returns boolean language sql stable as $$ select false $$;
    create or replace function public.has_permission(uid uuid, perm text) returns boolean language sql stable as $$ select false $$;
    create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
      begin new.updated_at = now(); return new; end $$;

    insert into public.profiles (id, email, full_name, referral_code) values
      ('${ALICE}', 'a@x.co', 'Alice A', 'alicecode'),
      ('${BOB}', 'b@x.co', 'Bob B', 'bobcode');
  `);
  // notify is a no-op without listeners; PGlite accepts it.
  await db.exec(m0036);
  await db.exec(m0047);

  // A pre-0087 world: a closed challenge with a one-line prize and one entry.
  await db.exec(`
    insert into public.challenges (id, slug, title, status, prize_label, prize_amount_cents, closes_at)
    values ('${OLD_CHALLENGE}', 'old', 'Old one', 'closed', 'up to $250', 25000, now() - interval '30 days');
    insert into public.challenge_submissions (challenge_id, user_id, status, referral_code)
    values ('${OLD_CHALLENGE}', '${ALICE}', 'rejected', 'bobcode');
  `);
  return db;
}

test("0087 applies over 0036/0047 with live rows, and re-applies", async () => {
  const db = await setup();
  await db.exec(m0087);
  await db.exec(m0087); // idempotent

  // Legacy prize lifted into a structured prize — exactly once.
  const { rows: ch } = await db.query<any>(
    `select kind, cover_theme, location, referrals_required, allow_edits, prizes from public.challenges where id = $1`,
    [OLD_CHALLENGE],
  );
  assert.equal(ch[0].kind, "challenge");
  assert.equal(ch[0].cover_theme, "phosphor");
  assert.equal(ch[0].location, "Online");
  assert.equal(ch[0].referrals_required, 0);
  assert.equal(ch[0].allow_edits, true);
  assert.equal(ch[0].prizes.length, 1);
  assert.equal(ch[0].prizes[0].title, "up to $250");
  assert.equal(ch[0].prizes[0].kind, "cash");
  assert.equal(ch[0].prizes[0].valueCents, 25000);

  // Old submitter backfilled as registered, carrying their referral code.
  const { rows: regs } = await db.query<any>(
    `select user_id, referral_code from public.challenge_registrations where challenge_id = $1`,
    [OLD_CHALLENGE],
  );
  assert.equal(regs.length, 1);
  assert.equal(regs[0].user_id, ALICE);
  assert.equal(regs[0].referral_code, "bobcode");

  // submitted_at backfilled for non-drafts.
  const { rows: subs } = await db.query<any>(
    `select submitted_at is not null as has_ts from public.challenge_submissions`,
  );
  assert.equal(subs[0].has_ts, true);
});

test("drafts are a valid status and the new default", async () => {
  const db = await setup();
  await db.exec(m0087);
  await db.query(
    `insert into public.challenge_submissions (challenge_id, user_id) values ($1, $2)`,
    [OLD_CHALLENGE, BOB],
  );
  const { rows } = await db.query<any>(
    `select status, submitted_at from public.challenge_submissions where user_id = $1`,
    [BOB],
  );
  assert.equal(rows[0].status, "draft");
  assert.equal(rows[0].submitted_at, null);
  await assert.rejects(
    db.query(`update public.challenge_submissions set status = 'bogus' where user_id = $1`, [BOB]),
  );
});

test("several challenges can be live at once", async () => {
  const db = await setup();
  await db.exec(m0087);
  await db.exec(`
    insert into public.challenges (slug, title, status) values ('a', 'A', 'active'), ('b', 'B', 'active');
  `);
  const { rows } = await db.query<any>(`select count(*)::int as n from public.challenges where status = 'active'`);
  assert.equal(rows[0].n, 2);
});

test("new constraints reject bad values", async () => {
  const db = await setup();
  await db.exec(m0087);
  await assert.rejects(db.query(`update public.challenges set kind = 'party' where id = $1`, [OLD_CHALLENGE]));
  await assert.rejects(db.query(`update public.challenges set cover_theme = 'neon' where id = $1`, [OLD_CHALLENGE]));
  await assert.rejects(db.query(`update public.challenges set referrals_required = 51 where id = $1`, [OLD_CHALLENGE]));
  await assert.rejects(db.query(`update public.challenges set referrals_required = -1 where id = $1`, [OLD_CHALLENGE]));
});

test("one registration per user per challenge", async () => {
  const db = await setup();
  await db.exec(m0087);
  await assert.rejects(
    db.query(`insert into public.challenge_registrations (challenge_id, user_id) values ($1, $2)`, [OLD_CHALLENGE, ALICE]),
  );
});

test("the self-insert submission policy is gone; the winners view gained award columns", async () => {
  const db = await setup();
  await db.exec(m0087);
  const { rows: pol } = await db.query<any>(
    `select policyname from pg_policies where tablename = 'challenge_submissions'`,
  );
  const names = pol.map((p) => p.policyname);
  assert.ok(!names.includes("challenge_submissions self insert"));
  assert.ok(names.includes("challenge_submissions self select"));

  const { rows: cols } = await db.query<any>(
    `select column_name from information_schema.columns where table_name = 'challenge_winners_public' order by ordinal_position`,
  );
  assert.deepEqual(
    cols.map((c) => c.column_name),
    [
      "id", "challenge_id", "challenge_slug", "challenge_title", "public_name",
      "public_blurb", "public_project_url", "payout_amount_cents", "funded_at",
      "award_label", "prize_id",
    ],
  );
});

test("upload bucket accepts any type now; media bucket is public", async () => {
  const db = await setup();
  await db.exec(m0087);
  const { rows } = await db.query<any>(
    `select id, public, allowed_mime_types, file_size_limit from storage.buckets order by id`,
  );
  const up = rows.find((r) => r.id === "challenge-uploads");
  const media = rows.find((r) => r.id === "challenge-media");
  assert.equal(up.public, false);
  assert.equal(up.allowed_mime_types, null);
  assert.ok(Number(up.file_size_limit) >= 209715200);
  assert.equal(media.public, true);
});
