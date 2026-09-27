-- ============================================================================
-- 0089 — Direct messages: one-to-one chat between any two accounts.
--
-- A DM is a `dm_conversations` row holding exactly two profile ids, plus
-- `dm_messages` rows. Anyone with a profile may open a DM with anyone else
-- with a profile — the directory is deliberately the whole site, not one
-- cohort, because the point of the feature is reaching the person you need
-- rather than the person you happen to be enrolled beside.
--
-- Three things keep that open graph safe, and all three live here rather
-- than only in the UI:
--
--   dm_blocks    A block is symmetric in effect: once either side has
--                blocked the other, neither can send. The existing thread
--                stays readable to both (nobody loses their own history),
--                it just goes read-only.
--
--   dm_reports   A DM is private by default: staff have NO read path into
--                one. Reporting a conversation is what opens it — from then
--                on holders of `moderation.manage` can read that one
--                conversation, and only that one. See
--                dm_can_read_conversation() below: the staff branch is
--                gated on a report existing.
--
--   rate limits  Not expressible in SQL; enforced in the server actions
--                (app/messages/actions.ts) on both "start a new
--                conversation" and "send a message".
--
-- Every write goes through those server actions on the service role, after
-- the block check, the rate limit and the notification logic. So signed-in
-- users get READ policies only (the browser needs them for Realtime) and no
-- insert/update/delete path at all: a write policy here would let anyone
-- skip all three through PostgREST — and an update policy on a conversation
-- would let a participant rewrite `user_b` and hand the other person's
-- messages to a third account.
--
-- The pair is stored ordered (user_a < user_b) with a unique index over the
-- pair, so "find or create the DM with this person" is one upsert and two
-- people can't race their way into two parallel conversations.
--
-- Read state is one timestamp per side on the conversation row rather than a
-- participants table: a DM has exactly two sides forever, so a join to learn
-- "have I read this" would buy nothing. Unread, everywhere, means
-- `sender_id <> me and created_at > my cursor` — which is why a person's own
-- message can never count as unread to them whatever their cursor says.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0088 are applied.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Conversations
-- ----------------------------------------------------------------------------
create table if not exists public.dm_conversations (
  id uuid primary key default gen_random_uuid(),
  -- Ordered pair. The check plus the unique index below is what makes a DM
  -- between two people a singleton; lib/dm-access.ts orderPair() is the
  -- client-side half of the same contract.
  --
  -- `set null`, not cascade: deleting one account must not delete the other
  -- person's history — or a reported conversation and every report on it,
  -- which is exactly what deleting a harasser's account used to do. The
  -- deleted side reads as "Deleted account" and the thread goes read-only.
  -- (Both the check and the unique index tolerate a null.)
  user_a uuid references public.profiles(id) on delete set null,
  user_b uuid references public.profiles(id) on delete set null,
  -- Read cursors, one per side. 'epoch' rather than null so every unread
  -- comparison is a plain `>` with no null handling to get wrong.
  a_last_read_at timestamptz not null default 'epoch',
  b_last_read_at timestamptz not null default 'epoch',
  -- Denormalised for the inbox list and the popup, maintained by the trigger
  -- below. Null on a conversation that exists but has no message yet.
  last_message_at timestamptz,
  last_message_preview text,
  last_sender_id uuid references public.profiles(id) on delete set null,
  message_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dm_conversations_ordered check (user_a < user_b)
);

-- Re-running over an earlier draft of this file, where the participants were
-- `not null ... on delete cascade`: bring the columns to the shape above.
alter table public.dm_conversations alter column user_a drop not null;
alter table public.dm_conversations alter column user_b drop not null;
alter table public.dm_conversations drop constraint if exists dm_conversations_user_a_fkey;
alter table public.dm_conversations add constraint dm_conversations_user_a_fkey
  foreign key (user_a) references public.profiles(id) on delete set null;
alter table public.dm_conversations drop constraint if exists dm_conversations_user_b_fkey;
alter table public.dm_conversations add constraint dm_conversations_user_b_fkey
  foreign key (user_b) references public.profiles(id) on delete set null;

create unique index if not exists dm_conversations_pair_idx
  on public.dm_conversations (user_a, user_b);
-- Each side's inbox, most recent first. Two indexes because the viewer can
-- be on either side of the pair and there is no single "my column".
create index if not exists dm_conversations_a_inbox_idx
  on public.dm_conversations (user_a, last_message_at desc nulls last);
create index if not exists dm_conversations_b_inbox_idx
  on public.dm_conversations (user_b, last_message_at desc nulls last);

drop trigger if exists touch_dm_conversations on public.dm_conversations;
create trigger touch_dm_conversations before update on public.dm_conversations
  for each row execute procedure public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- Messages
-- ----------------------------------------------------------------------------
create table if not exists public.dm_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.dm_conversations(id) on delete cascade,
  -- Same reason: a deleted sender's words stay in the other person's thread
  -- (and in a report's transcript), attributed to "Deleted account".
  sender_id uuid references public.profiles(id) on delete set null,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

alter table public.dm_messages alter column sender_id drop not null;
alter table public.dm_messages drop constraint if exists dm_messages_sender_id_fkey;
alter table public.dm_messages add constraint dm_messages_sender_id_fkey
  foreign key (sender_id) references public.profiles(id) on delete set null;

create index if not exists dm_messages_conversation_idx
  on public.dm_messages (conversation_id, created_at);
-- "How many unread in this conversation for this person" — the popup asks
-- this for every row it shows.
create index if not exists dm_messages_sender_idx
  on public.dm_messages (conversation_id, sender_id, created_at);

-- The conversation's summary columns are recomputed from the messages rather
-- than incremented, exactly like discussion_replies_touch_thread() in 0067: a
-- delete then needs no special case, and two messages landing at once can't
-- lose a count to a read-then-write race.
create or replace function public.dm_messages_touch_conversation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  cid uuid := coalesce(new.conversation_id, old.conversation_id);
  last_row public.dm_messages;
begin
  -- Lock the conversation first. Under READ COMMITTED each statement below
  -- then takes a fresh snapshot AFTER any concurrent send has committed, so
  -- two messages landing at once can't both write a count that misses the
  -- other (the UPDATE's subquery would otherwise use a snapshot from before
  -- the lock wait). NO KEY UPDATE, not UPDATE: every message insert already
  -- holds KEY SHARE on this row through its foreign key, and FOR UPDATE
  -- conflicts with that — two concurrent sends would deadlock.
  perform 1 from public.dm_conversations where id = cid for no key update;

  select * into last_row
  from public.dm_messages m
  where m.conversation_id = cid
  order by m.created_at desc, m.id desc
  limit 1;

  update public.dm_conversations c
  set message_count = (
        select count(*) from public.dm_messages m where m.conversation_id = cid
      ),
      last_message_at = last_row.created_at,
      last_message_preview = left(last_row.body, 140),
      last_sender_id = last_row.sender_id
  where c.id = cid;
  return null;
end;
$$;

drop trigger if exists dm_messages_touch_conversation on public.dm_messages;
create trigger dm_messages_touch_conversation
  after insert or delete on public.dm_messages
  for each row execute procedure public.dm_messages_touch_conversation();

-- ----------------------------------------------------------------------------
-- Blocks
-- ----------------------------------------------------------------------------
create table if not exists public.dm_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint dm_blocks_not_self check (blocker_id <> blocked_id)
);

-- Enforcement direction: "may X send to Y" asks whether Y blocked X, which
-- reads the blocked_id side.
create index if not exists dm_blocks_blocked_idx
  on public.dm_blocks (blocked_id);

-- ----------------------------------------------------------------------------
-- Reports — the ONLY thing that opens a DM to staff.
-- ----------------------------------------------------------------------------
create table if not exists public.dm_reports (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.dm_conversations(id) on delete cascade,
  -- Nullable + `set null`: a deleted account must not take the moderation
  -- record with it.
  reporter_id uuid references public.profiles(id) on delete set null,
  reason text not null check (char_length(reason) between 1 and 2000),
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists dm_reports_queue_idx
  on public.dm_reports (status, created_at desc);
create index if not exists dm_reports_conversation_idx
  on public.dm_reports (conversation_id);

alter table public.dm_conversations enable row level security;
alter table public.dm_messages enable row level security;
alter table public.dm_blocks enable row level security;
alter table public.dm_reports enable row level security;

-- ----------------------------------------------------------------------------
-- Predicates. One definition each, used by every policy below, so the rule
-- for a message can never drift from the rule for its conversation.
-- ----------------------------------------------------------------------------

-- Symmetric: true if EITHER of the two has blocked the other. Sending is
-- blocked in both directions, because a one-way block that still let the
-- blocker keep talking would be a weapon rather than a shield.
create or replace function public.dm_is_blocked(x uuid, y uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.dm_blocks b
    where (b.blocker_id = x and b.blocked_id = y)
       or (b.blocker_id = y and b.blocked_id = x)
  );
$$;

-- Who may read a conversation: its two participants, always — plus
-- moderators, but ONLY once it has been reported. With no report there is no
-- staff read path at all, which is the promise the UI makes to users.
--
-- The reader is always auth.uid(), never an argument. Functions in `public`
-- are callable over /rpc, and a version that took the uid let anyone pass a
-- moderator's id with a conversation id and learn whether that conversation
-- had been reported. (An earlier draft of this file had that two-argument
-- form; it is dropped below, after the policies stop using it.)
create or replace function public.dm_can_read_conversation(c public.dm_conversations)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select
    c.user_a = auth.uid()
    or c.user_b = auth.uid()
    or (
      (public.is_admin(auth.uid()) or public.has_permission(auth.uid(), 'moderation.manage'))
      and exists (
        select 1 from public.dm_reports r where r.conversation_id = c.id
      )
    );
$$;

-- Participation alone, without the moderator branch: a moderator reading a
-- reported thread does not get to post in it. Enforced for writes in the
-- server actions (lib/dm-access.ts); kept here for server-side SQL.
create or replace function public.dm_is_participant(c public.dm_conversations, uid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select c.user_a = uid or c.user_b = uid;
$$;

-- ----------------------------------------------------------------------------
-- Policies: READ ONLY for signed-in users.
--
-- The browser's only direct use of these tables is the Realtime subscription
-- to dm_messages (filtered to the open conversation), and Realtime applies
-- the SELECT policy to what it delivers. Everything else — creating a
-- conversation, sending, marking read, unsending, blocking, reporting,
-- moderating — is a server action on the service role, which bypasses RLS.
--
-- The write policies are dropped by name, not merely left out, so re-running
-- this file over an earlier draft of it (which had them) removes them.
-- ----------------------------------------------------------------------------
drop policy if exists "dm_conversations read" on public.dm_conversations;
create policy "dm_conversations read" on public.dm_conversations
  for select using (public.dm_can_read_conversation(dm_conversations));
drop policy if exists "dm_conversations insert" on public.dm_conversations;
drop policy if exists "dm_conversations update" on public.dm_conversations;

drop policy if exists "dm_messages read" on public.dm_messages;
create policy "dm_messages read" on public.dm_messages
  for select using (
    exists (
      select 1 from public.dm_conversations c
      where c.id = dm_messages.conversation_id
        and public.dm_can_read_conversation(c)
    )
  );
drop policy if exists "dm_messages insert" on public.dm_messages;
drop policy if exists "dm_messages delete" on public.dm_messages;

-- Your block list is yours. There is no policy letting anyone read blocks
-- where they are the blocked party: being blocked is not something you get
-- told, it just looks like silence.
drop policy if exists "dm_blocks own" on public.dm_blocks;
create policy "dm_blocks own" on public.dm_blocks
  for select using (blocker_id = auth.uid());
drop policy if exists "dm_blocks insert" on public.dm_blocks;
drop policy if exists "dm_blocks delete" on public.dm_blocks;

drop policy if exists "dm_reports read" on public.dm_reports;
create policy "dm_reports read" on public.dm_reports
  for select using (
    reporter_id = auth.uid()
    or public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'moderation.manage')
  );
drop policy if exists "dm_reports insert" on public.dm_reports;
drop policy if exists "dm_reports update" on public.dm_reports;

-- Functions in `public` are callable by anyone over PostgREST's /rpc. These
-- two are server-side helpers and must not be: `dm_is_blocked(me, them)`
-- would tell a user whether someone had blocked them, which the block
-- design promises never to reveal. (dm_can_read_conversation stays callable
-- — the read policies above run it as the signed-in user, and it only ever
-- answers for that user.)
drop function if exists public.dm_can_read_conversation(public.dm_conversations, uuid);
revoke execute on function public.dm_is_blocked(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.dm_is_participant(public.dm_conversations, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Notifications never carry a DM's words.
--
-- The bell for a new DM is a `notifications` row, and that table's read
-- policy (0016) lets every admin read every user's notifications. A message
-- preview in `body` would therefore be a staff read path into unreported
-- DMs — the one thing this feature promises not to have. The app sends no
-- body; this makes it a guarantee rather than a convention, whatever code is
-- deployed.
-- ----------------------------------------------------------------------------
create or replace function public.dm_notification_strip_body()
returns trigger
language plpgsql
as $$
begin
  if new.type = 'direct_message' then
    new.body := null;
  end if;
  return new;
end;
$$;

drop trigger if exists dm_notification_strip_body on public.notifications;
create trigger dm_notification_strip_body
  before insert or update on public.notifications
  for each row execute procedure public.dm_notification_strip_body();

-- ----------------------------------------------------------------------------
-- Realtime.
--
-- Only dm_messages, and the client only ever subscribes to it WITH a
-- `conversation_id=eq.<id>` filter, for the one thread it has open. That
-- restraint is deliberate: an unfiltered postgres_changes subscription would
-- be relying on Realtime to re-apply the read policy above to every row it
-- fans out, and a DM body is the last payload in this codebase worth betting
-- on that. Filtered to a conversation the viewer already had to be cleared
-- for, the subscription can't carry anything they couldn't already read.
--
-- The global unread badge therefore does NOT ride on this table. It rides on
-- `notifications`, which is already per-user (0016) — and the numbers line up
-- exactly, because the count the badge shows is unread *conversations*, which
-- can only rise at the moment a caught-up recipient is bell-ed
-- (app/messages/actions.ts sends exactly one bell per burst, on that
-- transition).
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'dm_messages'
  ) then
    alter publication supabase_realtime add table public.dm_messages;
  end if;
end$$;

comment on table public.dm_conversations is
  'One-to-one DM between two profiles, stored as an ordered pair (user_a < user_b) so the pair is unique. Read state is one cursor per side.';
comment on table public.dm_messages is
  'Messages in a DM. Readability is inherited from the conversation via dm_can_read_conversation().';
comment on table public.dm_blocks is
  'One-way rows, symmetric effect: if either side has blocked the other, neither can send. Existing history stays readable to both.';
comment on table public.dm_reports is
  'A reported DM. Creating one is the only thing that grants moderation.manage holders read access to that conversation.';

notify pgrst, 'reload schema';
