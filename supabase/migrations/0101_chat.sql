-- ============================================================================
-- 0101 — batch0 Chat: channels, direct messages and group DMs, in the app.
--         Discord is gone.
--
-- Chat replaces the Discord server as batch0's community. Everything is one
-- model: a `chat_channels` row is a text channel (#general, a cohort, a team),
-- a one-to-one DM, or a group DM, and `chat_messages` hang off it. No voice,
-- no categories.
--
-- Who reads a channel (chat_can_read below, mirrored by canReadChannel() in
-- lib/chat-access.ts — keep them in lockstep, lib/chat-migration-db.test.ts
-- runs both over the same matrix):
--
--   audience   kind      readers
--   everyone   channel   anyone who has been let in: a non-student role, or a
--                        student with an enrollment or an accepted application
--   cohort     channel   people enrolled in that cohort, and every mentor
--                        assigned (mentor_assignments) to one of them
--   team       channel   that team's members, and every mentor assigned to
--                        one of them
--   staff      channel   staff only
--   members    channel   explicit members only (a private channel)
--   members    dm/group  its members
--
-- plus, for every channel: staff (`chat.manage` or the '*' wildcard) and
-- anyone with an explicit chat_members row. DMs and group DMs have NO staff
-- read path until one of their members reports them — the promise the old
-- direct messages (0089) made, kept here — and then only for a moderator no
-- report on it names (chat_reports.party_ids). A fresh, unvetted signup sees
-- no community channel at all; they can still message the team.
--
-- Writes: none from the browser. Every insert, edit, delete, reaction, block,
-- report, mute and read-cursor move is a server action on the service role
-- (app/chat/actions.ts), after the access check, the block check, slow mode,
-- the rate limits and the notification logic. Signed-in users get READ
-- policies only — the browser needs them for Realtime.
--
-- Deleting a message blanks it in place (body '', attachments '[]',
-- deleted_at set) so the Realtime UPDATE reaches every open screen at once.
-- What it said is kept in chat_message_revisions, readable by nobody but the
-- service role: the moderation queue shows it when the message is reported,
-- so deleting or editing first is no way to hide what was sent. The same goes
-- for whole channels: one with a report can't be deleted (archive it), and
-- deleting a team or cohort archives its channel as a staff channel, history
-- and reports intact, instead of taking it along.
--
-- Also in this file (sections 9–12): the Discord integration's tables,
-- columns, settings and permission are dropped (`discord.manage` is removed,
-- NOT turned into `chat.manage` — grant that on purpose), the old DM and
-- team-thread history is carried into Chat, and lesson, email and kickoff copy
-- that sent students to Discord now sends them to Chat.
-- DROPS ARE NOT REVERSIBLE: take a backup first if you may want the Discord
-- ids, the auto-answer ledger, the office-hours queue or the blocker flags.
--
-- Run in Supabase SQL Editor after the deploy. Idempotent / safe to re-run,
-- also once Chat is in use. Assumes 0001..0100 are applied (0048 app_roles;
-- 0089 and 0099 are optional). If 0099 ever runs AFTER this file, run this
-- file again: 0099 rewrites lesson copy back to Discord.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Channels
-- ----------------------------------------------------------------------------
create table if not exists public.chat_channels (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'channel' check (kind in ('channel', 'dm', 'group')),
  -- Channels: a Discord-style slug (general, fall-2026, team-acme). Groups:
  -- an optional display name. DMs: null — they're named after the other person.
  name text check (name is null or char_length(name) between 1 and 80),
  topic text check (topic is null or char_length(topic) <= 300),
  audience text not null default 'everyone'
    check (audience in ('everyone', 'cohort', 'team', 'staff', 'members')),
  -- `set null`, never cascade: a team or cohort going takes no history with
  -- it. chat_keep_scoped_channels() (section 9) archives the channel as a
  -- staff channel first, so the shape check below still holds.
  cohort_id uuid references public.cohorts(id) on delete set null,
  team_id uuid references public.teams(id) on delete set null,
  -- 'staff' makes a read-only channel for everyone else (#announcements).
  posting text not null default 'everyone' check (posting in ('everyone', 'staff')),
  -- Seconds between two messages from the same person. Staff are exempt.
  slowmode_seconds int not null default 0 check (slowmode_seconds between 0 and 21600),
  position int not null default 0,
  -- Channels the app owns ('general', 'cohort:<id>', 'team:<id>'), so a
  -- re-run, a trigger and the app can find them without matching on names.
  system_key text unique,
  -- A one-to-one DM: '<lower uuid>:<higher uuid>'. Unique, so "the DM with
  -- this person" is one row however both people race to open it.
  dm_key text unique,
  created_by uuid references public.profiles(id) on delete set null,
  archived_at timestamptz,
  -- Maintained by chat_messages_touch_channel() below.
  last_message_at timestamptz,
  last_message_preview text,
  last_sender_id uuid references public.profiles(id) on delete set null,
  message_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_channels_shape check (
    (kind = 'channel'
      and name ~ '^[a-z0-9][a-z0-9-]{0,79}$'
      and dm_key is null
      and (audience <> 'cohort' or cohort_id is not null)
      and (audience <> 'team' or team_id is not null))
    or (kind = 'dm' and audience = 'members' and dm_key is not null and name is null)
    or (kind = 'group' and audience = 'members' and dm_key is null)
  )
);

create index if not exists chat_channels_cohort_idx on public.chat_channels (cohort_id) where cohort_id is not null;
create index if not exists chat_channels_team_idx on public.chat_channels (team_id) where team_id is not null;
create index if not exists chat_channels_kind_idx on public.chat_channels (kind, position);

drop trigger if exists touch_chat_channels on public.chat_channels;
create trigger touch_chat_channels before update on public.chat_channels
  for each row execute procedure public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 2. Members: the explicit grants. A DM's two people, a group's people, a
--    private channel's people — and anyone added to a cohort, team or staff
--    channel on top of its audience (a guest mentor in a cohort channel).
--    Read cursors live in chat_reads, NOT here: a cursor must never become a
--    grant, or a student removed from a team would keep its channel.
-- ----------------------------------------------------------------------------
create table if not exists public.chat_members (
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  added_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);
create index if not exists chat_members_user_idx on public.chat_members (user_id);

-- ----------------------------------------------------------------------------
-- 3. Read state, one row per person per channel they've opened.
-- ----------------------------------------------------------------------------
create table if not exists public.chat_reads (
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- A MESSAGE timestamp: everything at or before it has been read.
  last_read_at timestamptz not null default 'epoch',
  -- When they last had it open, by the clock. "Are they looking at it right
  -- now" decides whether a new message rings their bell.
  seen_at timestamptz,
  -- null = the default: every message bells in a DM or group, only mentions
  -- in a channel.
  notify text check (notify in ('all', 'mentions', 'none')),
  -- A DM or group closed from the sidebar. It comes back by itself when a
  -- message newer than this arrives.
  hidden_at timestamptz,
  primary key (channel_id, user_id)
);
create index if not exists chat_reads_user_idx on public.chat_reads (user_id);

-- ----------------------------------------------------------------------------
-- 4. Messages
-- ----------------------------------------------------------------------------
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  -- `set null`: a deleted account's words stay in everyone else's history
  -- (and in a report), attributed to "Deleted account".
  sender_id uuid references public.profiles(id) on delete set null,
  -- Mentions are stored inline as <@uuid> and resolved to names on screen.
  body text not null default '' check (char_length(body) <= 4000),
  reply_to_id uuid references public.chat_messages(id) on delete set null,
  -- Extracted server-side from the body, and only ever people who can read
  -- the channel: what the unread badge counts.
  mentions uuid[] not null default '{}',
  mention_everyone boolean not null default false,
  -- [{ "path", "name", "size", "type" }] in the private chat-files bucket.
  attachments jsonb not null default '[]'::jsonb,
  -- { "👍": ["<uuid>", ...] }, maintained from chat_reactions by a trigger
  -- so a reaction reaches every open screen as an UPDATE of the message.
  reactions jsonb not null default '{}'::jsonb,
  -- 'system': "Maya added Dev to the group", "Sam pinned a message".
  kind text not null default 'message' check (kind in ('message', 'system')),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null,
  pinned_at timestamptz,
  pinned_by uuid references public.profiles(id) on delete set null,
  constraint chat_messages_content check (
    deleted_at is not null
    or char_length(body) >= 1
    or jsonb_array_length(attachments) > 0
  ),
  constraint chat_messages_deleted_blank check (
    deleted_at is null or (body = '' and attachments = '[]'::jsonb)
  )
);

create index if not exists chat_messages_channel_idx
  on public.chat_messages (channel_id, created_at desc);
create index if not exists chat_messages_sender_idx
  on public.chat_messages (sender_id, channel_id, created_at desc);
create index if not exists chat_messages_pinned_idx
  on public.chat_messages (channel_id, pinned_at desc) where pinned_at is not null;
-- The messages that mention someone, the only ones chat_unread() has to look
-- at for its mention count. Its WHERE repeats this predicate to use it.
create index if not exists chat_messages_mentions_idx
  on public.chat_messages (channel_id, created_at desc)
  where deleted_at is null and kind = 'message' and (mention_everyone or mentions <> '{}');
-- Foreign keys back into this table and to profiles. Without them, deleting
-- a channel scans every message once per message it deletes (reply_to_id is
-- `on delete set null`), and deleting an account once per column. Nearly
-- every row is null in each, so the partial indexes stay small.
create index if not exists chat_messages_reply_idx
  on public.chat_messages (reply_to_id) where reply_to_id is not null;
create index if not exists chat_messages_deleted_by_idx
  on public.chat_messages (deleted_by) where deleted_by is not null;
create index if not exists chat_messages_pinned_by_idx
  on public.chat_messages (pinned_by) where pinned_by is not null;

-- Search (searchMessages in lib/chat.ts) is a substring match: a trigram
-- index answers it without reading every message. pg_trgm comes from 0032;
-- where it isn't there, search still works, just unindexed.
do $$
begin
  if exists (select 1 from pg_opclass where opcname = 'gin_trgm_ops' and pg_opclass_is_visible(oid)) then
    create index if not exists chat_messages_body_trgm
      on public.chat_messages using gin (body gin_trgm_ops)
      where deleted_at is null and kind = 'message';
  end if;
end $$;

-- What a message said before it was edited or deleted. Service role only:
-- RLS on, no policy at all.
create table if not exists public.chat_message_revisions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  body text not null,
  attachments jsonb not null default '[]'::jsonb,
  reason text not null check (reason in ('edit', 'delete')),
  created_at timestamptz not null default now()
);
create index if not exists chat_message_revisions_message_idx
  on public.chat_message_revisions (message_id, created_at);

create or replace function public.chat_messages_keep_revision()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if old.body is distinct from new.body or old.attachments is distinct from new.attachments then
    if char_length(old.body) > 0 or jsonb_array_length(old.attachments) > 0 then
      insert into public.chat_message_revisions (message_id, body, attachments, reason)
      values (old.id, old.body, old.attachments,
              case when new.deleted_at is not null and old.deleted_at is null then 'delete' else 'edit' end);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists chat_messages_keep_revision on public.chat_messages;
create trigger chat_messages_keep_revision
  before update of body, attachments on public.chat_messages
  for each row execute procedure public.chat_messages_keep_revision();

-- What counts as a message for the channel's summary, unread counts and read
-- cursors: a person's message, never a system line ("Maya pinned a message."
-- echoes something someone did) — except in #staff, where the system lines
-- ARE the news: the feed of applications, acceptances and refunds
-- (postStaffFeed, lib/chat-post.ts). Counting them there everywhere at once
-- (summary, unread, the cursor markRead clamps to) is what lets the feed show
-- as new and then be read.
create or replace function public.chat_counts_as_message(kind text, system_key text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select kind = 'message' or (kind = 'system' and system_key is not distinct from 'staff');
$$;

-- The channel's summary columns, kept up to date message by message under
-- the channel's row lock. Counting the channel again on every send held that
-- lock for as long as the count took, so a busy channel's sends queued up
-- behind each other. Now a send adds one and becomes the summary, and only a
-- change to the newest live message looks the summary up again — the newest
-- row of an index range, not a scan.
create or replace function public.chat_messages_touch_channel()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  cid uuid := coalesce(new.channel_id, old.channel_id);
  key text;
  was_live boolean;
  is_live boolean;
  delta int;
  last_at timestamptz;
  last_row record;
begin
  -- Only a row that isn't deleted on one side or the other can be live.
  if not ((tg_op <> 'INSERT' and old.deleted_at is null) or (tg_op <> 'DELETE' and new.deleted_at is null)) then
    return null;
  end if;
  -- An ordinary system line can't be live anywhere but #staff: skip the lock.
  if (tg_op = 'INSERT' or old.kind = 'system') and (tg_op = 'DELETE' or new.kind = 'system')
     and not exists (select 1 from public.chat_channels c where c.id = cid and c.system_key = 'staff') then
    return null;
  end if;

  -- NO KEY UPDATE, not UPDATE: every message insert already holds KEY SHARE
  -- on the channel through its foreign key, and FOR UPDATE conflicts with
  -- that — two concurrent sends would deadlock (0089's note). Held until
  -- commit, so the read-then-write below can't lose a concurrent change.
  select c.last_message_at, c.system_key into last_at, key from public.chat_channels c where c.id = cid for no key update;
  if not found then return null; end if; -- the channel itself is being deleted

  -- Live = counted (chat_counts_as_message) and not deleted.
  was_live := tg_op <> 'INSERT' and old.deleted_at is null and public.chat_counts_as_message(old.kind, key);
  is_live := tg_op <> 'DELETE' and new.deleted_at is null and public.chat_counts_as_message(new.kind, key);
  delta := (case when is_live then 1 else 0 end) - (case when was_live then 1 else 0 end);
  if not was_live and not is_live then return null; end if;

  if is_live and not was_live and (last_at is null or new.created_at > last_at) then
    -- A new newest message (every ordinary send): it is the summary.
    update public.chat_channels c
    set message_count = c.message_count + delta,
        last_message_at = new.created_at,
        last_message_preview = case when char_length(new.body) > 0 then left(new.body, 140) else '[attachment]' end,
        last_sender_id = new.sender_id
    where c.id = cid;
  elsif (was_live and old.created_at >= last_at) or (is_live and new.created_at >= last_at) then
    -- The newest message was edited or deleted, or one tied with it changed:
    -- look the newest live one up again.
    select m.created_at, m.body, m.sender_id into last_row
    from public.chat_messages m
    where m.channel_id = cid and m.deleted_at is null and public.chat_counts_as_message(m.kind, key)
    order by m.created_at desc, m.id desc
    limit 1;
    update public.chat_channels c
    set message_count = greatest(c.message_count + delta, 0),
        last_message_at = last_row.created_at,
        last_message_preview = case
          when last_row.created_at is null then null
          when char_length(last_row.body) > 0 then left(last_row.body, 140)
          else '[attachment]'
        end,
        last_sender_id = last_row.sender_id
    where c.id = cid;
  elsif delta <> 0 then
    -- An older message came or went (a delete, or history carried in).
    update public.chat_channels c set message_count = greatest(c.message_count + delta, 0) where c.id = cid;
  end if;
  return null;
end;
$$;

drop trigger if exists chat_messages_touch_channel on public.chat_messages;
create trigger chat_messages_touch_channel
  after insert or delete or update of deleted_at, body on public.chat_messages
  for each row execute procedure public.chat_messages_touch_channel();

-- ----------------------------------------------------------------------------
-- 5. Reactions — one row per (message, person, emoji), folded onto the
--    message by a trigger.
-- ----------------------------------------------------------------------------
create table if not exists public.chat_reactions (
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 32),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create or replace function public.chat_reactions_fold()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  mid uuid := coalesce(new.message_id, old.message_id);
begin
  perform 1 from public.chat_messages where id = mid for no key update;
  if not found then return null; end if;
  update public.chat_messages m
  set reactions = coalesce((
    select jsonb_object_agg(g.emoji, g.users order by g.first_at)
    from (
      select r.emoji,
             jsonb_agg(r.user_id order by r.created_at, r.user_id) as users,
             min(r.created_at) as first_at
      from public.chat_reactions r
      where r.message_id = mid
      group by r.emoji
    ) g
  ), '{}'::jsonb)
  where m.id = mid;
  return null;
end;
$$;

drop trigger if exists chat_reactions_fold on public.chat_reactions;
create trigger chat_reactions_fold
  after insert or delete on public.chat_reactions
  for each row execute procedure public.chat_reactions_fold();

-- ----------------------------------------------------------------------------
-- 6. Blocks and reports
-- ----------------------------------------------------------------------------
-- One-way rows, symmetric effect in DMs: once either side has blocked the
-- other, neither can send there, and neither can open a new DM or group with
-- the other. In channels a block hides the blocked person's messages from the
-- blocker. Being blocked is never announced.
create table if not exists public.chat_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint chat_blocks_not_self check (blocker_id <> blocked_id)
);
create index if not exists chat_blocks_blocked_idx on public.chat_blocks (blocked_id);

create table if not exists public.chat_reports (
  id uuid primary key default gen_random_uuid(),
  -- `restrict`: a report outlives anything that would take its channel —
  -- and the messages and revisions it's evidence of — with it. A reported
  -- channel is archived, not deleted (deleteChannel says so).
  channel_id uuid not null references public.chat_channels(id) on delete restrict,
  -- Null for a report about a whole DM or group.
  message_id uuid references public.chat_messages(id) on delete set null,
  reporter_id uuid references public.profiles(id) on delete set null,
  reason text not null check (char_length(reason) between 1 and 2000),
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  -- Who the report is about, frozen when it's filed (reportPartyIds() in
  -- lib/chat-access.ts, and chat_reports_freeze_parties() below): the
  -- reported message's sender; for a DM or group also everyone in it,
  -- everyone who ever posted in it, and every party to an earlier report on
  -- it. No moderator a DM's or group's reports name may read any of them, or
  -- the conversation through them — they'd learn who reported them, and why.
  -- A text-channel report stands alone (reportScope() says why: judging them
  -- together would let a throwaway report bury another). Not a foreign key:
  -- someone who deletes their account still mustn't come back as a reader.
  party_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.chat_reports add column if not exists party_ids uuid[] not null default '{}';
create index if not exists chat_reports_queue_idx on public.chat_reports (status, created_at desc);
create index if not exists chat_reports_channel_idx on public.chat_reports (channel_id);
create index if not exists chat_reports_message_idx on public.chat_reports (message_id) where message_id is not null;

-- The freeze, made a guarantee: whatever the caller passed, a new report
-- names at least everyone reportPartyIds() would. Only ever adds people, so
-- a caller that already did the work loses nothing.
create or replace function public.chat_reports_freeze_parties()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  conversation boolean;
begin
  select c.kind in ('dm', 'group') into conversation from public.chat_channels c where c.id = new.channel_id;
  new.party_ids := array(
    select distinct p from (
      select unnest(coalesce(new.party_ids, '{}'::uuid[])) as p
      union all
      select m.sender_id from public.chat_messages m where m.id = new.message_id
      union all
      select unnest(r.party_ids) from public.chat_reports r where conversation and r.channel_id = new.channel_id
      union all
      select cm.user_id from public.chat_members cm where conversation and cm.channel_id = new.channel_id
      union all
      select m.sender_id from public.chat_messages m where conversation and m.channel_id = new.channel_id
    ) s
    where p is not null
    order by p
  );
  return new;
end;
$$;

drop trigger if exists chat_reports_freeze_parties on public.chat_reports;
create trigger chat_reports_freeze_parties
  before insert on public.chat_reports
  for each row execute procedure public.chat_reports_freeze_parties();

-- Mutes: someone staff have stopped from posting, reacting, pinning and
-- starting conversations, until `until` (null: until a moderator lifts it).
-- app/chat/manage-actions.ts sets and lifts them; the posting checks in
-- app/chat/actions.ts read them. Service role only: RLS on, no policy.
create table if not exists public.chat_mutes (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  until timestamptz,
  reason text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- A re-run converges on the foreign keys above: an earlier draft of this file
-- created these three with `on delete cascade`.
do $$
declare
  fk record;
begin
  for fk in
    select * from (values
      ('chat_channels', 'chat_channels_cohort_id_fkey', 'cohort_id', 'public.cohorts(id)', 'n', 'set null'),
      ('chat_channels', 'chat_channels_team_id_fkey', 'team_id', 'public.teams(id)', 'n', 'set null'),
      ('chat_reports', 'chat_reports_channel_id_fkey', 'channel_id', 'public.chat_channels(id)', 'r', 'restrict')
    ) as v(tbl, name, col, target, action, clause)
  loop
    if exists (
      select 1 from pg_constraint k
      where k.conrelid = format('public.%I', fk.tbl)::regclass
        and k.conname = fk.name and k.confdeltype::text <> fk.action
    ) then
      execute format('alter table public.%I drop constraint %I, add constraint %I foreign key (%I) references %s on delete %s',
                     fk.tbl, fk.name, fk.name, fk.col, fk.target, fk.clause);
    end if;
  end loop;
end $$;

alter table public.chat_channels enable row level security;
alter table public.chat_members enable row level security;
alter table public.chat_reads enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_message_revisions enable row level security;
alter table public.chat_reactions enable row level security;
alter table public.chat_blocks enable row level security;
alter table public.chat_reports enable row level security;
alter table public.chat_mutes enable row level security;

-- ----------------------------------------------------------------------------
-- 7. Predicates. One definition each, used by every policy.
--
-- PL/pgSQL on purpose, not SQL: Realtime checks the read policy once per
-- subscriber for every change it sends, each check a fresh statement, and a
-- SECURITY DEFINER SQL function is planned again on every call. PL/pgSQL
-- keeps each query's plan for the session: a check went from about 1 ms to
-- about 0.03 ms (Postgres 16, 500 subscribers on one #general message).
-- ----------------------------------------------------------------------------

-- Staff: runs chat. Reads every channel (never an unreported DM), posts in
-- read-only channels, pins, removes messages, works the report queue.
-- has_permission(uid, 'chat.manage') from 0048, written out so its plan is
-- kept too: the role's permissions hold 'chat.manage' or the '*' wildcard.
create or replace function public.chat_is_staff(uid uuid)
returns boolean
language plpgsql
stable
security definer set search_path = public
as $$
begin
  return uid is not null and exists (
    select 1 from public.profiles p
    join public.app_roles r on r.slug = p.role
    where p.id = uid and r.permissions && array['*', 'chat.manage']::text[]
  );
end;
$$;

-- Let in: a non-student role, or a student with an enrollment or an accepted
-- application. Mirrors vettedIds() in lib/chat.ts.
create or replace function public.chat_is_vetted(uid uuid)
returns boolean
language plpgsql
stable
security definer set search_path = public
as $$
begin
  return uid is not null and (
    exists (select 1 from public.profiles p where p.id = uid and coalesce(p.role, 'student') <> 'student')
    or exists (select 1 from public.enrollments e where e.user_id = uid)
    or exists (
      select 1 from public.applications a
      where a.user_id = uid and a.status in ('accepted', 'paid', 'enrolled')
    )
  );
end;
$$;

-- canReadChannel() in lib/chat-access.ts, with `reported` being
-- channelReportsOpenTo() over the channel's reports.
create or replace function public.chat_can_read(c public.chat_channels, uid uuid)
returns boolean
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if uid is null or c.id is null then
    return false;
  end if;
  if exists (select 1 from public.chat_members m where m.channel_id = c.id and m.user_id = uid) then
    return true;
  end if;

  if c.kind = 'channel' then
    -- The audience first (most readers are in it), then staff. The 'staff'
    -- and 'members' audiences add nobody beyond staff and explicit members.
    if c.audience = 'everyone' then
      if public.chat_is_vetted(uid) then
        return true;
      end if;
    elsif c.audience = 'cohort' then
      if exists (select 1 from public.enrollments e where e.user_id = uid and e.cohort_id = c.cohort_id)
         -- A mentor assigned to anyone enrolled in it, like the team rule
         -- below. mentoredScopes() in lib/chat.ts.
         or exists (
           select 1 from public.mentor_assignments ma
           join public.enrollments e on e.user_id = ma.student_id
           where ma.mentor_id = uid and e.cohort_id = c.cohort_id) then
        return true;
      end if;
    elsif c.audience = 'team' then
      if exists (select 1 from public.team_members tm where tm.user_id = uid and tm.team_id = c.team_id)
         -- A mentor assigned to anyone on the team, as the Discord
         -- team-channel sync used to grant. mentoredScopes() in lib/chat.ts.
         or exists (
           select 1 from public.mentor_assignments ma
           join public.team_members tm on tm.user_id = ma.student_id
           where ma.mentor_id = uid and tm.team_id = c.team_id) then
        return true;
      end if;
    end if;
    return public.chat_is_staff(uid);
  end if;

  -- A DM or group opens to staff only once it's reported, and never to a
  -- moderator ANY report on it names: someone reported and then gone from
  -- the group must not come back in through the next report, which can no
  -- longer see them as a member.
  return public.chat_is_staff(uid)
    and exists (select 1 from public.chat_reports r where r.channel_id = c.id)
    and not exists (select 1 from public.chat_reports r where r.channel_id = c.id and uid = any(r.party_ids));
end;
$$;

-- What the read policies call: always as the signed-in user, never for an id
-- passed in, so /rpc can't be used to ask what someone else can read.
create or replace function public.chat_viewer_can_read(c public.chat_channels)
returns boolean
language plpgsql
stable
security definer set search_path = public
as $$
begin
  return public.chat_can_read(c, auth.uid());
end;
$$;

create or replace function public.chat_viewer_can_read_channel(cid uuid)
returns boolean
language plpgsql
stable
security definer set search_path = public
as $$
declare
  c public.chat_channels;
begin
  select * into c from public.chat_channels where id = cid;
  return found and public.chat_can_read(c, auth.uid());
end;
$$;

-- Unread and mention counts for the sidebar, in one query. Service role only
-- (it takes a uid). A text channel the person has never opened counts from
-- two weeks back (UNREAD_LOOKBACK_MS in lib/chat-access.ts), so joining a
-- cohort doesn't open on "99+". Both stay cheap however far behind a read
-- cursor is: unread stops at 100 (the sidebar shows 99+), and mentions go
-- through chat_messages_mentions_idx, and back 30 days at most. A sender the
-- person blocked counts for neither: a block is silence. System lines count
-- only where chat_counts_as_message says so (#staff's feed).
create or replace function public.chat_unread(p_uid uuid, p_channel_ids uuid[])
returns table (channel_id uuid, unread int, mentions int)
language sql
stable
security definer set search_path = public
as $$
  select c.id,
    (select count(*)::int from (
       select 1 from public.chat_messages m
       where m.channel_id = c.id
         and m.deleted_at is null
         and public.chat_counts_as_message(m.kind, c.system_key)
         and m.created_at > w.since
         and m.sender_id is distinct from p_uid
         and not exists (
           select 1 from public.chat_blocks b where b.blocker_id = p_uid and b.blocked_id = m.sender_id)
       limit 100) x),
    (select count(*)::int from (
       select 1 from public.chat_messages m
       where m.channel_id = c.id
         and m.deleted_at is null and m.kind = 'message' and (m.mention_everyone or m.mentions <> '{}')
         and (m.mention_everyone or p_uid = any(m.mentions))
         and m.created_at > greatest(w.since, now() - interval '30 days')
         and m.sender_id is distinct from p_uid
         and not exists (
           select 1 from public.chat_blocks b where b.blocker_id = p_uid and b.blocked_id = m.sender_id)
       limit 100) y)
  from public.chat_channels c
  left join public.chat_reads r on r.channel_id = c.id and r.user_id = p_uid
  cross join lateral (
    select coalesce(r.last_read_at,
             case when c.kind = 'channel' then now() - interval '14 days' else 'epoch'::timestamptz end) as since
  ) w
  where c.id = any(p_channel_ids);
$$;

revoke execute on function public.chat_is_staff(uuid) from public, anon, authenticated;
revoke execute on function public.chat_is_vetted(uuid) from public, anon, authenticated;
revoke execute on function public.chat_can_read(public.chat_channels, uuid) from public, anon, authenticated;
revoke execute on function public.chat_unread(uuid, uuid[]) from public, anon, authenticated;
-- lib/chat.ts calls this one over /rpc as the service role. Granted outright,
-- not left to Supabase's default privileges (the 0080/0090 pattern).
grant execute on function public.chat_unread(uuid, uuid[]) to service_role;

-- Which of these chat-files paths a message, or a kept revision of one, still
-- points at. The daily sweep of unsent uploads (lib/chat-housekeeping.ts,
-- app/api/cron/chat-housekeeping) deletes a file only when it is a day old
-- and this says nothing does. A deleted message's attachments live on in its
-- revision, kept as evidence, so they count. The partial GIN indexes make
-- each probe an index lookup over the few rows that have attachments at all.
create index if not exists chat_messages_attachments_idx on public.chat_messages
  using gin (attachments jsonb_path_ops) where attachments <> '[]'::jsonb;
create index if not exists chat_message_revisions_attachments_idx on public.chat_message_revisions
  using gin (attachments jsonb_path_ops) where attachments <> '[]'::jsonb;

create or replace function public.chat_files_in_use(p_paths text[])
returns setof text
language sql
stable
security definer set search_path = public
as $$
  select p from unnest(p_paths) as p
  where exists (
      select 1 from public.chat_messages m
      where m.attachments <> '[]'::jsonb
        and m.attachments @> jsonb_build_array(jsonb_build_object('path', p)))
    or exists (
      select 1 from public.chat_message_revisions r
      where r.attachments <> '[]'::jsonb
        and r.attachments @> jsonb_build_array(jsonb_build_object('path', p)));
$$;

revoke execute on function public.chat_files_in_use(text[]) from public, anon, authenticated;
grant execute on function public.chat_files_in_use(text[]) to service_role;

-- ----------------------------------------------------------------------------
-- 8. Policies: READ ONLY. Write policies are dropped by name so a re-run over
--    a hand-edited database removes them.
-- ----------------------------------------------------------------------------
drop policy if exists "chat_channels read" on public.chat_channels;
create policy "chat_channels read" on public.chat_channels
  for select using (public.chat_viewer_can_read(chat_channels));

drop policy if exists "chat_messages read" on public.chat_messages;
create policy "chat_messages read" on public.chat_messages
  for select using (public.chat_viewer_can_read_channel(channel_id));

-- Readers see every column but who removed a message and who pinned it.
-- deleted_by would tell a reported DM's members which moderator is working
-- it; RLS is per row, so the columns are held back by privilege — and
-- Realtime sends only the columns a subscriber may select. The app reads
-- through the service role and never needs them here.
revoke select on public.chat_messages from anon, authenticated;
grant select (id, channel_id, sender_id, body, reply_to_id, mentions, mention_everyone, attachments,
              reactions, kind, created_at, edited_at, deleted_at, pinned_at)
  on public.chat_messages to authenticated;

drop policy if exists "chat_members read" on public.chat_members;
create policy "chat_members read" on public.chat_members
  for select using (public.chat_viewer_can_read_channel(channel_id));

drop policy if exists "chat_reactions read" on public.chat_reactions;
create policy "chat_reactions read" on public.chat_reactions
  for select using (exists (
    select 1 from public.chat_messages m
    where m.id = chat_reactions.message_id and public.chat_viewer_can_read_channel(m.channel_id)
  ));

drop policy if exists "chat_reads own" on public.chat_reads;
create policy "chat_reads own" on public.chat_reads
  for select using (user_id = auth.uid());

-- Your block list is yours; being blocked is not something you get told.
drop policy if exists "chat_blocks own" on public.chat_blocks;
create policy "chat_blocks own" on public.chat_blocks
  for select using (blocker_id = auth.uid());

-- Reports, revisions and mutes have no policy at all: service role only. A
-- report's row says who else in the channel has been reported (party_ids)
-- and which moderator handled it (reviewed_by); the app reads reports only
-- through the service role, so nobody needs a policy on them.
drop policy if exists "chat_reports own" on public.chat_reports;
do $$
declare
  p record;
begin
  for p in
    select tablename, policyname from pg_policies
    where schemaname = 'public'
      and ((tablename in ('chat_channels', 'chat_members', 'chat_reads', 'chat_messages',
                          'chat_reactions', 'chat_blocks')
            and cmd <> 'SELECT')
           or tablename in ('chat_reports', 'chat_message_revisions', 'chat_mutes'))
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- Bells: admins could read every user's notifications (0005), and a chat bell
-- says who wrote to whom, and when — a staff read path into unreported DMs,
-- and a reported moderator could see other moderators' report bells. Admins
-- keep reading everyone else's other bells; chat ones, and the old DM ones
-- (0089), only their own.
do $$
begin
  if to_regclass('public.notifications') is not null then
    drop policy if exists "notifications self select" on public.notifications;
    create policy "notifications self select" on public.notifications
      for select using (
        user_id = auth.uid()
        or (public.is_admin(auth.uid())
            and not starts_with(type, 'chat_')
            and type not in ('direct_message', 'dm_reported'))
      );
  end if;
end $$;

-- And a bell never carries the words either. The app sends no body; this
-- makes it a guarantee.
create or replace function public.dm_notification_strip_body()
returns trigger
language plpgsql
as $$
begin
  if new.type in ('direct_message', 'dm_reported', 'chat_dm', 'chat_mention', 'chat_message', 'chat_reported') then
    new.body := null;
  end if;
  return new;
end;
$$;

do $$
begin
  if to_regclass('public.notifications') is not null then
    drop trigger if exists dm_notification_strip_body on public.notifications;
    create trigger dm_notification_strip_body
      before insert or update on public.notifications
      for each row execute procedure public.dm_notification_strip_body();
  end if;
end $$;

-- Realtime: only chat_messages. The client subscribes to the channel it has
-- open, a channel the server already cleared it for, and Realtime re-applies
-- the read policy above to every row it sends.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages'
     ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;

-- Presence (online dots) and typing ride PRIVATE Realtime topics, which
-- Realtime authorizes against realtime.messages' policies when a client joins
-- or sends (components/chat/use-chat-live.ts):
--   chat-presence          everyone let in (the people the directory shows)
--   chat-typing:<channel>  whoever can read that channel
-- Anything else is no topic of chat's: another policy may still allow it.
create or replace function public.chat_realtime_allowed(topic text)
returns boolean
language plpgsql
stable
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null or topic is null then
    return false;
  end if;
  if topic = 'chat-presence' then
    return public.chat_is_vetted(uid);
  end if;
  if topic ~ '^chat-typing:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return public.chat_viewer_can_read_channel(substr(topic, 13)::uuid);
  end if;
  return false;
end;
$$;

-- Supabase only: plain Postgres has no realtime schema.
do $$
begin
  if to_regclass('realtime.messages') is not null and to_regprocedure('realtime.topic()') is not null then
    drop policy if exists "chat presence and typing: listen" on realtime.messages;
    create policy "chat presence and typing: listen" on realtime.messages
      for select to authenticated
      using (realtime.messages.extension in ('broadcast', 'presence')
             and public.chat_realtime_allowed(realtime.topic()));
    drop policy if exists "chat presence and typing: send" on realtime.messages;
    create policy "chat presence and typing: send" on realtime.messages
      for insert to authenticated
      with check (realtime.messages.extension in ('broadcast', 'presence')
                  and public.chat_realtime_allowed(realtime.topic()));
  end if;
end $$;

-- Attachments: a private bucket with no storage.objects policy at all. The
-- server mints one-shot upload URLs and 10-minute download URLs after its
-- own access check (lib/chat-files.ts), the support-attachments pattern.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('chat-files', 'chat-files', false, 10485760)
    on conflict (id) do update set public = false, file_size_limit = 10485760;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 9. The channels batch0 starts with, and one per cohort and per team.
-- ----------------------------------------------------------------------------
create or replace function public.chat_slug(input text, fallback text)
returns text
language sql
immutable
as $$
  select coalesce(
    nullif(left(trim(both '-' from regexp_replace(lower(coalesce(input, '')), '[^a-z0-9]+', '-', 'g')), 80), ''),
    fallback
  );
$$;

insert into public.chat_channels (kind, name, topic, audience, posting, position, system_key) values
  ('channel', 'announcements', 'News from the batch0 team. Only staff post here.', 'everyone', 'staff', 0, 'announcements'),
  ('channel', 'general', 'Say hi. Talk shop with everyone at batch0.', 'everyone', 'everyone', 1, 'general'),
  ('channel', 'wins', 'Shipped something? First customer? Post it.', 'everyone', 'everyone', 2, 'wins'),
  ('channel', 'help', 'Stuck for twenty minutes? Ask here.', 'everyone', 'everyone', 3, 'help'),
  ('channel', 'staff', 'The batch0 team only.', 'staff', 'everyone', 4, 'staff')
on conflict (system_key) do nothing;

create or replace function public.chat_ensure_cohort_channel()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.status <> 'cancelled' then
    insert into public.chat_channels (kind, name, topic, audience, cohort_id, position, system_key)
    values ('channel', public.chat_slug(new.name, 'cohort'), left('Everyone in ' || new.name || '.', 300),
            'cohort', new.id, 10, 'cohort:' || new.id)
    on conflict (system_key) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists chat_ensure_cohort_channel on public.cohorts;
create trigger chat_ensure_cohort_channel
  after insert or update of status on public.cohorts
  for each row execute procedure public.chat_ensure_cohort_channel();

create or replace function public.chat_ensure_team_channel()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.chat_channels (kind, name, topic, audience, team_id, position, system_key)
  values ('channel', public.chat_slug('team-' || coalesce(new.slug, new.name), 'team'),
          left(new.name || ' — your team''s channel.', 300), 'team', new.id, 20, 'team:' || new.id)
  on conflict (system_key) do nothing;
  return new;
end;
$$;

drop trigger if exists chat_ensure_team_channel on public.teams;
create trigger chat_ensure_team_channel
  after insert on public.teams
  for each row execute procedure public.chat_ensure_team_channel();

-- And when a team or cohort is deleted (a student leaving as a team's last
-- member deletes it), its channel stays: archived, read by staff alone, every
-- message, revision and report kept. It's no longer the team's channel, so
-- batch0 stops owning it (system_key goes) and staff may delete it once
-- nothing reported is in it. Runs before the delete, while the channel still
-- points at the team; the foreign keys' `set null` then has nothing left.
create or replace function public.chat_keep_scoped_channels()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  scope text := case tg_table_name when 'teams' then 'team' else 'cohort' end;
begin
  update public.chat_channels c
  set team_id = case when scope = 'team' then null else c.team_id end,
      cohort_id = case when scope = 'cohort' then null else c.cohort_id end,
      audience = case when c.audience = scope then 'staff' else c.audience end,
      archived_at = case when c.audience = scope then coalesce(c.archived_at, now()) else c.archived_at end,
      system_key = case when c.system_key = scope || ':' || old.id then null else c.system_key end
  where (scope = 'team' and c.team_id = old.id) or (scope = 'cohort' and c.cohort_id = old.id);
  return old;
end;
$$;

drop trigger if exists chat_keep_scoped_channels on public.teams;
create trigger chat_keep_scoped_channels
  before delete on public.teams
  for each row execute procedure public.chat_keep_scoped_channels();

drop trigger if exists chat_keep_scoped_channels on public.cohorts;
create trigger chat_keep_scoped_channels
  before delete on public.cohorts
  for each row execute procedure public.chat_keep_scoped_channels();

insert into public.chat_channels (kind, name, topic, audience, cohort_id, position, system_key)
select 'channel', public.chat_slug(c.name, 'cohort'), left('Everyone in ' || c.name || '.', 300),
       'cohort', c.id, 10, 'cohort:' || c.id
from public.cohorts c
where c.status <> 'cancelled'
on conflict (system_key) do nothing;

insert into public.chat_channels (kind, name, topic, audience, team_id, position, system_key)
select 'channel', public.chat_slug('team-' || coalesce(t.slug, t.name), 'team'),
       left(t.name || ' — your team''s channel.', 300), 'team', t.id, 20, 'team:' || t.id
from public.teams t
on conflict (system_key) do nothing;

-- ----------------------------------------------------------------------------
-- 10. History: the old direct messages (0089) and team threads (0011) come
--     back as Chat DMs and team-channel messages, with the same ids. Unsent
--     DMs arrive deleted, their words in the revisions table only. Blocks and
--     DM reports carry over, and the old tables close to everyone but the
--     service role.
--
--     Once only (the chat_history_carried setting), like the blocks below.
--     Nothing writes the old tables after this, so there is never anything
--     new to carry — and a second carry could only undo what Chat has done
--     since: bring back a revision an account deletion removed, or a DM
--     channel or team-thread message staff deleted.
-- ----------------------------------------------------------------------------
do $$
declare
  moved text[] := '{}';
  legacy record;
  carried boolean := exists (select 1 from public.site_settings where key = 'chat_history_carried');
begin
  if not carried
     and to_regclass('public.dm_conversations') is not null
     and to_regclass('public.dm_messages') is not null then

    insert into public.chat_channels (id, kind, audience, dm_key, created_at)
    select d.id, 'dm', 'members',
           case when d.user_a is not null and d.user_b is not null
                then least(d.user_a::text, d.user_b::text) || ':' || greatest(d.user_a::text, d.user_b::text)
                else 'legacy:' || d.id::text end,
           d.created_at
    from public.dm_conversations d
    on conflict do nothing;

    insert into public.chat_members (channel_id, user_id, created_at)
    select d.id, u.uid, d.created_at
    from public.dm_conversations d
    cross join lateral (values (d.user_a), (d.user_b)) as u(uid)
    where u.uid is not null
      and exists (select 1 from public.chat_channels c where c.id = d.id)
    on conflict do nothing;

    insert into public.chat_reads (channel_id, user_id, last_read_at, seen_at)
    select d.id, u.uid, u.read_at, u.seen_at
    from public.dm_conversations d
    cross join lateral (values
      (d.user_a, d.a_last_read_at, d.a_seen_at),
      (d.user_b, d.b_last_read_at, d.b_seen_at)) as u(uid, read_at, seen_at)
    where u.uid is not null
      and exists (select 1 from public.chat_channels c where c.id = d.id)
    on conflict do nothing;

    insert into public.chat_messages (id, channel_id, sender_id, body, created_at, deleted_at)
    select m.id, m.conversation_id, m.sender_id,
           case when m.unsent_at is null then m.body else '' end,
           m.created_at, m.unsent_at
    from public.dm_messages m
    where exists (select 1 from public.chat_channels c where c.id = m.conversation_id)
    on conflict do nothing;

    insert into public.chat_message_revisions (message_id, body, reason, created_at)
    select m.id, m.body, 'delete', m.unsent_at
    from public.dm_messages m
    where m.unsent_at is not null
      and exists (select 1 from public.chat_messages cm where cm.id = m.id)
      and not exists (select 1 from public.chat_message_revisions r where r.message_id = m.id);
  end if;

  -- Once only: an unblock in Chat deletes the chat_blocks row, and a re-run
  -- copying dm_blocks again would quietly put it back. The marker, not "while
  -- chat_blocks is empty" — that's true again once everyone has unblocked.
  if to_regclass('public.dm_blocks') is not null
     and not exists (select 1 from public.site_settings where key = 'chat_blocks_carried') then
    insert into public.chat_blocks (blocker_id, blocked_id, created_at)
    select b.blocker_id, b.blocked_id, b.created_at from public.dm_blocks b
    where b.blocker_id <> b.blocked_id
      and exists (select 1 from public.profiles p where p.id = b.blocker_id)
      and exists (select 1 from public.profiles p where p.id = b.blocked_id)
    on conflict do nothing;
    insert into public.site_settings (key, value) values ('chat_blocks_carried', 'true'::jsonb)
    on conflict (key) do nothing;
  end if;

  if not carried and to_regclass('public.dm_reports') is not null and to_regclass('public.dm_conversations') is not null then
    -- 0099 turned every open DM report into a sensitive Support concern, and
    -- that's where it's being worked. Carried here as still open, the same
    -- report would sit in two queues, so such a copy arrives closed. (Kept,
    -- not skipped: a report is also what opens the DM to staff.) Decided as
    -- it's carried, never again: a re-run mustn't close a report a moderator
    -- has since reopened.
    if to_regclass('public.support_tickets') is not null then
      select coalesce(array_agg(t.context ->> 'carriedFrom'), '{}') into moved
      from public.support_tickets t
      where t.context ->> 'carriedFrom' like 'dm_report:%';
    end if;

    insert into public.chat_reports (id, channel_id, reporter_id, reason, status, reviewed_by, reviewed_at, party_ids, created_at)
    select r.id, r.conversation_id, r.reporter_id, r.reason,
           case when r.status = 'open' and 'dm_report:' || r.id::text = any(moved) then 'actioned' else r.status end,
           r.reviewed_by, r.reviewed_at,
           coalesce((select array_remove(array[d.user_a, d.user_b], null)
                     from public.dm_conversations d where d.id = r.conversation_id), '{}'),
           r.created_at
    from public.dm_reports r
    where exists (select 1 from public.chat_channels c where c.id = r.conversation_id)
    on conflict do nothing;

    -- Every carried report is handled from here on: in Chat, or in Support
    -- where 0099 moved it first. Say so on the old row, so a 0099 run after
    -- this one (it moves the open ones to Support) can't put a second copy of
    -- a report that's open in Chat into the Support queue.
    update public.dm_reports r
    set status = 'actioned'
    where r.status = 'open'
      and exists (select 1 from public.chat_reports cr where cr.id = r.id);
  end if;

  if not carried and to_regclass('public.team_messages') is not null then
    insert into public.chat_messages (id, channel_id, sender_id, body, created_at)
    select tm.id, c.id, tm.author_id, left(tm.body, 4000), tm.created_at
    from public.team_messages tm
    join public.chat_channels c on c.system_key = 'team:' || tm.team_id
    where char_length(tm.body) > 0
    on conflict do nothing;
  end if;

  if not carried then
    insert into public.site_settings (key, value) values ('chat_history_carried', 'true'::jsonb)
    on conflict (key) do nothing;
  end if;

  -- The old tables stay (nothing is dropped that a re-run would need), but
  -- they're the service role's alone now. Their read policies would let
  -- either side of an old DM read, through the API, the words someone has
  -- since deleted in Chat, and moderators without chat.manage read reported
  -- DMs. RLS stays on, with no policy left.
  for legacy in
    select tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('dm_conversations', 'dm_messages', 'dm_reports', 'dm_blocks', 'team_messages')
  loop
    execute format('drop policy if exists %I on public.%I', legacy.policyname, legacy.tablename);
  end loop;
  for legacy in
    select c.relname as tablename from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and c.relname in ('dm_conversations', 'dm_messages', 'dm_reports', 'dm_blocks', 'team_messages')
  loop
    execute format('alter table public.%I enable row level security', legacy.tablename);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 11. Discord, removed.
-- ----------------------------------------------------------------------------

-- discord.manage goes, and is NOT turned into chat.manage: configuring a bot
-- was a harmless grant, while chat.manage opens every reported DM (the
-- carried-over reports included, harassment ones among them). An admin
-- grants chat.manage on purpose, at /admin/roles; '*' admins run Chat already.
update public.app_roles
set permissions = array_remove(permissions, 'discord.manage')
where permissions @> array['discord.manage']::text[];

-- The integration's own tables: the auto-answer ledger (0067) and the
-- slash-command tables (0033: office-hours queue, mentor on-call, blocker
-- flags, button RSVPs). Nothing outside the Discord code ever read them.
drop function if exists public.discord_auto_transition(text, jsonb);
drop function if exists public.discord_auto_state();
drop table if exists public.discord_auto_jobs;
drop table if exists public.discord_auto_cursors;
drop table if exists public.discord_auto_config;
drop table if exists public.oh_queue;
drop table if exists public.mentor_oncall;
drop table if exists public.team_blockers;
drop table if exists public.event_rsvps;

-- The profile guard (0077) without the Discord columns it protected.
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  guarded text[] := array['id', 'role', 'email', 'stripe_customer_id'];
  col text;
  old_j jsonb := to_jsonb(old);
  new_j jsonb := to_jsonb(new);
begin
  if auth.uid() is null then
    return new;
  end if;
  if public.is_admin(auth.uid()) then
    return new;
  end if;
  foreach col in array guarded loop
    if (old_j ->> col) is distinct from (new_j ->> col) then
      raise exception
        'profiles.% cannot be changed by its owner', col
        using errcode = '42501',
              hint = 'Only an administrator (or the server) may change this field.';
    end if;
  end loop;
  return new;
end;
$$;

drop index if exists public.profiles_discord_user_id_unique;
alter table public.profiles
  drop column if exists discord_user_id,
  drop column if exists discord_username,
  drop column if exists discord_avatar,
  drop column if exists discord_linked_at,
  drop column if exists discord_introduced_at,
  drop column if exists discord_first_rsvp_at,
  drop column if exists discord_onboarded_nudged_at;

alter table public.teams
  drop column if exists discord_text_channel_id,
  drop column if exists discord_voice_channel_id;

delete from public.site_settings where key like 'discord%';

-- Old bells. A Discord blocker flag's bell linked into the server (0093 took
-- the at-risk ones already); with the bot gone the link leads nowhere, and
-- the kind still renders without one. An old DM's bell opens it in Chat (a
-- redirect), but reading it there can't clear a bell of the old kind, and
-- Chat counts that DM's unread itself, carried cursor and all.
do $$
begin
  if to_regclass('public.notifications') is not null then
    update public.notifications set link = null
    where type = 'discord_blocker' and link like 'https://discord.com/%';
    update public.notifications set read_at = now()
    where type = 'direct_message' and read_at is null;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 12. Copy that sent students to Discord now sends them to Chat: the lesson
--     sentences 0099 rewrote, the one stored email that named it, and saved
--     kickoff checklists. No replacement contains a phrase replaced after
--     it, so a re-run changes nothing.
-- ----------------------------------------------------------------------------
do $$
declare
  r record;
begin
  if to_regclass('public.lessons') is null then return; end if;
  for r in
    select * from (values
      (1, $t$- [Discord](/dashboard/community): chat with your cohort.$t$,
          $t$- [Chat](/chat): talk with your cohort, your team and the batch0 team.$t$),
      (2, $t$your cohort channel on [Discord](/dashboard/community)$t$,
          $t$your cohort channel in [Chat](/chat)$t$),
      (3, $t$the cohort on [Discord](/dashboard/community)$t$,
          $t$the cohort in [Chat](/chat)$t$),
      (4, $t$another team on [Discord](/dashboard/community)$t$,
          $t$another team in [Chat](/chat)$t$),
      (5, $t$post it on [Discord](/dashboard/community)$t$,
          $t$post it in [Chat](/chat)$t$),
      (6, $t$the cohort on Discord$t$,
          $t$the cohort in Chat$t$),
      (7, $t$on [Discord](/dashboard/community)$t$,
          $t$in [Chat](/chat)$t$),
      (8, $t$[Discord](/dashboard/community)$t$,
          $t$[Chat](/chat)$t$),
      (9, $t$/dashboard/community$t$,
          $t$/chat$t$)
    ) as v(ord, old_text, new_text)
    order by ord
  loop
    update public.lessons
    set description = replace(description, r.old_text, r.new_text)
    where strpos(description, r.old_text) > 0;
  end loop;
end $$;

do $$
begin
  if to_regclass('public.email_templates') is null then return; end if;
  update public.email_templates
  set body_html = replace(body_html,
        'or put it in your cohort''s Discord',
        'or post it in your cohort''s channel in Chat')
  where strpos(body_html, 'or put it in your cohort''s Discord') > 0;
end $$;

-- A kickoff checklist an admin saved (0049) whose community row is the old
-- Discord one ("Link Discord and meet your cohort" → /dashboard/community)
-- becomes Chat's row, as lib/kickoff.ts's default and parseChecklist() have it.
do $$
begin
  if to_regclass('public.cohort_kickoff') is null then return; end if;
  update public.cohort_kickoff k
  set checklist = (
    select jsonb_agg(
             case when e ->> 'href' = '/dashboard/community'
                  then jsonb_build_object('label', 'Say hi in #general and your cohort''s channel', 'href', '/chat')
                  else e end
             order by i)
    from jsonb_array_elements(k.checklist) with ordinality as t(e, i)
  )
  where k.checklist @> '[{"href": "/dashboard/community"}]'::jsonb;
end $$;

comment on table public.chat_channels is
  'batch0 Chat: a text channel (audience-gated), a one-to-one DM (dm_key) or a group DM. Readability: chat_can_read().';
comment on table public.chat_messages is
  'Messages. Deleting blanks body/attachments in place; the original text is kept in chat_message_revisions (service role only).';
comment on table public.chat_members is
  'Explicit grants: DM and group members, private-channel members, and extra people on an audience channel. Never a read cursor.';
comment on table public.chat_reads is
  'Per-person read cursor, presence, notification preference and closed-DM state for a channel.';
comment on table public.chat_reports is
  'Reports. party_ids: who it is about, frozen at filing; no moderator a report on the channel names may see them. Blocks deleting the channel.';
comment on table public.chat_mutes is
  'People staff have stopped from posting in Chat, until `until` (null: until lifted). Service role only.';

notify pgrst, 'reload schema';
