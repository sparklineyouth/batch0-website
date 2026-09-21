-- ============================================================================
-- 0073 — batch0 Live: the built-in webinar provider.
--
-- Why this exists
-- ---------------
-- Hosted webinars (0058) ran on Daily. The REST integration is fine — rooms
-- create, tokens mint, every claim decodes correctly — but the Daily account
-- cannot start a media session at all: every join, including one into a bare
-- public room with no properties set, is refused with
-- `account-missing-payment-method`. That is an account-level block, so no
-- change in this repo can clear it. `scripts/daily-doctor.mts` passed the
-- whole time because it only ever exercised the REST plane; the media plane
-- was dead. `scripts/webinar-e2e.mts` is the check that actually catches it.
--
-- So webinars now run on infrastructure we already own. A webinar is one host
-- broadcasting to N viewers, and that is a *star*, not a mesh: the host holds
-- one send-only WebRTC connection per viewer, each viewer holds one
-- receive-only connection back. Media goes browser-to-browser and never
-- touches our servers. All we have to provide is signalling — which is what
-- Supabase Realtime already does, at ~100ms round trip, with no new vendor,
-- no new account, and no new environment variable.
--
-- What this table is for
-- ----------------------
-- Signalling is ephemeral and lives in Realtime channels; it is not stored
-- here. This table answers the two questions the channels cannot:
--
--   1. Discovery — a host arriving needs to know which viewers are already
--      waiting, and a viewer arriving needs the host to find out. Both sides
--      reconcile against these rows.
--   2. Attendance — who actually watched, and for how long. With Daily that
--      record lived in a third party; here it is a row we own, which for a
--      program with minors is the side we want it on.
--
-- The audience-privacy rule is the same one 0058/0060 established, and it is
-- enforced harder here than Daily could: a viewer is never *told* another
-- viewer exists. Peer disclosure is role-aware server-side (lib/live-rooms.ts
-- gives a viewer only the hosts), the per-pair signalling channel names are
-- HMACs a viewer cannot derive for a pair it isn't in, and the RLS below
-- refuses a viewer any row but their own. A viewer's browser therefore holds
-- exactly one connection — to the host — and has no channel on which another
-- viewer could become visible.
--
-- Unlike Daily's `hasPresence: false`, this DOES let the host see the
-- audience: with Daily the viewers were hidden from the host too, so nobody
-- could tell whether anyone was watching. Hosts see a count and a list;
-- viewers see nothing. That is the split we actually wanted.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0072 are applied.
-- ============================================================================

create table if not exists public.live_participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- 'host' broadcasts (camera, mic, screen); 'viewer' only receives. Derived
  -- server-side from the `events.manage` permission, never from the client —
  -- the same derivation the Daily path used for `is_owner`.
  role text not null default 'viewer' check (role in ('host', 'viewer')),
  -- Denormalised so the host's audience list is one query with no join, and
  -- so a viewer who deletes their profile still reads sensibly in attendance.
  display_name text,
  joined_at timestamptz not null default now(),
  -- Bumped by a heartbeat every ~15s. A row whose last_seen_at has gone
  -- stale is treated as gone even if `left_at` was never set, because the
  -- common way to leave a call is to close the laptop, not to click Leave.
  last_seen_at timestamptz not null default now(),
  left_at timestamptz,
  created_at timestamptz not null default now()
);

-- One row per person per event: rejoining (a reload, a dropped connection,
-- a second tab) updates the existing row rather than forking attendance into
-- several partial rows.
create unique index if not exists live_participants_unique
  on public.live_participants (event_id, user_id);

-- The host's reconcile loop: "who is in this event and currently alive".
create index if not exists live_participants_live_idx
  on public.live_participants (event_id, last_seen_at desc);

alter table public.live_participants enable row level security;

-- ----------------------------------------------------------------------------
-- RLS
--
-- Every write goes through the server actions in lib/live-rooms.ts under the
-- service role, so there is deliberately NO insert/update/delete policy here:
-- the anon-key browser client (lib/supabase/client.ts) carries the student's
-- JWT and could otherwise write straight to this table, and a viewer able to
-- insert their own row with role='host' would be a viewer who can broadcast.
-- No policy means no client write, which is the whole intent.
-- ----------------------------------------------------------------------------

-- Read: the host sees the room (events.manage), an admin sees everything, and
-- a viewer sees only their own row. There is deliberately no path for a viewer
-- to read another participant — that is the audience privacy this provider is
-- built around, and it is the same shape as the `webinar_questions read`
-- policy in 0060.
drop policy if exists "live_participants read" on public.live_participants;
create policy "live_participants read" on public.live_participants
  for select using (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'events.manage')
    or user_id = auth.uid()
  );

comment on table public.live_participants is
  'Who is in a batch0 Live room right now, and who attended. Hosts see the whole audience; a viewer sees only their own row, so the audience stays hidden from itself.';

-- ----------------------------------------------------------------------------
-- Stale Daily rooms (the second, separate bug)
--
-- 0069 moved every webinar onto a Sunday but left the Daily rooms stamped
-- with their old `exp`, so 17 of 18 webinars pointed at a room that expires
-- BEFORE the webinar starts and one pointed at a room Daily had already
-- reaped. The join page healed that at join time, which meant the repair ran
-- on the critical path with an audience waiting.
--
-- Clearing the room name here retires those dead references. It is safe
-- whichever provider is active: the built-in provider ignores these columns
-- entirely (the event id *is* the room), and the Daily path treats a null
-- room name as "create one", which is exactly what should happen for a room
-- that no longer exists.
-- ----------------------------------------------------------------------------
update public.events
   set daily_room_name = null,
       daily_room_url = null
 where live_mode = 'hosted'
   and daily_room_name is not null;
