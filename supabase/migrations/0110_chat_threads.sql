-- ============================================================================
-- 0110 — batch0 Chat: threads on channel messages, and #help's questions.
--
-- Chat's replies were quotations in the one chronological feed, so a question
-- asked in #help and the four answers to it were mixed into everything else,
-- and nobody could tell which questions were still waiting. Now:
--
--   * A message in a TEXT CHANNEL can start a thread: replies carry
--     `chat_messages.thread_root_id`, the message they hang off. One level
--     only — a reply can't start a thread of its own — and a reply's root is
--     always in the reply's own channel: (thread_root_id, channel_id) is a
--     foreign key onto (id, channel_id), so no write path, the service role's
--     included, can hang a reply in #general off a message in a team channel.
--     DMs and groups have no threads. Replies live in the same table as every
--     other message, so authorship, edits and their revisions, deletes, files,
--     reactions, reports and the read policy all work on them unchanged — a
--     thread grants nobody anything: who reads a reply is who reads its
--     channel, now (chat_viewer_channel_ids, 0101 §8).
--
--   * `chat_threads`, one row per root: its live reply count and last reply
--     (kept by a trigger, so the "4 replies" under a message is never a
--     separate guess), and, in #help, its question state: open or answered,
--     with an optional accepted answer that must be a live reply IN THAT
--     THREAD (a trigger checks, whatever writes it). Every top-level message
--     someone outside the team posts in #help is a question, open, from the
--     moment it's posted (a trigger, so every insert path agrees). Deleting
--     the accepted answer reopens the question in the same transaction as the
--     delete; deleting the question itself retires it. Plus the one help
--     request the team was asked for (`help_ticket_id`, a Support ticket:
--     owner and open/handled live there, the one record), and the course item
--     a question is about (an id only — a title is resolved per viewer, by
--     the item's own read rule, never stored here).
--
--   * `chat_thread_events`, the audit trail of every question transition —
--     asked, accepted, marked answered, reopened, unmarked, an answer or a
--     question removed — written by a trigger on chat_threads, so no write
--     can change the state without leaving a row. Append-only.
--
--   * `chat_thread_follows`: who hears about new replies. The root's author
--     and everyone who replies follow by default (a trigger, on each reply);
--     unfollowing is sticky — replying again doesn't undo it. Plus the "had
--     it open just now" stamp that holds a bell back (the channel rule, 0101).
--
-- Thread replies are not channel messages for the channel's summary, its
-- unread and mention counts, or the read cursor: they don't flood the feed,
-- and they don't light up the channel either. Their bells come from following
-- (lib/chat-notify.ts notifyThreadReply), never from a channel's "All
-- messages" setting, and a reply can't @everyone: a reply never notifies a
-- whole cohort. So this file replaces two 0101 functions,
-- chat_messages_touch_channel() and chat_unread(), with the same bodies plus
-- "and not a thread reply", and adds the new bell type to 0101's
-- dm_notification_strip_body().
--
-- All three new tables are service role only (RLS on, no policy, the API
-- roles' default grants revoked): the app reads them with the viewer checked
-- explicitly (lib/chat-threads.ts), like reports and revisions. Readers may
-- select `thread_root_id`, because Realtime sends only the columns a
-- subscriber may select and the client routes a reply to its thread by it.
--
-- Deploy order. Either way works:
--   * this file first: the code still running doesn't know the column, and
--     nothing writes it but the new code, so the old code sees nothing new
--     (#help's new posts get question rows nobody reads yet);
--   * the code first: it asks for the column once a minute
--     (lib/chat-threads.ts threadsReady) and until then shows no threads, no
--     question state and no Unanswered list; sends, the feed, search and
--     "Ask the team" work as before (the team gets the bell, no Support
--     ticket is made).
-- If 0101 is ever run again after this file, run this file again: 0101
-- re-creates the two functions above without the thread clause, and its
-- table-level revoke takes thread_root_id's grant away (0110's verify query
-- notices both).
--
-- Changes no existing data. Idempotent / safe to re-run. Assumes 0101 and
-- 0104; 0090 (support_tickets) for the help request's foreign key, which is
-- skipped where that table doesn't exist.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Replies: chat_messages.thread_root_id
-- ----------------------------------------------------------------------------
alter table public.chat_messages add column if not exists thread_root_id uuid;

-- The target of the same-channel foreign key: a message's id is unique on its
-- own, so (id, channel_id) is too — this only names it as a key.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.chat_messages'::regclass and conname = 'chat_messages_id_channel_id_key'
  ) then
    alter table public.chat_messages add constraint chat_messages_id_channel_id_key unique (id, channel_id);
  end if;
  -- A reply's root is a message IN THE REPLY'S CHANNEL. `cascade`: a root is
  -- only ever hard-deleted with its whole channel (a delete blanks a message
  -- in place), and its replies go with it then; they must never fall back
  -- into the main feed as orphans.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.chat_messages'::regclass and conname = 'chat_messages_thread_root_fkey'
  ) then
    alter table public.chat_messages
      add constraint chat_messages_thread_root_fkey
      foreign key (thread_root_id, channel_id) references public.chat_messages (id, channel_id) on delete cascade;
  end if;
end $$;

-- A thread's replies in posting order, a page at a time on (created_at, id)
-- (listThreadReplies). Partial: thread replies only.
create index if not exists chat_messages_thread_idx
  on public.chat_messages (thread_root_id, created_at, id)
  where thread_root_id is not null;

grant select (thread_root_id) on public.chat_messages to authenticated;

-- What a reply may hang off, checked on every write: a live person's message
-- (never a system line, never one that's deleted) that isn't a reply itself,
-- in a text channel. A reply never pings everyone, and never moves threads.
create or replace function public.chat_messages_thread_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  root record;
  channel_kind text;
begin
  if tg_op = 'UPDATE' then
    if new.thread_root_id is distinct from old.thread_root_id then
      raise exception 'A message can''t move into or out of a thread' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.thread_root_id is null then
    return new;
  end if;
  if new.thread_root_id = new.id then
    raise exception 'A message can''t reply to itself' using errcode = '23514';
  end if;
  select m.thread_root_id, m.kind, m.deleted_at into root
  from public.chat_messages m
  where m.id = new.thread_root_id and m.channel_id = new.channel_id;
  if not found then
    -- The foreign key says the same, but after this trigger: say it here.
    raise exception 'A thread reply''s root must be in the same channel' using errcode = '23503';
  end if;
  if root.thread_root_id is not null then
    raise exception 'Threads are one level: reply to the message that started the thread' using errcode = '23514';
  end if;
  if root.kind <> 'message' or root.deleted_at is not null then
    raise exception 'That message can''t take replies' using errcode = '23514';
  end if;
  select c.kind into channel_kind from public.chat_channels c where c.id = new.channel_id;
  if channel_kind is distinct from 'channel' then
    raise exception 'Threads are for text channels' using errcode = '23514';
  end if;
  if new.kind <> 'message' then
    raise exception 'A thread reply is a message' using errcode = '23514';
  end if;
  new.mention_everyone := false;
  return new;
end;
$$;

drop trigger if exists chat_messages_thread_guard on public.chat_messages;
create trigger chat_messages_thread_guard
  before insert or update of thread_root_id on public.chat_messages
  for each row execute procedure public.chat_messages_thread_guard();

-- ----------------------------------------------------------------------------
-- 2. Threads and questions
-- ----------------------------------------------------------------------------
create table if not exists public.chat_threads (
  root_id uuid primary key,
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  -- Live replies (not deleted), and when the newest one was posted.
  reply_count int not null default 0 check (reply_count >= 0),
  last_reply_at timestamptz,
  -- #help's questions: null = not a question; 'open'; 'answered'.
  question text check (question in ('open', 'answered')),
  -- The accepted answer: a live reply in this thread (chat_threads_check
  -- below). Not a foreign key on purpose: a reply is only ever hard-deleted
  -- with its whole channel, which takes this row too, and a key's `set null`
  -- would rewrite the question state without a word in the audit trail.
  answer_id uuid,
  -- Who made the last question change, and when (null by: the system, on a
  -- delete). The audit trigger copies it into chat_thread_events.
  question_changed_by uuid references public.profiles(id) on delete set null,
  question_changed_at timestamptz,
  -- "Ask the team": the one Support ticket for this thread (foreign key in
  -- the block below, where support_tickets exists). Owner and open/handled
  -- live on the ticket.
  help_ticket_id uuid,
  -- "Ask about this": the lesson or assignment a question is about. An id
  -- only; who may see its title is the item's own read rule (lib/chat-about.ts).
  about_kind text check (about_kind in ('lesson', 'assignment')),
  about_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_threads_about_pair check ((about_kind is null) = (about_id is null)),
  constraint chat_threads_answer_needs_answered check (answer_id is null or question = 'answered'),
  -- The thread's channel is its root's channel.
  constraint chat_threads_root_fkey foreign key (root_id, channel_id)
    references public.chat_messages (id, channel_id) on delete cascade
);

do $$
begin
  if to_regclass('public.support_tickets') is not null and not exists (
    select 1 from pg_constraint
    where conrelid = 'public.chat_threads'::regclass and conname = 'chat_threads_help_ticket_id_fkey'
  ) then
    alter table public.chat_threads
      add constraint chat_threads_help_ticket_id_fkey
      foreign key (help_ticket_id) references public.support_tickets(id) on delete set null;
  end if;
end $$;

-- One ticket is one thread's request. (One thread holds one ticket: it's a column.)
create unique index if not exists chat_threads_help_ticket_idx
  on public.chat_threads (help_ticket_id) where help_ticket_id is not null;
-- #help's Unanswered list and the Overview's count: a channel's open questions.
create index if not exists chat_threads_open_questions_idx
  on public.chat_threads (channel_id, created_at) where question = 'open';

drop trigger if exists touch_chat_threads on public.chat_threads;
create trigger touch_chat_threads before update on public.chat_threads
  for each row execute procedure public.touch_updated_at();

-- An accepted answer belongs to its thread and is still there; a question is
-- a live message. Checked on every write, whoever makes it.
create or replace function public.chat_threads_check()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  m record;
begin
  if new.answer_id is not null and (tg_op = 'INSERT' or new.answer_id is distinct from old.answer_id) then
    select x.thread_root_id, x.kind, x.deleted_at into m from public.chat_messages x where x.id = new.answer_id;
    if not found or m.thread_root_id is distinct from new.root_id or m.kind <> 'message' or m.deleted_at is not null then
      raise exception 'An accepted answer must be a reply in that thread' using errcode = '23514';
    end if;
  end if;
  if new.question is not null and (tg_op = 'INSERT' or old.question is null) then
    select x.thread_root_id, x.kind, x.deleted_at into m from public.chat_messages x where x.id = new.root_id;
    if not found or m.thread_root_id is not null or m.kind <> 'message' or m.deleted_at is not null then
      raise exception 'Only a message that''s still there can be a question' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists chat_threads_check on public.chat_threads;
create trigger chat_threads_check
  before insert or update of answer_id, question on public.chat_threads
  for each row execute procedure public.chat_threads_check();

-- ----------------------------------------------------------------------------
-- 3. The question audit trail
-- ----------------------------------------------------------------------------
create table if not exists public.chat_thread_events (
  id uuid primary key default gen_random_uuid(),
  -- The order things happened in, exactly: two changes can share a timestamp.
  seq bigint generated always as identity,
  root_id uuid not null references public.chat_messages(id) on delete cascade,
  -- Null: the system did it (an answer or the question was deleted).
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null check (action in
    ('asked', 'accepted', 'marked_answered', 'reopened', 'unmarked', 'answer_removed', 'question_removed')),
  from_state text,
  to_state text,
  -- The answer the change was about. Not a foreign key: the record outlives it.
  answer_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists chat_thread_events_root_idx on public.chat_thread_events (root_id, seq);
create index if not exists chat_thread_events_actor_idx on public.chat_thread_events (actor_id) where actor_id is not null;

-- Append-only. The one update allowed is the one the actor foreign key makes
-- when that account is deleted (the 0106 consent-log rule).
create or replace function public.chat_thread_events_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.actor_id is null
     and (new.id, new.seq, new.root_id, new.action, new.from_state, new.to_state, new.answer_id, new.created_at)
         is not distinct from (old.id, old.seq, old.root_id, old.action, old.from_state, old.to_state, old.answer_id, old.created_at) then
    return new;
  end if;
  raise exception 'chat_thread_events is append-only' using errcode = '42501';
end;
$$;

drop trigger if exists chat_thread_events_no_update on public.chat_thread_events;
create trigger chat_thread_events_no_update
  before update on public.chat_thread_events
  for each row execute procedure public.chat_thread_events_append_only();

-- Every question change, logged in the same transaction as the change.
create or replace function public.chat_threads_log_question()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  act text;
begin
  if tg_op = 'INSERT' then
    if new.question is null then
      return null;
    end if;
    act := 'asked';
  else
    if new.question is not distinct from old.question and new.answer_id is not distinct from old.answer_id then
      return null;
    end if;
    act := case
      when new.question is null then case when new.question_changed_by is null then 'question_removed' else 'unmarked' end
      when old.question is null then 'asked'
      when new.question = 'answered' and new.answer_id is not null then 'accepted'
      when new.question = 'answered' then 'marked_answered'
      when new.question_changed_by is null and old.answer_id is not null then 'answer_removed'
      else 'reopened'
    end;
  end if;
  insert into public.chat_thread_events (root_id, actor_id, action, from_state, to_state, answer_id)
  values (
    new.root_id,
    new.question_changed_by,
    act,
    case when tg_op = 'UPDATE' then old.question end,
    new.question,
    coalesce(new.answer_id, case when tg_op = 'UPDATE' then old.answer_id end)
  );
  return null;
end;
$$;

drop trigger if exists chat_threads_log_question on public.chat_threads;
create trigger chat_threads_log_question
  after insert or update of question, answer_id on public.chat_threads
  for each row execute procedure public.chat_threads_log_question();

-- ----------------------------------------------------------------------------
-- 4. Follows
-- ----------------------------------------------------------------------------
create table if not exists public.chat_thread_follows (
  root_id uuid not null references public.chat_messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- null: no choice made (only a "had it open" stamp); 'following'; 'muted'
  -- (unfollowed on purpose, and replying again doesn't undo it).
  state text check (state in ('following', 'muted')),
  -- When they last had the thread open: a bell waits while it's recent.
  seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (root_id, user_id)
);
create index if not exists chat_thread_follows_user_idx on public.chat_thread_follows (user_id);
create index if not exists chat_thread_follows_following_idx
  on public.chat_thread_follows (root_id) where state = 'following';

drop trigger if exists touch_chat_thread_follows on public.chat_thread_follows;
create trigger touch_chat_thread_follows before update on public.chat_thread_follows
  for each row execute procedure public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 5. Keeping threads current, message by message
--
--   a reply comes in     the thread's count and last reply; the replier and
--                        the root's author follow (unless they unfollowed)
--   a reply is deleted   the count goes down; an accepted answer reopens
--                        its question, in the same transaction
--   a root is deleted    its question is retired
--   a #help post         from anyone but the team, top level and not a quote:
--                        an open question
--
-- Counted by adding and taking one under the thread row's lock, not by
-- counting again: a recount's snapshot can miss a reply committing beside it.
-- ----------------------------------------------------------------------------
create or replace function public.chat_messages_touch_thread()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  root_sender uuid;
begin
  if tg_op = 'INSERT' then
    if new.thread_root_id is not null then
      if new.deleted_at is not null then
        -- Carried in already deleted: the thread exists, the reply doesn't count.
        insert into public.chat_threads (root_id, channel_id) values (new.thread_root_id, new.channel_id)
        on conflict (root_id) do nothing;
        return null;
      end if;
      insert into public.chat_threads as t (root_id, channel_id, reply_count, last_reply_at)
      values (new.thread_root_id, new.channel_id, 1, new.created_at)
      on conflict (root_id) do update
        set reply_count = t.reply_count + 1,
            last_reply_at = greatest(t.last_reply_at, excluded.last_reply_at);
      select m.sender_id into root_sender from public.chat_messages m where m.id = new.thread_root_id;
      insert into public.chat_thread_follows as f (root_id, user_id, state)
      select new.thread_root_id, u, 'following'
      from (select distinct u from unnest(array[new.sender_id, root_sender]) as u) s
      where u is not null
      on conflict (root_id, user_id) do update set state = 'following' where f.state is null;
      return null;
    end if;
    if new.reply_to_id is null and new.kind = 'message' and new.sender_id is not null and new.deleted_at is null
       and exists (select 1 from public.chat_channels c where c.id = new.channel_id and c.system_key = 'help')
       and not public.chat_is_staff(new.sender_id) then
      insert into public.chat_threads (root_id, channel_id, question, question_changed_by, question_changed_at)
      values (new.id, new.channel_id, 'open', new.sender_id, new.created_at)
      on conflict (root_id) do nothing;
    end if;
    return null;
  end if;

  -- An update of deleted_at: a message deleted (blanked in place).
  if not (old.deleted_at is null and new.deleted_at is not null) then
    return null;
  end if;
  if new.thread_root_id is not null then
    update public.chat_threads t
    set reply_count = greatest(t.reply_count - 1, 0),
        last_reply_at = case
          when t.last_reply_at is not null and new.created_at >= t.last_reply_at then (
            select max(m.created_at) from public.chat_messages m
            where m.thread_root_id = new.thread_root_id and m.deleted_at is null)
          else t.last_reply_at
        end
    where t.root_id = new.thread_root_id;
    -- The accepted answer is gone: the question is open again, by nobody.
    update public.chat_threads t
    set question = 'open', answer_id = null, question_changed_by = null, question_changed_at = now()
    where t.root_id = new.thread_root_id and t.answer_id = new.id;
  else
    -- The question itself is gone: it's no longer waiting on anyone.
    update public.chat_threads t
    set question = null, answer_id = null, question_changed_by = null, question_changed_at = now()
    where t.root_id = new.id and t.question is not null;
  end if;
  return null;
end;
$$;

drop trigger if exists chat_messages_touch_thread on public.chat_messages;
create trigger chat_messages_touch_thread
  after insert or update of deleted_at on public.chat_messages
  for each row execute procedure public.chat_messages_touch_thread();

-- ----------------------------------------------------------------------------
-- 6. Thread replies aren't channel messages: 0101's channel summary and
--    unread counts, each with "and not a thread reply" added. Otherwise the
--    same functions, so 0101 §4 and §7 still describe them.
-- ----------------------------------------------------------------------------
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
  -- A thread reply (0110) is the thread's, not the channel's: it moves no
  -- summary, count or cursor. thread_root_id never changes (the guard).
  if coalesce(new.thread_root_id, old.thread_root_id) is not null then
    return null;
  end if;
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
    where m.channel_id = cid and m.deleted_at is null and m.thread_root_id is null
      and public.chat_counts_as_message(m.kind, key)
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
         and m.thread_root_id is null
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
         and m.thread_root_id is null
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

revoke execute on function public.chat_unread(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.chat_unread(uuid, uuid[]) to service_role;

-- A thread bell (chat_thread) never carries the words either.
create or replace function public.dm_notification_strip_body()
returns trigger
language plpgsql
as $$
begin
  if new.type in ('direct_message', 'dm_reported', 'chat_dm', 'chat_mention', 'chat_message', 'chat_reported', 'chat_thread') then
    new.body := null;
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. Service role only
-- ----------------------------------------------------------------------------
alter table public.chat_threads enable row level security;
alter table public.chat_thread_events enable row level security;
alter table public.chat_thread_follows enable row level security;
revoke all on public.chat_threads from anon, authenticated;
revoke all on public.chat_thread_events from anon, authenticated;
revoke all on public.chat_thread_follows from anon, authenticated;
grant select, insert, update, delete on public.chat_threads to service_role;
grant select, insert on public.chat_thread_events to service_role;
grant select, insert, update, delete on public.chat_thread_follows to service_role;

do $$
declare
  p record;
begin
  for p in
    select tablename, policyname from pg_policies
    where schemaname = 'public' and tablename in ('chat_threads', 'chat_thread_events', 'chat_thread_follows')
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

revoke execute on function public.chat_messages_thread_guard() from public, anon, authenticated;
revoke execute on function public.chat_threads_check() from public, anon, authenticated;
revoke execute on function public.chat_threads_log_question() from public, anon, authenticated;
revoke execute on function public.chat_messages_touch_thread() from public, anon, authenticated;
revoke execute on function public.chat_thread_events_append_only() from public, anon, authenticated;

notify pgrst, 'reload schema';
