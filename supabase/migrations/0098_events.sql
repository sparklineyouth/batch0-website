-- ============================================================================
-- 0098 — Events: writes need events.manage; new events start with chat and
-- recording on.
--
-- 1. `events staff write` (0005) allowed anyone holding mentor.panel to insert,
--    update and delete events directly over PostgREST — flip an event public,
--    turn on auto-share, delete Demo Day. The app writes events only through
--    service-role server actions that check events.manage
--    (app/admin/events/actions.ts, the live room's End/Reopen), so the policy
--    now asks for the same permission.
-- 2. New rows default to audience_mode 'open' (chat on, hosts can remove
--    messages) and auto_record true. Existing rows keep what they have.
--
-- Idempotent, nothing dropped. Safe to re-run.
-- ============================================================================

drop policy if exists "events staff write" on public.events;
create policy "events staff write" on public.events
  for all
  using (public.has_permission(auth.uid(), 'events.manage'))
  with check (public.has_permission(auth.uid(), 'events.manage'));

alter table public.events alter column audience_mode set default 'open';
alter table public.events alter column auto_record set default true;

comment on column public.events.audience_mode is
  'Chat for the audience: open (default since 0098), moderated, or private (off).';
