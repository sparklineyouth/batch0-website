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
--   cohort     channel   people enrolled in that cohort
--   team       channel   that team's members
--   staff      channel   staff only
--   members    channel   explicit members only (a private channel)
--   members    dm/group  its members
--
-- plus, for every channel: staff (`chat.manage` or the '*' wildcard) and
-- anyone with an explicit chat_members row. DMs and group DMs have NO staff
-- read path until one of their members reports them — the promise the old
-- direct messages (0089) made, kept here. A fresh, unvetted signup sees no
-- community channel at all; they can still message the team.
--
-- Writes: none from the browser. Every insert, edit, delete, reaction, block,
-- report and read-cursor move is a server action on the service role
-- (app/chat/actions.ts), after the access check, the block check, slow mode,
-- the rate limits and the notification logic. Signed-in users get READ
-- policies only — the browser needs them for Realtime.
--
-- Deleting a message blanks it in place (body '', attachments '[]',
-- deleted_at set) so the Realtime UPDATE reaches every open screen at once.
-- What it said is kept in chat_message_revisions, readable by nobody but the
-- service role: the moderation queue shows it when the message is reported,
-- so deleting or editing first is no way to hide what was sent.
--
-- Also in this file (sections 9–12): the Discord integration's tables,
-- columns, settings and permission are dropped (`discord.manage` is removed,
-- NOT turned into `chat.manage` — grant that on purpose), the old DM and
-- team-thread history is carried into Chat, and lesson and email copy that
-- sent students to Discord now sends them to Chat.
-- DROPS ARE NOT REVERSIBLE: take a backup first if you may want the Discord
-- ids, the auto-answer ledger, the office-hours queue or the blocker flags.
--
-- Run in Supabase SQL Editor after the deploy. Idempotent / safe to re-run.
-- Assumes 0001..0100 are applied (0048 app_roles, 0089 is optional).
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
  cohort_id uuid references public.cohorts(id) on delete cascade,
  team_id uuid references public.teams(id) on delete cascade,
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
--    channel on top of its audience (a mentor in a cohort channel).
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

-- The channel's summary columns, recomputed from the messages rather than
-- incremented (the 0089 pattern): a delete needs no special case and two
-- messages landing at once can't lose a count to a read-then-write race.
create or replace function public.chat_messages_touch_channel()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  cid uuid := coalesce(new.channel_id, old.channel_id);
  last_row public.chat_messages;
begin
  -- NO KEY UPDATE, not UPDATE: every message insert already holds KEY SHARE
  -- on the channel through its foreign key, and FOR UPDATE conflicts with
  -- that — two concurrent sends would deadlock (0089's note).
  perform 1 from public.chat_channels where id = cid for no key update;
  if not found then return null; end if;

  select * into last_row
  from public.chat_messages m
  where m.channel_id = cid and m.deleted_at is null and m.kind = 'message'
  order by m.created_at desc, m.id desc
  limit 1;

  update public.chat_channels c
  set message_count = (
        select count(*) from public.chat_messages m
        where m.channel_id = cid and m.deleted_at is null and m.kind = 'message'
      ),
      last_message_at = last_row.created_at,
      last_message_preview = case
        when last_row.id is null then null
        when char_length(last_row.body) > 0 then left(last_row.body, 140)
        else '[attachment]'
      end,
      last_sender_id = last_row.sender_id
  where c.id = cid;
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
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  -- Null for a report about a whole DM or group.
  message_id uuid references public.chat_messages(id) on delete set null,
  reporter_id uuid references public.profiles(id) on delete set null,
  reason text not null check (char_length(reason) between 1 and 2000),
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  -- Who the report is about, frozen when it's filed: everyone in the DM or
  -- group then, and the reported message's sender. None of them may read
  -- the report, or the conversation through it — a moderator who is one of
  -- them would learn who reported them, and why. Not a foreign key: someone
  -- who deletes their account still mustn't come back as a reader.
  party_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.chat_reports add column if not exists party_ids uuid[] not null default '{}';
create index if not exists chat_reports_queue_idx on public.chat_reports (status, created_at desc);
create index if not exists chat_reports_channel_idx on public.chat_reports (channel_id);

alter table public.chat_channels enable row level security;
alter table public.chat_members enable row level security;
alter table public.chat_reads enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_message_revisions enable row level security;
alter table public.chat_reactions enable row level security;
alter table public.chat_blocks enable row level security;
alter table public.chat_reports enable row level security;

-- ----------------------------------------------------------------------------
-- 7. Predicates. One definition each, used by every policy.
-- ----------------------------------------------------------------------------

-- Staff: runs chat. Reads every channel (never an unreported DM), posts in
-- read-only channels, pins, removes messages, works the report queue.
create or replace function public.chat_is_staff(uid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select uid is not null and (public.is_admin(uid) or public.has_permission(uid, 'chat.manage'));
$$;

-- Let in: a non-student role, or a student with an enrollment or an accepted
-- application. Mirrors vettedIds() in lib/chat.ts.
create or replace function public.chat_is_vetted(uid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select uid is not null and (
    exists (select 1 from public.profiles p where p.id = uid and coalesce(p.role, 'student') <> 'student')
    or exists (select 1 from public.enrollments e where e.user_id = uid)
    or exists (
      select 1 from public.applications a
      where a.user_id = uid and a.status in ('accepted', 'paid', 'enrolled')
    )
  );
$$;

create or replace function public.chat_can_read(c public.chat_channels, uid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select uid is not null and (
    exists (select 1 from public.chat_members m where m.channel_id = c.id and m.user_id = uid)
    or (c.kind = 'channel' and (
      public.chat_is_staff(uid)
      or (c.audience = 'everyone' and public.chat_is_vetted(uid))
      or (c.audience = 'cohort' and exists (
            select 1 from public.enrollments e where e.user_id = uid and e.cohort_id = c.cohort_id))
      or (c.audience = 'team' and (
            exists (select 1 from public.team_members tm where tm.user_id = uid and tm.team_id = c.team_id)
            -- A mentor assigned to anyone on the team, as the Discord
            -- team-channel sync used to grant. mentoredTeamIds() in lib/chat.ts.
            or exists (
              select 1 from public.mentor_assignments ma
              join public.team_members tm on tm.user_id = ma.student_id
              where ma.mentor_id = uid and tm.team_id = c.team_id)))
    ))
    -- A reported DM or group opens to staff, and only once reported — never
    -- to a moderator the report is about (reportOpenTo in lib/chat-access.ts).
    or (c.kind in ('dm', 'group')
        and public.chat_is_staff(uid)
        and exists (
          select 1 from public.chat_reports r
          where r.channel_id = c.id and not (uid = any(r.party_ids))))
  );
$$;

-- What the read policies call: always as the signed-in user, never for an id
-- passed in, so /rpc can't be used to ask what someone else can read.
create or replace function public.chat_viewer_can_read(c public.chat_channels)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select public.chat_can_read(c, auth.uid());
$$;

create or replace function public.chat_viewer_can_read_channel(cid uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.chat_channels c
    where c.id = cid and public.chat_can_read(c, auth.uid())
  );
$$;

-- Unread and mention counts for the sidebar, in one query. Service role only
-- (it takes a uid). A channel the person has never opened counts from two
-- weeks back, so joining a cohort doesn't open on "99+".
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
         and m.deleted_at is null and m.kind = 'message'
         and m.sender_id is distinct from p_uid
         and m.created_at > coalesce(r.last_read_at,
               case when c.kind = 'channel' then now() - interval '14 days' else 'epoch'::timestamptz end)
       limit 100) x),
    (select count(*)::int from (
       select 1 from public.chat_messages m
       where m.channel_id = c.id
         and m.deleted_at is null and m.kind = 'message'
         and m.sender_id is distinct from p_uid
         and (p_uid = any(m.mentions) or m.mention_everyone)
         and m.created_at > coalesce(r.last_read_at,
               case when c.kind = 'channel' then now() - interval '14 days' else 'epoch'::timestamptz end)
       limit 100) y)
  from public.chat_channels c
  left join public.chat_reads r on r.channel_id = c.id and r.user_id = p_uid
  where c.id = any(p_channel_ids);
$$;

revoke execute on function public.chat_is_staff(uuid) from public, anon, authenticated;
revoke execute on function public.chat_is_vetted(uuid) from public, anon, authenticated;
revoke execute on function public.chat_can_read(public.chat_channels, uuid) from public, anon, authenticated;
revoke execute on function public.chat_unread(uuid, uuid[]) from public, anon, authenticated;

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

drop policy if exists "chat_reports own" on public.chat_reports;
create policy "chat_reports own" on public.chat_reports
  for select using (reporter_id = auth.uid());

do $$
declare
  p record;
begin
  for p in
    select tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('chat_channels', 'chat_members', 'chat_reads', 'chat_messages',
                        'chat_message_revisions', 'chat_reactions', 'chat_blocks', 'chat_reports')
      and cmd <> 'SELECT'
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- A chat bell never carries the words: every admin can read every
-- notification (0016), so a preview would be a staff read path into an
-- unreported DM. The app sends no body; this makes it a guarantee.
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

-- Realtime: only chat_messages. The client subscribes with a
-- `channel_id=in.(...)` filter naming channels the server already cleared it
-- for, and Realtime re-applies the read policy above to every row it sends.
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
--     back as Chat DMs and team-channel messages, with the same ids, so a
--     re-run inserts nothing twice. Unsent DMs arrive deleted, their words in
--     the revisions table only. Blocks and DM reports carry over.
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.dm_conversations') is not null
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

  if to_regclass('public.dm_reports') is not null and to_regclass('public.dm_conversations') is not null then
    insert into public.chat_reports (id, channel_id, reporter_id, reason, status, reviewed_by, reviewed_at, party_ids, created_at)
    select r.id, r.conversation_id, r.reporter_id, r.reason, r.status, r.reviewed_by, r.reviewed_at,
           coalesce((select array_remove(array[d.user_a, d.user_b], null)
                     from public.dm_conversations d where d.id = r.conversation_id), '{}'),
           r.created_at
    from public.dm_reports r
    where exists (select 1 from public.chat_channels c where c.id = r.conversation_id)
    on conflict do nothing;

    -- 0099 already turned every open DM report into a sensitive Support
    -- concern, and that's where it's being worked. Carried here as still
    -- open, the same report would sit in two queues; close this copy. (Kept,
    -- not skipped: a report is also what opens the DM to staff.)
    if to_regclass('public.support_tickets') is not null then
      update public.chat_reports cr
      set status = 'actioned'
      where cr.status = 'open'
        and exists (select 1 from public.dm_reports r where r.id = cr.id)
        and exists (
          select 1 from public.support_tickets t
          where t.context ->> 'carriedFrom' = 'dm_report:' || cr.id::text);
    end if;
  end if;

  if to_regclass('public.team_messages') is not null then
    insert into public.chat_messages (id, channel_id, sender_id, body, created_at)
    select tm.id, c.id, tm.author_id, left(tm.body, 4000), tm.created_at
    from public.team_messages tm
    join public.chat_channels c on c.system_key = 'team:' || tm.team_id
    where char_length(tm.body) > 0
    on conflict do nothing;
  end if;
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

-- ----------------------------------------------------------------------------
-- 12. Copy that sent students to Discord now sends them to Chat: the lesson
--     sentences 0099 rewrote, and the one stored email that named it.
--     No replacement contains a phrase replaced after it, so a re-run changes
--     nothing.
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

comment on table public.chat_channels is
  'batch0 Chat: a text channel (audience-gated), a one-to-one DM (dm_key) or a group DM. Readability: chat_can_read().';
comment on table public.chat_messages is
  'Messages. Deleting blanks body/attachments in place; the original text is kept in chat_message_revisions (service role only).';
comment on table public.chat_members is
  'Explicit grants: DM and group members, private-channel members, and extra people on an audience channel. Never a read cursor.';
comment on table public.chat_reads is
  'Per-person read cursor, presence, notification preference and closed-DM state for a channel.';

notify pgrst, 'reload schema';
