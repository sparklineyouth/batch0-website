-- ============================================================================
-- 0098 — Events: writes need events.manage; "everyone" means everyone signed
-- in; new events start with chat and recording on.
--
-- 1. `events staff write` (0005) allowed anyone holding mentor.panel to insert,
--    update and delete events directly over PostgREST — flip an event public,
--    turn on auto-share, delete Demo Day. The app writes events only through
--    service-role server actions that check events.manage
--    (app/admin/events/actions.ts, the live room's End/Reopen), so the policy
--    now asks for the same permission.
-- 2. `events read` let the anon key (shipped in every browser bundle) list
--    every visibility='public' event with its description and external join
--    link. The admin form calls that option "Everyone signed in", so the
--    public clause now needs a signed-in caller. Every other clause is 0084's,
--    unchanged. The marketing timetable reads with the service role.
-- 3. New rows default to audience_mode 'open' (chat on, hosts can remove
--    messages) and auto_record true. Existing rows keep what they have.
--
-- Idempotent, nothing dropped. Safe to re-run.
-- ============================================================================

drop policy if exists "events staff write" on public.events;
create policy "events staff write" on public.events
  for all
  using (public.has_permission(auth.uid(), 'events.manage'))
  with check (public.has_permission(auth.uid(), 'events.manage'));

drop policy if exists "events read" on public.events;
create policy "events read" on public.events
  for select using (
    (visibility = 'public' and auth.uid() is not null)
    or public.is_staff(auth.uid())
    or (
      visibility = 'enrolled'
      and exists (
        select 1 from public.enrollments e
        where e.user_id = auth.uid() and e.cohort_id = events.cohort_id
      )
    )
    or (
      events.type = 'demo_day'
      and visibility = 'enrolled'
      and exists (
        select 1 from public.demo_day_tickets t
        where t.user_id = auth.uid()
          and t.status = 'paid'
          and (t.cohort_id is null or t.cohort_id = events.cohort_id)
      )
    )
    or public.is_event_speaker(auth.uid(), events.id)
  );

alter table public.events alter column audience_mode set default 'open';
alter table public.events alter column auto_record set default true;

comment on column public.events.audience_mode is
  'Chat for the audience: open (default since 0098), moderated, or private (off).';
