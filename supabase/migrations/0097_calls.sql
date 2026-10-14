-- ============================================================================
-- 0097 — 1:1 calls: clients read, only the server writes.
--
-- Every write to these tables goes through a service-role server action
-- (app/calls/*, the call-lifecycle cron), which re-checks who may do what.
-- The client write policies were unused attack surface: with their own JWT a
-- student could PATCH their call over PostgREST (status, starts_at, host_id —
-- repointing host_id made someone else "staff on the call"), rewrite their
-- 1:1 request, or a booking's recap. This drops every INSERT/UPDATE/DELETE
-- policy and the table write privileges for the API roles. SELECT policies
-- stay as they are.
--
-- Office hours (mentor_slots / mentor_bookings) are retired from the app;
-- their rows stay as history, readable by admins and the people on them.
-- mentor_slots' read policy exposed every slot's zoom_url to any signed-in
-- user; it is narrowed to admins and the owning mentor. (Not to the booking
-- student: mentor_bookings' read policy already reads mentor_slots, and a
-- policy reading back would recurse.)
--
-- Old notifications that link to the removed office-hours pages point at
-- 1:1 calls instead.
--
-- Idempotent; safe to re-run. Nothing is dropped but policies and grants.
-- ============================================================================

-- call_invites ---------------------------------------------------------------
drop policy if exists "call_invites host insert" on public.call_invites;
drop policy if exists "call_invites update" on public.call_invites;
drop policy if exists "call_invites host delete" on public.call_invites;
revoke insert, update, delete on public.call_invites from anon, authenticated;

comment on table public.call_invites is
  '1:1 calls: one student and a staff side (host + call_invite_cohosts). No accept step: invited is joinable. Written only by service-role server actions.';

-- call_invite_cohosts (0092 gave it a read policy only) -------------------------
revoke insert, update, delete on public.call_invite_cohosts from anon, authenticated;

-- interview_requests ("Request a 1:1") ---------------------------------------
drop policy if exists "interview_requests student insert" on public.interview_requests;
drop policy if exists "interview_requests update" on public.interview_requests;
revoke insert, update, delete on public.interview_requests from anon, authenticated;

comment on table public.interview_requests is
  'A student''s "Request a 1:1" ask; the team books it into a call_invites row. Written only by service-role server actions.';

-- mentor_bookings / mentor_slots (office hours, retired) -----------------------
drop policy if exists "mentor_bookings student write" on public.mentor_bookings;
drop policy if exists "mentor_bookings update" on public.mentor_bookings;
revoke insert, update, delete on public.mentor_bookings from anon, authenticated;

drop policy if exists "mentor_slots mentor write" on public.mentor_slots;
drop policy if exists "mentor_slots admin write" on public.mentor_slots;
revoke insert, update, delete on public.mentor_slots from anon, authenticated;

drop policy if exists "mentor_slots read" on public.mentor_slots;
create policy "mentor_slots read" on public.mentor_slots
  for select using (
    public.is_admin(auth.uid()) or mentor_id = auth.uid()
  );

-- Links into the removed pages -------------------------------------------------
update public.notifications
   set link = '/dashboard/calls'
 where link like '/dashboard/office-hours%';
update public.notifications
   set link = '/mentor/calls'
 where link like '/mentor/office-hours%';

notify pgrst, 'reload schema';
