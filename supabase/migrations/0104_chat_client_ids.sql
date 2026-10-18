-- ============================================================================
-- 0104 — batch0 Chat: a message is sent once, however many times it's retried;
--        and a deleted channel message is quick to find for a report.
--
-- A send whose answer was lost — the row committed, then the phone dropped
-- off the network before the reply came back — left a failed bubble with a
-- Retry button beside the message that had gone through, and Retry posted the
-- same words a second time. The screen had nothing to tell the two apart by,
-- and neither had the server.
--
-- Now the composer gives every message an id of its own when it's written
-- (`client_id`, a random uuid), and every Retry of that message sends the same
-- id again. `unique (sender_id, client_id)` makes a second row impossible: a
-- resend gets the ORIGINAL row back (sendMessage in app/chat/actions.ts,
-- lib/chat-send.ts), and the sending screen recognises the server's copy, or
-- its Realtime echo, as the bubble it already shows, by that id. Two messages
-- someone means to send — even word for word the same — have two ids, and
-- stay two messages.
--
-- Scoped to the author: the unique key is the pair, and the server only ever
-- looks up the signed-in sender's own ids, so nobody can claim, or block, an
-- id of someone else's. NULLs are distinct in a unique constraint, so every
-- row from before this file, every system line and every post made from
-- elsewhere (announcements, the #staff feed) has no client id and never
-- collides. A plain constraint rather than a partial index so an
-- `on conflict (sender_id, client_id)` can always find it (0102's lesson).
--
-- Readers may select the column: Realtime sends only the columns a
-- subscriber may select (0101 §8), and the sending screen matches its echo by
-- it. It's a random id the sender's browser made up; it says nothing about
-- anyone.
--
-- Also an index for "Report a deleted message" (listDeletedForReport in
-- lib/chat.ts): a text channel's messages deleted in the last two weeks, most
-- recently deleted first, a page at a time on (deleted_at, id). Partial, so it
-- holds deleted rows only — a sliver of the table — and the list never reads
-- through a channel's whole history to find them. Before it exists the list
-- still works, just less directly.
--
-- The code deploys first and works without this file: a send goes in without
-- a client id (as before) and nothing is replayed (lib/chat-send.ts checks
-- for the column once a minute). If 0101 is ever run again after this file,
-- run this one again too: 0101 re-grants the message columns it knows by name,
-- and a table-level revoke takes this column's grant with it.
--
-- Changes no data. Idempotent / safe to re-run. Assumes 0101.
-- ============================================================================

alter table public.chat_messages add column if not exists client_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.chat_messages'::regclass
      and conname = 'chat_messages_sender_id_client_id_key'
  ) then
    alter table public.chat_messages
      add constraint chat_messages_sender_id_client_id_key unique (sender_id, client_id);
  end if;
end $$;

grant select (client_id) on public.chat_messages to authenticated;

create index if not exists chat_messages_channel_deleted_idx
  on public.chat_messages (channel_id, deleted_at desc, id desc)
  where deleted_at is not null;

notify pgrst, 'reload schema';
