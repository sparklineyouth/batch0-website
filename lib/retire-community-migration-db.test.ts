import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATION_PROBES } from "./pending-migrations.ts";

/**
 * Migration 0099, executed against a throwaway Postgres: applied twice, then
 * queried as a signed-in user so "students can no longer write here" is
 * asserted, not assumed. The fixture recreates the retired tables with their
 * real policy names (0005, 0011, 0027, 0068), the 0048 app_roles shape and the
 * 0089 realtime publication entry. The support tables come from 0090's own
 * SQL, so the carried-over tickets meet the real constraints and trigger.
 */

const migration = await readFile(
  new URL("../supabase/migrations/0099_retire_community.sql", import.meta.url),
  "utf8",
);
const supportMigration = await readFile(
  new URL("../supabase/migrations/0090_support_tickets.sql", import.meta.url),
  "utf8",
);

function slice(src: string, start: string, end: string, includeEnd = false): string {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i);
  assert.ok(i >= 0 && j > i, `0090 no longer contains "${start}" … "${end}"`);
  return src.slice(i, includeEnd ? j + end.length : j);
}

/** 0090 sections 1–1c (tickets, replies, their checks) and the reply trigger. */
const SUPPORT_SCHEMA = [
  slice(supportMigration, "create table if not exists public.support_tickets (", "-- 2. Attachments"),
  slice(
    supportMigration,
    "create or replace function public.support_ticket_replies_touch_ticket()",
    "for each row execute procedure public.support_ticket_replies_touch_ticket();",
    true,
  ),
].join("\n");

const USER = "11111111-1111-4111-8111-111111111111";
const ROW = "22222222-2222-4222-8222-222222222222";

const RETIRED = [
  "discussion_threads",
  "discussion_replies",
  "team_messages",
  "announcement_reactions",
  "lesson_comments",
] as const;

const READ_POLICIES = [
  ["discussion_threads", "discussion_threads read"],
  ["discussion_replies", "discussion_replies read"],
  ["team_messages", "team_messages read"],
  ["announcement_reactions", "announcement_reactions read"],
  ["lesson_comments", "lesson_comments read enrolled"],
] as const;

const WRITE_POLICIES = [
  ["discussion_threads", "discussion_threads insert"],
  ["discussion_threads", "discussion_threads update"],
  ["discussion_threads", "discussion_threads delete"],
  ["discussion_replies", "discussion_replies insert"],
  ["discussion_replies", "discussion_replies delete"],
  ["team_messages", "team_messages write"],
  ["announcement_reactions", "announcement_reactions self insert"],
  ["announcement_reactions", "announcement_reactions self delete"],
  ["lesson_comments", "lesson_comments self insert"],
  ["lesson_comments", "lesson_comments self update"],
  ["lesson_comments", "lesson_comments self delete"],
] as const;

/** One insert per table, as the signed-in USER would have sent it. */
const INSERTS: Record<(typeof RETIRED)[number], string> = {
  discussion_threads: `insert into public.discussion_threads (author_id, body) values ('${USER}', 'q')`,
  discussion_replies: `insert into public.discussion_replies (thread_id, author_id, body) values ('${ROW}', '${USER}', 'r')`,
  team_messages: `insert into public.team_messages (team_id, author_id, body) values ('${ROW}', '${USER}', 'm')`,
  announcement_reactions: `insert into public.announcement_reactions (announcement_id, user_id, emoji) values ('${ROW}', '${USER}', 'heart')`,
  lesson_comments: `insert into public.lesson_comments (lesson_id, user_id, body) values ('${ROW}', '${USER}', 'c')`,
};

async function setup(
  opts: { tables?: boolean; publication?: boolean; support?: boolean } = {},
) {
  const { tables = true, publication = true, support = true } = opts;
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated;
      end if;
    end $$;
    grant usage on schema public to anon, authenticated;
    grant usage on schema auth to anon, authenticated;
    alter default privileges in schema public
      grant all on tables to anon, authenticated;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    create table public.app_roles (
      slug text primary key,
      permissions text[] not null default '{}'
    );
    insert into public.app_roles (slug, permissions) values
      ('admin', array['*']),
      ('community', array['announcements.manage', 'discussions.manage', 'support.view']),
      ('mentor', array['mentor.panel']);
  `);

  if (support) {
    await db.exec(`
      create table public.profiles (
        id uuid primary key, email text not null, full_name text);
      create table public.payments (id uuid primary key default gen_random_uuid());
    `);
    await db.exec(SUPPORT_SCHEMA);
  }

  if (!tables) return db;

  await db.exec(`
    create table public.discussion_threads (
      id uuid primary key default gen_random_uuid(),
      author_id uuid not null, body text not null,
      visibility text not null default 'cohort',
      title text not null default 'A thread',
      needs_reply boolean not null default false,
      created_at timestamptz not null default now(),
      last_activity_at timestamptz not null default now());
    create table public.discussion_replies (
      id uuid primary key default gen_random_uuid(),
      thread_id uuid not null, author_id uuid not null, body text not null,
      is_staff boolean not null default false,
      created_at timestamptz not null default now());
    create table public.team_messages (
      id uuid primary key default gen_random_uuid(),
      team_id uuid not null, author_id uuid not null, body text not null);
    create table public.announcement_reactions (
      announcement_id uuid not null, user_id uuid not null, emoji text not null,
      primary key (announcement_id, user_id, emoji));
    create table public.lesson_comments (
      id uuid primary key default gen_random_uuid(),
      lesson_id uuid not null, user_id uuid not null, body text not null);
    create table public.dm_messages (
      id uuid primary key default gen_random_uuid(), body text not null,
      conversation_id uuid, sender_id uuid,
      created_at timestamptz not null default now(), unsent_at timestamptz);
    create table public.dm_reports (
      id uuid primary key default gen_random_uuid(),
      conversation_id uuid not null, reporter_id uuid, reason text not null,
      status text not null default 'open',
      created_at timestamptz not null default now());

    alter table public.discussion_threads enable row level security;
    alter table public.discussion_replies enable row level security;
    alter table public.team_messages enable row level security;
    alter table public.announcement_reactions enable row level security;
    alter table public.lesson_comments enable row level security;

    create policy "discussion_threads read" on public.discussion_threads for select using (true);
    create policy "discussion_threads insert" on public.discussion_threads for insert with check (author_id = auth.uid());
    create policy "discussion_threads update" on public.discussion_threads for update using (author_id = auth.uid());
    create policy "discussion_threads delete" on public.discussion_threads for delete using (author_id = auth.uid());
    create policy "discussion_replies read" on public.discussion_replies for select using (true);
    create policy "discussion_replies insert" on public.discussion_replies for insert with check (author_id = auth.uid());
    create policy "discussion_replies delete" on public.discussion_replies for delete using (author_id = auth.uid());
    create policy "team_messages read" on public.team_messages for select using (true);
    create policy "team_messages write" on public.team_messages for insert with check (author_id = auth.uid());
    create policy "announcement_reactions read" on public.announcement_reactions for select using (true);
    create policy "announcement_reactions self insert" on public.announcement_reactions for insert with check (user_id = auth.uid());
    create policy "announcement_reactions self delete" on public.announcement_reactions for delete using (user_id = auth.uid());
    create policy "lesson_comments read enrolled" on public.lesson_comments for select using (true);
    create policy "lesson_comments self insert" on public.lesson_comments for insert with check (user_id = auth.uid());
    create policy "lesson_comments self update" on public.lesson_comments for update using (user_id = auth.uid());
    create policy "lesson_comments self delete" on public.lesson_comments for delete using (user_id = auth.uid());
  `);

  if (publication) {
    await db.exec(`
      create publication supabase_realtime;
      alter publication supabase_realtime add table public.dm_messages;
    `);
  }
  return db;
}

/** Run `sql` as a signed-in user, then drop back to the owner. */
async function asUser(db: PGlite, sql: string) {
  await db.exec(
    `set role authenticated; select set_config('request.jwt.claim.sub', '${USER}', false);`,
  );
  try {
    return await db.query(sql);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

async function policies(db: PGlite) {
  const { rows } = await db.query<{ tablename: string; policyname: string }>(
    `select tablename, policyname from pg_policies where schemaname = 'public'`,
  );
  return new Set(rows.map((r) => `${r.tablename}/${r.policyname}`));
}

async function permissions(db: PGlite) {
  const { rows } = await db.query<{ slug: string; permissions: string[] }>(
    `select slug, permissions from public.app_roles order by slug`,
  );
  return Object.fromEntries(rows.map((r) => [r.slug, r.permissions]));
}

test("the fixture's write policies work before 0099 (so the next test means something)", async () => {
  const db = await setup();
  for (const table of RETIRED) await asUser(db, INSERTS[table]);
  const { rows } = await asUser(db, `select count(*)::int as n from public.team_messages`);
  assert.equal((rows[0] as any).n, 1);
});

test("0099 applies twice and drops only the client write policies", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(migration);

  const live = await policies(db);
  for (const [table, name] of WRITE_POLICIES) {
    assert.ok(!live.has(`${table}/${name}`), `${table}: "${name}" should be gone`);
  }
  for (const [table, name] of READ_POLICIES) {
    assert.ok(live.has(`${table}/${name}`), `${table}: "${name}" should stay`);
  }
});

test("after 0099 a signed-in user can still read but no longer write", async () => {
  const db = await setup();
  await db.exec(
    `insert into public.team_messages (team_id, author_id, body) values ('${ROW}', '${USER}', 'old')`,
  );
  await db.exec(migration);

  for (const table of RETIRED) {
    await assert.rejects(asUser(db, INSERTS[table]), /row-level security/, `${table} insert`);
  }
  const { rows } = await asUser(db, `select body from public.team_messages`);
  assert.deepEqual(rows, [{ body: "old" }]);

  // Update/delete have no policy either: they match zero rows.
  await asUser(db, `update public.team_messages set body = 'edited'`);
  await asUser(db, `delete from public.team_messages`);
  const after = await db.query(`select body from public.team_messages`);
  assert.deepEqual(after.rows, [{ body: "old" }]);
});

test("0099 removes discussions.manage and leaves every other grant alone", async () => {
  const db = await setup();
  await db.exec(migration);
  await db.exec(migration);
  assert.deepEqual(await permissions(db), {
    admin: ["*"],
    community: ["announcements.manage", "support.view"],
    mentor: ["mentor.panel"],
  });
});

test("0099 takes dm_messages out of realtime; tables are kept", async () => {
  const db = await setup();
  const published = `select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'dm_messages'`;
  assert.equal((await db.query(published)).rows.length, 1);
  await db.exec(migration);
  await db.exec(migration);
  assert.equal((await db.query(published)).rows.length, 0);
  for (const table of [...RETIRED, "dm_messages"]) {
    const r = await db.query<{ t: string | null }>(`select to_regclass('public.${table}')::text as t`);
    assert.equal(r.rows[0].t, table);
  }
});

test("0099 applies on a database without the publication or the retired tables", async () => {
  const noPublication = await setup({ publication: false });
  await noPublication.exec(migration);
  await noPublication.exec(migration);

  const bare = await setup({ tables: false });
  await bare.exec(migration);
  await bare.exec(migration);
  assert.deepEqual((await permissions(bare)).community, ["announcements.manage", "support.view"]);
});

// ---------------------------------------------------------------------------
// 4. Open items from the retired staff queues move to Support
// ---------------------------------------------------------------------------

const STUDENT = "33333333-3333-4333-8333-333333333333";
const STAFF = "44444444-4444-4444-8444-444444444444";
const REPORTER = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const CONVERSATION = "77777777-7777-4777-8777-777777777777";
const WAITING = "88888888-8888-4888-8888-888888888888";

type Ticket = {
  id: string;
  reference: string;
  token: string;
  user_id: string | null;
  requester_email: string;
  requester_name: string | null;
  category: string;
  priority: string;
  sensitive: boolean;
  channel: string;
  status: string;
  needs_reply: boolean;
  subject: string;
  body: string;
  context: Record<string, string>;
  received_at: Date;
  last_activity_at: Date;
  requester_activity_at: Date;
  first_response_at: Date | null;
  reply_count: number;
  created_by: string | null;
};

async function seedQueues(db: PGlite) {
  await db.exec(`
    insert into public.profiles (id, email, full_name) values
      ('${STUDENT}', 'Sam@Example.com', 'Sam Student'),
      ('${STAFF}', 'staff@example.com', 'Tess Team'),
      ('${REPORTER}', 'riley@example.com', 'Riley Reporter'),
      ('${OTHER}', 'omar@example.com', '');

    -- The old /admin/discussions queue held exactly the first one.
    insert into public.discussion_threads
      (id, author_id, visibility, title, body, needs_reply, created_at, last_activity_at) values
      ('${WAITING}', '${STUDENT}', 'admin', 'Can I switch teams?',
        'My team stopped meeting. Who do I talk to?', true,
        '2026-10-01T15:00:00Z', '2026-10-03T09:00:00Z'),
      (gen_random_uuid(), '${STUDENT}', 'admin', 'Answered already', 'Thanks for the help!', false,
        '2026-09-20T15:00:00Z', '2026-09-21T15:00:00Z'),
      (gen_random_uuid(), '${STUDENT}', 'cohort', 'A cohort thread', 'Anyone up for a study group?', true,
        '2026-09-25T15:00:00Z', '2026-09-25T15:00:00Z');
    insert into public.discussion_replies (thread_id, author_id, body, is_staff, created_at) values
      ('${WAITING}', '${STAFF}', 'Which team are you on?', true, '2026-10-02T10:00:00Z'),
      ('${WAITING}', '${STUDENT}', 'Team Rocket.', false, '2026-10-03T09:00:00Z');

    -- The old /admin/messages queue held the two open reports.
    insert into public.dm_messages (conversation_id, sender_id, body, created_at, unsent_at) values
      ('${CONVERSATION}', '${OTHER}', 'hey', '2026-10-04T18:00:00Z', null),
      ('${CONVERSATION}', '${OTHER}', 'something unkind', '2026-10-04T18:01:00Z', '2026-10-04T18:05:00Z'),
      ('${CONVERSATION}', '${REPORTER}', 'please stop', '2026-10-04T18:02:00Z', null);
    insert into public.dm_reports (conversation_id, reporter_id, reason, status, created_at) values
      ('${CONVERSATION}', '${REPORTER}', 'Mean messages, then unsent them.', 'open', '2026-10-04T18:10:00Z'),
      ('${CONVERSATION}', null, 'Reported before deleting my account.', 'open', '2026-10-05T12:00:00Z'),
      ('${CONVERSATION}', '${REPORTER}', 'An old report.', 'dismissed', '2026-09-01T12:00:00Z');
  `);
}

async function tickets(db: PGlite) {
  const { rows } = await db.query<Ticket>(
    `select * from public.support_tickets order by received_at`,
  );
  return rows;
}

async function notesFor(db: PGlite, ticketId: string) {
  const { rows } = await db.query<{
    body: string;
    is_staff: boolean;
    is_internal: boolean;
    via: string;
    author_id: string | null;
  }>(`select body, is_staff, is_internal, via, author_id
      from public.support_ticket_replies where ticket_id = $1`, [ticketId]);
  return rows;
}

test("0099 moves what the retired queues still held into Support, once", async () => {
  const db = await setup();
  await seedQueues(db);
  await db.exec(migration);
  await db.exec(migration);

  const all = await tickets(db);
  assert.deepEqual(
    all.map((t) => t.context.carriedFrom.split(":")[0]),
    ["discussion", "dm_report", "dm_report"],
  );
  for (const t of all) {
    assert.match(t.reference, /^B0-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
    assert.match(t.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(t.channel, "other");
    assert.equal(t.status, "open");
    assert.equal(t.needs_reply, true);
    assert.equal(t.created_by, null);
  }
  assert.equal(new Set(all.map((t) => t.token)).size, 3);
});

test("0099 runs twice inside one transaction (pasted twice into the SQL editor)", async () => {
  const db = await setup();
  await seedQueues(db);
  await db.transaction(async (tx) => {
    await tx.exec(migration);
    await tx.exec(migration);
  });
  assert.equal((await tickets(db)).length, 3);
});

test("a waiting private question becomes a program ticket from its author", async () => {
  const db = await setup();
  await seedQueues(db);
  await db.exec(migration);

  const [question] = await tickets(db);
  assert.equal(question.context.carriedFrom, `discussion:${WAITING}`);
  assert.equal(question.context.source, "discussions");
  assert.equal(question.user_id, STUDENT);
  assert.equal(question.requester_email, "sam@example.com");
  assert.equal(question.requester_name, "Sam Student");
  assert.equal(question.category, "program");
  assert.equal(question.priority, "normal");
  assert.equal(question.sensitive, false);
  assert.equal(question.subject, "Can I switch teams?");
  assert.equal(
    question.body,
    [
      "Moved from Discussions. Asked 2026-10-01.",
      "My team stopped meeting. Who do I talk to?",
      "Team (2026-10-02): Which team are you on?",
      "Student (2026-10-03): Team Rocket.",
    ].join("\n\n"),
  );
  // The reply target runs from when the student last wrote.
  assert.equal(question.received_at.toISOString(), "2026-10-01T15:00:00.000Z");
  assert.equal(question.requester_activity_at.toISOString(), "2026-10-03T09:00:00.000Z");
  assert.deepEqual(await notesFor(db, question.id), []);
});

test("an open DM report becomes a sensitive concern with a staff-only transcript", async () => {
  const db = await setup();
  await seedQueues(db);
  await db.exec(migration);

  const [, report, orphan] = await tickets(db);
  assert.equal(report.user_id, REPORTER);
  assert.equal(report.requester_email, "riley@example.com");
  assert.equal(report.category, "concern");
  assert.equal(report.priority, "urgent");
  assert.equal(report.sensitive, true);
  assert.equal(report.subject, "Reported direct message");
  assert.equal(
    report.body,
    "Report about a direct message conversation, filed 2026-10-04.\n\nReason: Mean messages, then unsent them.",
  );
  // What the requester can see never includes the conversation itself.
  assert.ok(!report.body.includes("something unkind"));

  const notes = await notesFor(db, report.id);
  assert.equal(notes.length, 1);
  assert.deepEqual(
    { ...notes[0], body: undefined },
    { body: undefined, is_staff: true, is_internal: true, via: "system", author_id: null },
  );
  assert.equal(
    notes[0].body,
    [
      `Reported conversation ${CONVERSATION}. Staff only.`,
      "",
      "[2026-10-04 18:00 UTC] omar@example.com: hey",
      "[2026-10-04 18:01 UTC] omar@example.com (unsent): something unkind",
      "[2026-10-04 18:02 UTC] Riley Reporter: please stop",
    ].join("\n"),
  );

  // The note moved no clock: no public reply, no first response.
  assert.equal(report.reply_count, 0);
  assert.equal(report.first_response_at, null);
  assert.equal(report.last_activity_at.toISOString(), "2026-10-04T18:10:00.000Z");
  assert.equal(report.requester_activity_at.toISOString(), "2026-10-04T18:10:00.000Z");

  // A reporter whose account is gone: kept, answered from the team inbox.
  assert.equal(orphan.user_id, null);
  assert.equal(orphan.requester_email, "hello@batch0.org");
  assert.equal(orphan.requester_name, "Deleted account");
  assert.equal((await notesFor(db, orphan.id)).length, 1);
});

test("a long conversation keeps its newest messages within the note's limit", async () => {
  const db = await setup();
  await seedQueues(db);
  await db.exec(`
    insert into public.dm_messages (conversation_id, sender_id, body, created_at)
    select '${CONVERSATION}', '${OTHER}', 'message ' || n || ' ' || repeat('x', 390),
      timestamptz '2026-10-04T19:00:00Z' + n * interval '1 minute'
    from generate_series(1, 40) n;
  `);
  await db.exec(migration);

  const [, report] = await tickets(db);
  const [note] = await notesFor(db, report.id);
  assert.ok(note.body.length <= 8000, `note is ${note.body.length} chars`);
  assert.ok(note.body.startsWith(`Reported conversation ${CONVERSATION}. Staff only.\n\n…`));
  assert.ok(note.body.includes("message 40 "));
  assert.ok(!note.body.includes("message 1 "));
});

test("0099 carries nothing over where Support or the queues don't exist", async () => {
  const noSupport = await setup({ support: false });
  await noSupport.exec(migration);
  await noSupport.exec(migration);

  const noQueues = await setup({ tables: false });
  await noQueues.exec(migration);
  assert.deepEqual(await tickets(noQueues), []);
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

test("the overview's 0099 probe finds a stale role before 0099 and none after", async () => {
  const db = await setup();
  const sql = leftoverProbeSql("0099");
  assert.equal((await db.query(sql)).rows.length, 1);
  await db.exec(migration);
  assert.equal((await db.query(sql)).rows.length, 0);
});
