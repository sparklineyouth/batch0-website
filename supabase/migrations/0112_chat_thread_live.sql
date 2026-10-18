-- ============================================================================
-- 0112 — batch0 Chat: a thread's question and help request change live.
--
-- Since 0110, a #help question being accepted, marked answered, reopened or
-- unmarked, and the thread's help request being filed, picked up or worked
-- in Support, reached other open screens only on their 30-second resync:
-- Realtime carries chat_messages, and those changes are rows in chat_threads
-- and support_tickets, which it doesn't.
--
-- This file doesn't put either table on Realtime. chat_threads is service
-- role only (0110 §7) and holds what no reader may see: the Support ticket's
-- id, and the course item a question links to, whose very existence is
-- shown only to people who can open it (lib/chat-about.ts). Publishing it
-- would mean a new read policy and new column grants on it, and a second
-- subscription per open channel that errors out wherever this file hasn't
-- run yet. Instead the change rides the subscription every open channel
-- already has:
--
--   * `chat_messages.thread_changed_at`: when the thread hanging off this
--     message last changed in a way its readers see (its question's state,
--     its accepted answer, its help request's state or owner). A trigger
--     sets it on the root; Realtime sends readers of the channel that root's
--     UPDATE, under 0101's read policy, exactly as it sends an edit. A
--     timestamp and nothing else: what changed, the client reads again
--     through the GET routes, which check the channel and the root and
--     resolve the course item per viewer, as before.
--   * Not for a reply's count (each reply's own INSERT already arrives), and
--     never for the course item: a stamp right after a post would tell
--     everyone in #help that it links something.
--   * Skipped when another transaction holds the root's row (an edit, a
--     reaction, its delete): stamping takes the row lock after the thread
--     row's, the reverse of a delete's order, so waiting could deadlock.
--     The other write sends its own UPDATE, and the 30-second resync still
--     catches the change.
--
-- Deploy order. Either way works:
--   * this file first: the code still running ignores a column it doesn't
--     know (its Realtime handler copies known fields only), so a root's
--     UPDATE changes nothing on its screens;
--   * the code first: no row carries the column, so the client never
--     refetches on it, and screens catch up on the 30-second resync as they
--     do today.
-- If 0101 is ever run again, run this file after 0104 and 0110: 0101's
-- table-level revoke on chat_messages takes this column's grant away (the
-- verify query notices).
--
-- Changes no existing data. Idempotent / safe to re-run. Assumes 0101 and
-- 0110; 0090 (support_tickets) for the help request's trigger, which is
-- skipped where that table doesn't exist.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The stamp, readable by the channel's readers (Realtime sends only the
--    columns a subscriber may select).
-- ----------------------------------------------------------------------------
alter table public.chat_messages add column if not exists thread_changed_at timestamptz;

comment on column public.chat_messages.thread_changed_at is
  'When the thread on this message last changed in a way readers see: its question, accepted answer or help request (0112). A hint for live screens to read the thread again; never the change itself.';

grant select (thread_changed_at) on public.chat_messages to authenticated;

-- ----------------------------------------------------------------------------
-- 2. Stamping a root: a live feed message only, and never waiting on a row
--    another transaction is writing.
-- ----------------------------------------------------------------------------
create or replace function public.chat_stamp_thread_root(p_root uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.chat_messages m
  set thread_changed_at = now()
  where m.id = (
    select x.id from public.chat_messages x
    where x.id = p_root and x.deleted_at is null and x.thread_root_id is null
    for no key update skip locked
  );
end;
$$;

-- A question's state or answer, or the help request linked or unlinked.
create or replace function public.chat_threads_stamp_root()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if (new.question, new.answer_id, new.help_ticket_id) is distinct from (old.question, old.answer_id, old.help_ticket_id) then
    perform public.chat_stamp_thread_root(new.root_id);
  end if;
  return null;
end;
$$;

drop trigger if exists chat_threads_stamp_root on public.chat_threads;
create trigger chat_threads_stamp_root
  after update of question, answer_id, help_ticket_id on public.chat_threads
  for each row execute procedure public.chat_threads_stamp_root();

-- The help request worked in Support: what the thread shows of it is the
-- ticket's state and owner (lib/chat-threads.ts helpInfoFor).
create or replace function public.support_tickets_stamp_thread()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  r uuid;
begin
  if (new.status, new.assigned_to) is distinct from (old.status, old.assigned_to) then
    select t.root_id into r from public.chat_threads t where t.help_ticket_id = new.id;
    if found then
      perform public.chat_stamp_thread_root(r);
    end if;
  end if;
  return null;
end;
$$;

do $$
begin
  if to_regclass('public.support_tickets') is not null then
    drop trigger if exists support_tickets_stamp_thread on public.support_tickets;
    create trigger support_tickets_stamp_thread
      after update of status, assigned_to on public.support_tickets
      for each row execute procedure public.support_tickets_stamp_thread();
  end if;
end $$;

revoke execute on function public.chat_stamp_thread_root(uuid) from public, anon, authenticated;
revoke execute on function public.chat_threads_stamp_root() from public, anon, authenticated;
revoke execute on function public.support_tickets_stamp_thread() from public, anon, authenticated;

notify pgrst, 'reload schema';
