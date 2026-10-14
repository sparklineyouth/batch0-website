-- ============================================================================
-- 0095 — Recordings: one continuous file per take.
--
-- A webinar or 1:1 used to be recorded as self-contained two-minute segment
-- files (event_assets kind='recording' in webinar-media; bare files in the
-- call-recordings bucket), chosen by a client-side election between hosts.
-- Now one browser holds a server LEASE on the room (a row here with status
-- 'recording'), runs ONE MediaRecorder for the whole take, and uploads its
-- byte stream in order as numbered parts. Played back, the parts are one file:
-- /api/recordings/<id>/media serves them as a single seekable stream.
--
--   recording_sessions   one row per take. The partial unique index is the
--                        lease: one 'recording' row per room. heartbeat_at is
--                        bumped by every part the recorder uploads; a row
--                        whose heartbeat is ~45s stale is swept to
--                        'interrupted' and finalized from what reached storage.
--   recording_mint_part  the recorder's per-part bookkeeping, one statement
--                        (service role only).
--   recordings (bucket)  private, no storage.objects policies: only the
--                        service role reads or writes it, after the route
--                        handlers have checked the room.
--
-- Old segment recordings are untouched and stay playable (legacy player).
--
-- RLS: read-only, for the people who may watch — staff with events.manage for
-- webinars; the people on the call (and admins) for 1:1s, through a SECURITY
-- DEFINER predicate that reads auth.uid() itself. Writes go through the
-- service role only.
--
-- Idempotent / safe to re-run. Assumes 0001..0094 are applied (0092 provides
-- is_call_participant).
-- ============================================================================

create table if not exists public.recording_sessions (
  id uuid primary key default gen_random_uuid(),
  room_kind text not null check (room_kind in ('webinar', 'call')),
  -- events.id for a webinar, call_invites.id for a call. No foreign key: one
  -- column serves both, and a recording outlives an edit of its room.
  room_id uuid not null,
  status text not null default 'recording'
    check (status in ('recording', 'finished', 'interrupted', 'failed')),
  started_by uuid references public.profiles(id) on delete set null,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  ended_at timestamptz,
  -- Set once the manifest below matches what is in storage.
  finalized_at timestamptz,
  mime text not null,
  -- Parts minted so far; after finalize, the contiguous parts in storage.
  part_count integer not null default 0 check (part_count >= 0),
  -- Byte size of each part, in order (after finalize: from storage).
  part_sizes jsonb not null default '[]'::jsonb,
  -- Recorded time (ms) at the end of each part, as the recorder reported it:
  -- an interrupted take's Duration is the end of its last part that landed.
  part_end_ms jsonb not null default '[]'::jsonb,
  -- Size of the stitched file as served (head + parts).
  total_bytes bigint not null default 0 check (total_bytes >= 0),
  -- WebM only: the rewritten head (Duration + Cues) and how many leading
  -- bytes of part 0 it replaces. Null: the parts are served as they are.
  head_bytes integer check (head_bytes is null or head_bytes > 0),
  head_replaces integer check (head_replaces is null or head_replaces >= 0),
  duration_ms bigint not null default 0 check (duration_ms >= 0),
  -- [[byteOffset, timeMs], ...] of video keyframe clusters, reported by the
  -- recorder as it goes; becomes the file's Cues.
  cues jsonb not null default '[]'::jsonb,
  storage_prefix text not null,
  title text,
  -- Why the take ended: 'stop' (someone pressed Stop — auto-recording leaves
  -- the room alone after that), 'leave' (the recorder left or the room
  -- ended), 'unload' (their tab closed), 'stale' (heartbeat lost), 'replaced'
  -- (the same tab reloaded and started over).
  end_reason text check (end_reason is null or end_reason in ('stop', 'leave', 'unload', 'stale', 'replaced')),
  -- Failed finalize runs; the sweep retries the least recently tried first
  -- and gives up after a dozen.
  finalize_attempts integer not null default 0 check (finalize_attempts >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- For a table created by an earlier run of this file.
alter table public.recording_sessions
  add column if not exists end_reason text
    check (end_reason is null or end_reason in ('stop', 'leave', 'unload', 'stale', 'replaced')),
  add column if not exists finalize_attempts integer not null default 0
    check (finalize_attempts >= 0);

comment on table public.recording_sessions is
  'One recording take per row. Bytes are in the private recordings bucket under storage_prefix; this row authorizes reading them.';

-- The lease: at most one take recording in a room at a time.
create unique index if not exists recording_sessions_one_active
  on public.recording_sessions (room_kind, room_id)
  where status = 'recording';

-- A room's takes, newest first (lists, the follow-up cron).
create index if not exists recording_sessions_room_idx
  on public.recording_sessions (room_kind, room_id, started_at desc);

-- The stale sweep.
create index if not exists recording_sessions_heartbeat_idx
  on public.recording_sessions (heartbeat_at)
  where status = 'recording';

-- Closed takes still to finalize, least recently tried first.
create index if not exists recording_sessions_unfinalized_idx
  on public.recording_sessions (updated_at)
  where finalized_at is null and status in ('finished', 'interrupted');

drop trigger if exists touch_recording_sessions on public.recording_sessions;
create trigger touch_recording_sessions before update on public.recording_sessions
  for each row execute procedure public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- A part, minted
-- ----------------------------------------------------------------------------
--
-- The recorder reports each part before uploading it: its index, byte size,
-- recorded time at its end, and the keyframe Clusters in it (cues). One
-- statement, so a long take's cue list is appended in place rather than read
-- and written back every ten seconds. Parts go in order: the next index, or
-- the latest again (a retry after a lost answer — its cues are already in).
-- Returns 'ok', 'stopped' (not recording, or not this user's take) or
-- 'order'. Service role only: it trusts p_user.

create or replace function public.recording_mint_part(
  p_id uuid,
  p_user uuid,
  p_index integer,
  p_size bigint,
  p_end_ms bigint,
  p_cues jsonb
)
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  r public.recording_sessions%rowtype;
  sizes jsonb;
  ends jsonb;
begin
  select * into r from public.recording_sessions where id = p_id for update;
  if not found or r.status <> 'recording' or r.started_by is distinct from p_user then
    return 'stopped';
  end if;
  if p_index is null or p_index < 0 or (p_index <> r.part_count and p_index <> r.part_count - 1)
     or p_size is null or p_size <= 0 or p_end_ms is null or p_end_ms < 0 then
    return 'order';
  end if;
  sizes := jsonb_set(r.part_sizes, array[p_index::text], to_jsonb(p_size), true);
  ends := jsonb_set(r.part_end_ms, array[p_index::text], to_jsonb(p_end_ms), true);
  update public.recording_sessions set
    heartbeat_at = now(),
    part_count = greatest(r.part_count, p_index + 1),
    part_sizes = sizes,
    part_end_ms = ends,
    total_bytes = (select coalesce(sum(t.v::bigint), 0) from jsonb_array_elements_text(sizes) as t(v)),
    duration_ms = greatest(r.duration_ms, p_end_ms),
    cues = case
      when p_index = r.part_count
        and jsonb_typeof(p_cues) = 'array'
        and jsonb_array_length(r.cues) + jsonb_array_length(p_cues) <= 20000
      then r.cues || p_cues
      else r.cues
    end
  where id = p_id;
  return 'ok';
end;
$$;

revoke all on function public.recording_mint_part(uuid, uuid, integer, bigint, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.recording_mint_part(uuid, uuid, integer, bigint, bigint, jsonb)
  to service_role;

-- ----------------------------------------------------------------------------
-- Who may read a take
-- ----------------------------------------------------------------------------

create or replace function public.can_view_recording(p_kind text, p_room uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select case p_kind
    when 'webinar' then public.has_permission(auth.uid(), 'events.manage')
    when 'call' then
      public.is_admin(auth.uid()) or public.is_call_participant(p_room)
    else false
  end;
$$;

alter table public.recording_sessions enable row level security;

drop policy if exists "recording_sessions read" on public.recording_sessions;
create policy "recording_sessions read" on public.recording_sessions
  for select to authenticated
  using (public.can_view_recording(room_kind, room_id));

-- Supabase's default privileges grant every new table to both API roles; the
-- app writes through the service role only.
revoke insert, update, delete, truncate on public.recording_sessions
  from anon, authenticated;
revoke all on public.recording_sessions from anon;

-- ----------------------------------------------------------------------------
-- Storage
-- ----------------------------------------------------------------------------
--
-- Private, and deliberately without storage.objects policies (the
-- call-recordings precedent): these include recordings of minors. 16 MB is
-- twice a part's cap (the recorder seals one every ~10s, at most 8 MB, and the
-- part route refuses a larger report), so an upload can't be bigger than what
-- was minted for. Video only.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recordings', 'recordings', false, 16777216, array['video/webm', 'video/mp4'])
on conflict (id) do update
  set public = false,
      file_size_limit = 16777216,
      allowed_mime_types = array['video/webm', 'video/mp4'];

notify pgrst, 'reload schema';
