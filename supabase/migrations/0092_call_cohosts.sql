-- ============================================================================
-- 0092 — Co-hosts on 1:1 calls.
--
-- A "1:1" (call_invites, 0059) was literally two people: one host, one
-- student. In practice a student is often met by a panel — an admin bringing
-- in a mentor, an investor and a partner together, or the team confirming a
-- scholarship call and putting the mentor on it — so a call now has one
-- student and ANY number of staff on the other side.
--
-- The student side stays exactly one. That is the part of "1:1" that matters:
-- a private conversation about one student, not a group session. The staff
-- side grows through a join table rather than an array column so each co-host
-- is a real foreign key (a deleted profile drops out of the call instead of
-- leaving a dangling id) and so "which calls am I on" is an indexed lookup.
--
-- `call_invites.host_id` keeps its meaning: the person who sent the invite.
-- Co-hosts are everyone else on the staff side. On their call they can do
-- what the host can — read and join it, end it for everyone, cancel it, watch
-- the recording — and the app treats host and co-hosts alike as "the staff on
-- the call". Deleting the invite stays with the host and admins, as in 0059.
--
-- Writes go through service-role server actions only (createInvite,
-- scheduleInterviewRequest), after they have checked that each co-host's role
-- holds calls.invite — the capability every staff calls page requires, so a
-- co-host can always find the call. So this table has a READ policy and no
-- insert/update/delete policy at all: RLS denies writes to everyone else by
-- default, and a write policy would let a signed-in user add themselves to
-- somebody else's call over PostgREST.
--
-- ----------------------------------------------------------------------------
-- No recursion between the two tables' policies
-- ----------------------------------------------------------------------------
--
-- call_invites' policies now ask "is the caller a co-host of this call", and
-- call_invite_cohosts' read policy asks "is the caller on this call" — which
-- reads call_invites. Written as plain subqueries, each table's policy would
-- evaluate the other table's policy, and Postgres refuses that with "infinite
-- recursion detected in policy". Both questions are therefore asked through
-- SECURITY DEFINER functions, which read the tables as their owner (RLS does
-- not apply to a table's owner) and so never re-enter a policy.
--
-- Both functions read the caller from auth.uid() themselves rather than taking
-- a user id, following 0089's dm_can_read_conversation: a policy predicate is
-- callable by any signed-in user over /rest/v1/rpc, and one that took a uid
-- would answer "is THIS person on THAT call" about anyone. (An earlier draft
-- of this file, numbered 0087, had exactly that two-argument
-- is_call_participant(uuid, uuid). `create or replace` with a different
-- signature adds an overload rather than replacing it, so it is dropped
-- below, after the policies stop using it — a no-op where the draft never
-- ran.)
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0091 are applied (0091 is notification_importance).
-- ============================================================================

create table if not exists public.call_invite_cohosts (
  invite_id uuid not null references public.call_invites(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (invite_id, profile_id)
);

-- The primary key already serves "who is on this call" (invite_id first);
-- this serves "which calls am I on", the co-host's own calls list.
create index if not exists call_invite_cohosts_profile_idx
  on public.call_invite_cohosts (profile_id);

alter table public.call_invite_cohosts enable row level security;

-- ----------------------------------------------------------------------------
-- Predicates
-- ----------------------------------------------------------------------------

-- Is the signed-in user a co-host of this call? Reads only the join table.
create or replace function public.is_call_cohost(p_invite uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.call_invite_cohosts cc
    where cc.invite_id = p_invite and cc.profile_id = auth.uid()
  );
$$;

-- Is the signed-in user on this call at all — its host, its student, or a
-- co-host?
create or replace function public.is_call_participant(p_invite uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.call_invites ci
    where ci.id = p_invite
      and (ci.host_id = auth.uid() or ci.invitee_id = auth.uid())
  ) or public.is_call_cohost(p_invite);
$$;

-- ----------------------------------------------------------------------------
-- call_invite_cohosts: read only
--
-- Admins see every row, for the same safeguarding reason they see every
-- call_invites row (0059): someone must be able to answer "who has been
-- meeting my students". Everyone on a call sees who else is on it — the
-- student included, because they should know who will be in the room.
-- ----------------------------------------------------------------------------

drop policy if exists "call_invite_cohosts read" on public.call_invite_cohosts;
create policy "call_invite_cohosts read" on public.call_invite_cohosts
  for select using (
    public.is_admin(auth.uid())
    or public.is_call_participant(call_invite_cohosts.invite_id)
  );

-- ----------------------------------------------------------------------------
-- call_invites: 0059's read and update policies, plus the co-host clause
--
-- 0059 is the only migration that defines these two (nothing since has
-- touched call_invites' policies), so each is 0059's exact predicate with one
-- `or` added. Insert and delete are unchanged: only the host writes an invite
-- as themselves, and only the host or an admin deletes one.
-- ----------------------------------------------------------------------------

drop policy if exists "call_invites read" on public.call_invites;
create policy "call_invites read" on public.call_invites
  for select using (
    public.is_admin(auth.uid())
    or call_invites.host_id = auth.uid()
    or call_invites.invitee_id = auth.uid()
    or public.is_call_cohost(call_invites.id)
  );

-- As in 0059 this is the outer boundary, not the rule: which columns each
-- person may change (the student only answers; staff cancel) is enforced in
-- the server actions, and every write the app makes goes through them on the
-- service role anyway.
drop policy if exists "call_invites update" on public.call_invites;
create policy "call_invites update" on public.call_invites
  for update using (
    public.is_admin(auth.uid())
    or call_invites.host_id = auth.uid()
    or call_invites.invitee_id = auth.uid()
    or public.is_call_cohost(call_invites.id)
  ) with check (
    public.is_admin(auth.uid())
    or call_invites.host_id = auth.uid()
    or call_invites.invitee_id = auth.uid()
    or public.is_call_cohost(call_invites.id)
  );

-- ----------------------------------------------------------------------------
-- The earlier draft's uid-taking predicate
--
-- Only exists where that draft was pasted in. Its read policy has just been
-- replaced above, so nothing depends on it any more; left in place it would
-- stay executable by anon and authenticated (Supabase's default grants) and
-- answer "is this person on that call" about anyone.
-- ----------------------------------------------------------------------------

drop function if exists public.is_call_participant(uuid, uuid);

comment on table public.call_invite_cohosts is
  'Additional staff (anyone whose role holds calls.invite) on a call_invites row. The student side is always the single invitee; host_id is whoever sent the invite.';

-- So PostgREST sees the new table — and the call_invites → call_invite_cohosts
-- relationship the calls lists embed — without waiting for its next reload.
notify pgrst, 'reload schema';
