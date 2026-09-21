-- ============================================================================
-- 0084 — Webinars: a first-class event type, with decks, recordings, guest
--        speakers, a real audience channel, and premieres.
--
-- Why this exists
-- ---------------
-- A webinar has been a `workshop` with `live_mode = 'hosted'` and a lot of
-- convention holding it together. That was fine while the only thing a webinar
-- did was carry video, and it stops being fine the moment it has to carry
-- anything else: a deck that should reach the audience afterwards, a recording
-- nobody had to remember to start, a guest who needs a camera without being
-- handed the keys to the admin panel, and an audience that can actually talk.
-- None of those fit on an events row that can't tell a webinar from a
-- workshop, so this makes `webinar` a type of its own and hangs the rest off it.
--
-- Everything here is additive. No existing event changes behaviour: the new
-- columns default to exactly what the code does today, `type` and `live_mode`
-- only gain values, and the four new tables are empty until a webinar uses
-- them. An events row written before this migration and read after it is
-- indistinguishable from one written after.
--
-- ---------------------------------------------------------------------------
-- The one genuinely new idea: `audience_mode`
-- ---------------------------------------------------------------------------
--
-- Every privacy rule in this subsystem so far has been a constant. 0058 hid the
-- audience with Daily's `hasPresence: false`; 0060 kept Q&A off the room's chat
-- because a hidden viewer can read it but not send to it; 0076 made the hiding
-- structural, by never disclosing one viewer to another in the first place.
-- `canSeeRoster()` in lib/live.ts takes a role and nothing else, deliberately,
-- so no call site can opt out.
--
-- Live chat cannot exist under that rule. Chat IS the audience seeing itself:
-- a name attached to a message is a disclosure that the person is here, and no
-- amount of care in the UI changes that. So rather than quietly weakening a
-- guarantee the rest of the system is built on, this makes it an explicit,
-- per-event, admin-chosen setting with the current behaviour as the default:
--
--   private    Today, unchanged, and still the default. A viewer sees only
--              their own questions. There is no chat. Nothing on the wire
--              tells one student that another exists.
--
--   moderated  Viewers write; a host decides what the room sees. An unapproved
--              message is delivered to the hosts' channel only — it is never
--              broadcast to the audience and never readable by another viewer,
--              which is enforced in RLS below and not merely in the UI. This is
--              the right setting for a public webinar in a program with minors:
--              the audience gets a live channel, and nothing reaches it that a
--              human has not read first.
--
--   open       Ordinary live chat. Everyone in the room sees every message and
--              who wrote it. Only for rooms where the audience is meant to know
--              each other — a cohort call, not a public intake webinar.
--
-- The knob is deliberately ONE concept, not three (chat on/off, questions
-- public/private, upvotes on/off). All three of those are the same question —
-- "may the audience see itself" — and splitting them would let an admin pick a
-- combination that leaks through one surface while hiding through another.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0083 are applied.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. `webinar` becomes a type, `premiere` becomes a mode
-- ----------------------------------------------------------------------------
--
-- Both constraints are dropped and rebuilt rather than altered, because
-- Postgres has no "add a value to a CHECK". The old names are the ones in the
-- database today: `events_type_check` was created inline by 0005, so it carries
-- Postgres's generated name; `events_live_mode_check` was named explicitly by
-- 0058. Dropping with `if exists` and recreating unconditionally is what makes
-- this safe to re-run.
--
-- Widening a CHECK can never fail on existing data — every row that satisfied
-- the old predicate satisfies the new one — so this takes a brief ACCESS
-- EXCLUSIVE lock and no table scan.

alter table public.events drop constraint if exists events_type_check;
alter table public.events
  add constraint events_type_check
  check (type in ('demo_day', 'office_hours', 'workshop', 'webinar', 'other'));

alter table public.events drop constraint if exists events_live_mode_check;
alter table public.events
  add constraint events_live_mode_check
  check (live_mode in ('external', 'hosted', 'premiere'));

comment on column public.events.live_mode is
  'external = pasted zoom_url (legacy); hosted = a batch0 Live room; premiere = a pre-recorded video played on the schedule, with a real live Q&A at the end.';

-- ----------------------------------------------------------------------------
-- 2. The new columns on `events`
-- ----------------------------------------------------------------------------

alter table public.events
  -- May the audience see itself? See the header. Defaults to the behaviour
  -- every existing event already has.
  add column if not exists audience_mode text not null default 'private',

  -- Start recording the moment the host starts broadcasting, without anyone
  -- pressing anything. Off for everything that exists today; the admin form
  -- turns it on by default for NEW webinars only, so no scheduled event
  -- silently starts recording people because a migration ran.
  add column if not exists auto_record boolean not null default false,

  -- After the webinar ends, send the deck and the recording to everyone who
  -- was invited. Same reasoning as auto_record: off by default here, on by
  -- default in the form for new webinars.
  add column if not exists auto_share boolean not null default false,

  -- When the follow-up actually went out. This is the idempotency key for the
  -- cron job, not a display field: the job's query is "ended, auto_share, and
  -- this is null", so a row that has been shared can never be shared twice
  -- however many times the job runs or however it is retried.
  add column if not exists assets_shared_at timestamptz,

  -- ---- premiere ----------------------------------------------------------
  --
  -- How long the pre-recorded video runs, in seconds. Read from the file on
  -- upload and stored here so the schedule can be computed server-side without
  -- fetching the video: a viewer's player is positioned at `now - starts_at`,
  -- and the room flips to the live Q&A at `starts_at + premiere_seconds`.
  add column if not exists premiere_seconds integer,

  -- When the genuinely-live Q&A opens. Normally derived (starts_at +
  -- premiere_seconds) and stored so a host can move it — a 40-minute talk with
  -- Q&A at the top of the hour is a normal thing to want.
  add column if not exists qa_opens_at timestamptz,

  -- Stamped the first time a host actually goes live in this room. Two jobs:
  -- it is how "go live early" reaches viewers who are still mid-premiere (the
  -- page polls it), and it is the honest record of when the room really opened,
  -- which `starts_at` is not once a premiere is involved.
  add column if not exists live_started_at timestamptz,

  -- Stamped when a host ends the broadcast on purpose. Distinct from the join
  -- window closing: a webinar that finished at 7:40 should stop saying "live"
  -- at 7:40, not at 8:30 when `joinState` finally calls it ended.
  add column if not exists live_ended_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'events_audience_mode_check'
  ) then
    alter table public.events
      add constraint events_audience_mode_check
      check (audience_mode in ('private', 'moderated', 'open'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'events_premiere_seconds_check'
  ) then
    -- Capped at 8 hours. Not a product limit so much as a typo limit: the
    -- number drives where a late viewer's player seeks to, and a value with an
    -- extra digit would park the whole audience in front of a video that never
    -- ends and a Q&A that never opens.
    alter table public.events
      add constraint events_premiere_seconds_check
      check (
        premiere_seconds is null
        or (premiere_seconds > 0 and premiere_seconds <= 28800)
      );
  end if;
end $$;

comment on column public.events.audience_mode is
  'May the audience see itself? private = viewer sees only their own questions, no chat (the default, and what every event did before 0084); moderated = viewers write, a host approves what the room sees; open = ordinary live chat.';
comment on column public.events.auto_record is
  'Start recording when the host starts broadcasting, with no button press.';
comment on column public.events.auto_share is
  'After it ends, send the deck and recording to everyone who was invited.';
comment on column public.events.assets_shared_at is
  'When the follow-up went out. The cron job''s idempotency key — never display.';
comment on column public.events.premiere_seconds is
  'Length of the pre-recorded video, in seconds. A viewer''s player is positioned at (now - starts_at), so this is what decides when the premiere ends and the live Q&A begins.';
comment on column public.events.live_started_at is
  'When a host actually went live. Drives "go live early" during a premiere, and is the honest start time when starts_at is the premiere''s start rather than the host''s.';

-- The follow-up cron's query, and nothing else: events that have ended, want
-- sharing, and have not been shared. Partial so the index holds only the
-- handful of rows that are ever candidates rather than every event ever run.
create index if not exists events_pending_share_idx
  on public.events (ends_at)
  where auto_share and assets_shared_at is null;

-- ----------------------------------------------------------------------------
-- 3. Guest speakers
-- ----------------------------------------------------------------------------
--
-- A guest needs a camera. Today the only way to get one is `events.manage`,
-- which is a GLOBAL staff permission: granting it to a founder coming in to
-- talk for forty minutes also hands them every event on the calendar, the
-- admin panel, and — through the `events read` policy's `is_staff` clause —
-- a great deal more besides. That is not a trade worth making for a guest.
--
-- So broadcast rights become per-event: a row here says "this person may host
-- THIS webinar", and nothing else. lib/live-rooms.ts derives the live role from
-- `events.manage` OR a speaker row, and the speaker row is scoped to one event
-- by its primary key.
--
-- The claim token exists because the usual case is an admin who has the guest's
-- email and nothing else. The admin adds the speaker by name and email, the
-- guest gets a link, and whoever is signed in when that link is opened becomes
-- the speaker — once. It is deliberately a *claim*, not an *authentication*:
-- the guest still has to be a signed-in batch0 user, so nothing here is a way
-- around the auth wall, and the token binds on first use so a forwarded link is
-- spent rather than shareable.

create table if not exists public.event_speakers (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  -- Null until the speaker claims their slot (or an admin picks an existing
  -- profile). A row with a null user_id is a card on the event page and nothing
  -- more — it grants no access, because there is no one for it to grant to.
  user_id uuid references public.profiles(id) on delete set null,
  -- Shown on the event page and as the lower-third in the room. Kept here
  -- rather than read from the profile because a guest's billing on a webinar
  -- ("Founder, Acme") is a property of the webinar, not of their account, and
  -- it must render before they have ever signed in.
  name text not null check (char_length(btrim(name)) between 1 and 120),
  title text check (char_length(title) <= 160),
  bio text check (char_length(bio) <= 1000),
  photo_url text,
  link_url text,
  -- Where the invite goes. Not unique and not an identity — `user_id` is the
  -- identity once claimed. Nullable so an admin can add a speaker card for
  -- someone who is already signed up without re-typing their address.
  email text,
  -- Single-use claim link. Cleared on claim, so a spent token cannot be
  -- replayed and a forwarded link fails closed.
  claim_token text unique,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One claim per person per event: an admin adding the same guest twice, or a
-- guest clicking an old link after claiming a new one, converges on one row
-- instead of forking their speaking rights across two.
create unique index if not exists event_speakers_unique_user
  on public.event_speakers (event_id, user_id)
  where user_id is not null;

create index if not exists event_speakers_event_idx
  on public.event_speakers (event_id, sort_order, created_at);

-- The authorization lookup, which runs on every join: "is this user a speaker
-- on this event". Covered by the unique index above, but stated separately so
-- the intent survives a future change to that index.
create index if not exists event_speakers_user_idx
  on public.event_speakers (user_id, event_id)
  where user_id is not null;

drop trigger if exists touch_event_speakers on public.event_speakers;
create trigger touch_event_speakers before update on public.event_speakers
  for each row execute procedure public.touch_updated_at();

/**
 * May this user broadcast in this event?
 *
 * SECURITY DEFINER and stable, in the same shape as is_admin/is_staff/
 * has_permission from 0001/0003/0048, because it is called from RLS policies
 * on tables the caller may not read directly — including `event_speakers`
 * itself, which would otherwise recurse through its own read policy.
 *
 * Deliberately does NOT include `events.manage` holders. Callers ask both
 * questions (`has_permission(uid,'events.manage') or is_event_speaker(...)`)
 * so that the two grants stay legible at each call site: one is "staff", the
 * other is "this guest, this webinar", and a policy that blurred them would be
 * much harder to audit than one that spells both out.
 */
create or replace function public.is_event_speaker(uid uuid, ev uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.event_speakers s
    where s.event_id = ev and s.user_id = uid
  );
$$;

alter table public.event_speakers enable row level security;

-- Read: anyone who can see the event can see who is speaking at it. The nested
-- select runs under the reader's own RLS, so the `events read` policy decides,
-- and a speaker list can never be more visible than the event it belongs to.
drop policy if exists "event_speakers read" on public.event_speakers;
create policy "event_speakers read" on public.event_speakers
  for select using (
    exists (select 1 from public.events e where e.id = event_id)
  );

-- ---- and two columns that policy must NOT hand over ------------------------
--
-- RLS is row-level, and `claim_token` is a column on a row the whole cohort can
-- read. Without this revoke, any signed-in student could select the token for a
-- webinar they can see, open the claim link, and become a speaker on it — which
-- means broadcast rights, chat and Q&A moderation, and (through credentialsFor's
-- host branch) every viewer's inbox. That is a privilege escalation from
-- "enrolled student" to "runs the room", available to anyone who reads the API.
--
-- Column-level privileges are the right tool because the row genuinely should be
-- readable: a student SHOULD see who is speaking. Revoking the table outright
-- would take the speaker cards with it. `email` goes too — a guest's address is
-- staff information, and `listSpeakers(includePrivate)` in lib/webinar-data.ts
-- already draws that line on the read side.
--
-- READ THE ORDER HERE CAREFULLY, because the obvious spelling does nothing.
-- `revoke select (claim_token) ... ` on its own is a no-op against a role that
-- holds a TABLE-level select grant — and every role here does, because Supabase
-- hands anon and authenticated `grant all on tables` through ALTER DEFAULT
-- PRIVILEGES, which applies to tables a later migration creates without that
-- migration saying anything. A table grant covers every column, including ones
-- added afterwards, and a column revoke does not subtract from it. So the
-- table-wide grant has to come off FIRST, and the columns that are safe to read
-- are then granted back by name.
--
-- lib/webinars-migration-db.test.ts asserts exactly this, and it caught the
-- no-op version of this block.
--
-- Writes go the same way, and more simply: every write to this table is a
-- server action running under the service role, so there is no reason for a
-- browser-held JWT to carry insert, update or delete on it at all. RLS already
-- refuses them (there is no write policy); this makes the grant match the
-- intent instead of relying on the policy alone.
revoke all on public.event_speakers from anon, authenticated;
grant select (
  id, event_id, user_id, name, title, bio, photo_url, link_url,
  sort_order, created_at, updated_at
) on public.event_speakers to anon, authenticated;

-- Writes are server-only (service role, via lib/webinars.ts under
-- assertPermission). No policy, so the anon-key browser client cannot insert a
-- row naming itself as a speaker — which would be a student granting themselves
-- a camera in someone else's webinar.

-- ---- and the event itself has to be visible to them ------------------------
--
-- Same policy as 0070 plus one clause: a guest speaker may read the event they
-- are speaking at. Without this the whole feature is inert — a founder invited
-- to talk is neither staff nor enrolled, so `events read` gives them no row,
-- and every path that matters reads the event through RLS on purpose (the live
-- page, joinRoom, the Q&A gate). They would be a speaker on a webinar they get
-- a 404 for.
--
-- Deliberately the narrowest possible clause. It opens exactly the one event
-- their row names, and it opens nothing else: not the cohort, not other events,
-- not `is_staff`. Compare the demo-day ticket clause below it, which is the
-- same shape — a specific row elsewhere in the database granting read on a
-- specific event.
drop policy if exists "events read" on public.events;
create policy "events read" on public.events
  for select using (
    visibility = 'public'
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

comment on table public.event_speakers is
  'Guest speakers. A row with a user_id grants broadcast rights for THAT event only — the alternative was granting the global events.manage permission to a guest, which also hands over the admin panel.';

-- ----------------------------------------------------------------------------
-- 4. Files that belong to an event
-- ----------------------------------------------------------------------------
--
-- One table for four kinds of file, because everything downstream of them is
-- identical — the same storage bucket, the same signed-URL read path, the same
-- "send it to the audience afterwards" job — and the only thing that differs is
-- what the room does with it while it is running:
--
--   deck      A pptx or pdf. Shown to the host in the room, and sent to the
--             audience after (or during, if the admin says so).
--   handout   Anything else worth sending afterwards.
--   premiere  The pre-recorded video a premiere plays. Exactly one per event.
--   recording A segment of the room's own recording. MANY per event, ordered
--             by sort_order — see the note below.
--
-- Why recordings are segments, not a file
-- ---------------------------------------
-- The recorder runs in the host's browser (MediaRecorder over a canvas that
-- composes camera, screen and mic), and a 60-minute webinar is several hundred
-- megabytes. Holding that in a tab and pushing it in one request at the end has
-- three failure modes that all land at the worst moment: the memory grows
-- unbounded during the event, the upload starts when the host most wants to
-- close the laptop, and any failure — a flaky hotel wifi, a closed tab — costs
-- the entire recording.
--
-- So the recorder writes a self-contained file every few minutes and uploads it
-- while the webinar is still running. Memory is bounded by one segment, the
-- upload is finished seconds after the talk is, and a crash costs at most the
-- segment in flight instead of the hour behind it. `sort_order` is the segment
-- index; the player walks them in order and preloads the next.

create table if not exists public.event_assets (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  kind text not null check (kind in ('deck', 'handout', 'premiere', 'recording')),
  -- Path inside the private `webinar-media` bucket. Files are served through
  -- short-lived signed URLs minted server-side, never by making the bucket
  -- public: a deck for an enrolled-only webinar is enrolled-only.
  storage_path text not null,
  -- What the uploader called it. Used for the download filename, so a student
  -- gets "Fundraising 101.pdf" and not "fundraising-101-1758470000.pdf".
  filename text not null,
  mime_type text,
  size_bytes bigint,
  -- Premieres and recording segments only. Lets the premiere schedule and the
  -- recording player work without probing the file.
  duration_seconds integer,
  -- Segment index for recordings; display order for decks and handouts.
  sort_order integer not null default 0,
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Every read of this table is "the files for one event, in order".
create index if not exists event_assets_event_idx
  on public.event_assets (event_id, kind, sort_order, created_at);

-- A segment is written once. If a retry re-uploads the same index — which is
-- exactly what a recorder recovering from a dropped connection does — it must
-- replace, not duplicate, or the recording plays the same five minutes twice.
create unique index if not exists event_assets_recording_segment
  on public.event_assets (event_id, sort_order)
  where kind = 'recording';

alter table public.event_assets enable row level security;

-- Read: gated on the event, like the speaker list. A deck is exactly as visible
-- as the webinar it was shown at.
--
-- The `share_at` rule — "the deck goes out afterwards, not now" — is
-- deliberately NOT here. It is a *delivery* decision (what the follow-up email
-- contains, what the room offers to download), not an access decision, and
-- encoding it in RLS would mean the host could not see their own deck before
-- their own webinar. The row being readable is not the file being readable:
-- the bytes need a signed URL, and lib/webinars.ts mints one only for a caller
-- who is allowed the file at the time they ask.
drop policy if exists "event_assets read" on public.event_assets;
create policy "event_assets read" on public.event_assets
  for select using (
    exists (select 1 from public.events e where e.id = event_id)
  );

-- No write policy: uploads go through server actions under the service role,
-- after assertPermission('events.manage') or a speaker check. A browser that
-- could insert here could attach a file of its choosing to a webinar and have
-- it emailed to the cohort.

comment on table public.event_assets is
  'Decks, handouts, premiere videos and recording segments for an event. Recordings are many rows ordered by sort_order — the recorder uploads a self-contained file every few minutes so a crashed tab costs one segment, not the hour behind it.';

-- ----------------------------------------------------------------------------
-- 5. Live chat
-- ----------------------------------------------------------------------------
--
-- Separate from `webinar_questions` (0060) on purpose, and the reason is
-- lifecycle rather than shape. A question is a work item: it is asked, it sits
-- in a queue, a host answers or dismisses it, and it is still interesting an
-- hour later. A chat message is a moment: it scrolls past, it is never
-- "resolved", and nobody goes looking for message 400 afterwards. Folding them
-- into one table would mean every read of either paying for the other's
-- indexes and every status value meaning nothing half the time.
--
-- Visibility is the whole design here, so read the policy below carefully. A
-- message is visible to the audience only when the event's `audience_mode`
-- says so, and in `moderated` mode only after a host has approved it. That is
-- enforced in RLS and not merely in the server action, because the anon-key
-- browser client carries the student's JWT and can query this table directly —
-- exactly the reasoning 0060 gives for putting the join window and the spam cap
-- in the insert policy rather than only in the action.

create table if not exists public.webinar_messages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  -- Snapshot of "was this the team (or a guest speaker) talking" at send time.
  -- Same reasoning as discussion_replies.is_staff in 0068: a host who later
  -- loses the permission should not retroactively become a student in the
  -- transcript, and a message rendered from a live permission check would.
  is_host boolean not null default false,
  -- Null while a message is waiting on a host in `moderated` mode. In `open`
  -- mode it is stamped on insert, because there is nothing to wait for.
  -- This column IS the visibility rule — see the read policy.
  approved_at timestamptz,
  -- A host hid it after the fact. Distinct from "never approved": a removed
  -- message stays in the table (it is a record of what was said in a room full
  -- of minors) and stops being delivered.
  removed_at timestamptz,
  -- The host pinned it to the top of the room. At most one per event is
  -- enforced in the action rather than the schema, because "pin this instead"
  -- is two writes and a constraint would make the intermediate state illegal.
  pinned boolean not null default false,
  created_at timestamptz not null default now()
);

-- The room's feed: one event, in order. `id` breaks ties so a page boundary
-- can never show the same message twice or skip one when two land in the same
-- millisecond, which at 50 people in a room is not hypothetical.
create index if not exists webinar_messages_feed_idx
  on public.webinar_messages (event_id, created_at, id);

-- The host's moderation queue in `moderated` mode.
create index if not exists webinar_messages_pending_idx
  on public.webinar_messages (event_id, created_at)
  where approved_at is null and removed_at is null;

-- The per-author rate-limit count in the insert policy below.
create index if not exists webinar_messages_author_idx
  on public.webinar_messages (event_id, author_id, created_at desc);

alter table public.webinar_messages enable row level security;

-- Read, in four clauses, from most to least privileged:
--
--  1. Staff and hosts see everything, including what is pending and what was
--     removed. That is the moderation queue.
--  2. A guest speaker on this event sees the same — they are running the room.
--  3. Everyone always sees their own messages, whatever the mode and whether or
--     not they have been approved. A student whose message vanished on send
--     would reasonably conclude the room is broken and send it again.
--  4. Everyone else sees approved, un-removed messages — and only when the
--     event's audience_mode is 'moderated' or 'open'. In 'private' this clause
--     is false for every row, so a private webinar has no chat even if a row
--     somehow exists on it.
--
-- The `events` subquery runs under the reader's own RLS, so a message can never
-- be more visible than the event it was sent in.
drop policy if exists "webinar_messages read" on public.webinar_messages;
create policy "webinar_messages read" on public.webinar_messages
  for select using (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'events.manage')
    or public.is_event_speaker(auth.uid(), event_id)
    or author_id = auth.uid()
    or (
      approved_at is not null
      and removed_at is null
      and exists (
        select 1 from public.events e
        where e.id = event_id
          and e.audience_mode in ('moderated', 'open')
      )
    )
  );

-- Insert: as yourself, into a room that is open to chat, while it is live, and
-- under a rate limit.
--
-- The window mirrors joinState() in lib/live.ts exactly, as 0060's does: open
-- from 15 minutes before the start until 30 minutes past the end (or a
-- 60-minute default when the event has no end). Keep the three copies — here,
-- in 0060, and in lib/live.ts — in step.
--
-- The rate limit is per ten seconds rather than per event, because chat is not
-- Q&A: a total cap would either be low enough to cut off a talkative student
-- halfway through an hour or high enough to be no limit at all. Five messages
-- in ten seconds is faster than anyone types and slower than a script.
drop policy if exists "webinar_messages insert" on public.webinar_messages;
create policy "webinar_messages insert" on public.webinar_messages
  for insert with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.events e
      where e.id = event_id
        and e.live_mode in ('hosted', 'premiere')
        and e.audience_mode in ('moderated', 'open')
        and now() >= e.starts_at - interval '15 minutes'
        and now() <=
          coalesce(e.ends_at, e.starts_at + interval '60 minutes')
            + interval '30 minutes'
    )
    and (
      select count(*) from public.webinar_messages m
      where m.event_id = event_id
        and m.author_id = auth.uid()
        and m.created_at > now() - interval '10 seconds'
    ) < 5
  );

-- Update: hosts, speakers and admins moderate. An author cannot edit their own
-- message — a transcript that can be rewritten after the fact is not a record,
-- and "delete mine" is a host action here for the same reason.
drop policy if exists "webinar_messages moderate" on public.webinar_messages;
create policy "webinar_messages moderate" on public.webinar_messages
  for update using (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'events.manage')
    or public.is_event_speaker(auth.uid(), event_id)
  ) with check (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'events.manage')
    or public.is_event_speaker(auth.uid(), event_id)
  );

comment on table public.webinar_messages is
  'Live chat for a webinar. Visible to the audience only when events.audience_mode allows it, and in moderated mode only once a host has approved — enforced here, not just in the UI, because the browser client can read this table directly.';

-- ----------------------------------------------------------------------------
-- 6. Upvotes on questions
-- ----------------------------------------------------------------------------
--
-- The point of upvoting is to let a host answer the question forty people had
-- instead of the question that happened to arrive last. It is therefore only
-- meaningful where the audience can see each other's questions at all — in
-- `private` mode nobody has anything to vote on, and the insert policy says so.
--
-- A row per voter rather than a counter on the question: a counter cannot be
-- un-voted, cannot be deduplicated, and cannot survive two people voting in the
-- same millisecond without a lock. The denormalised count lives on
-- webinar_questions and is maintained by the trigger below, so the host's panel
-- sorts without a join.

create table if not exists public.webinar_question_votes (
  question_id uuid not null references public.webinar_questions(id) on delete cascade,
  voter_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (question_id, voter_id)
);

create index if not exists webinar_question_votes_voter_idx
  on public.webinar_question_votes (voter_id);

alter table public.webinar_question_votes enable row level security;

-- Read: your own votes (so the UI can show which ones you've already upvoted),
-- and everything for staff. Deliberately no path for a viewer to read another
-- viewer's vote — knowing WHO upvoted is the audience seeing itself, and the
-- count is already on the question.
drop policy if exists "webinar_question_votes read" on public.webinar_question_votes;
create policy "webinar_question_votes read" on public.webinar_question_votes
  for select using (
    voter_id = auth.uid()
    or public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'events.manage')
  );

-- Insert: as yourself, on a question in a room whose audience can see itself.
drop policy if exists "webinar_question_votes insert" on public.webinar_question_votes;
create policy "webinar_question_votes insert" on public.webinar_question_votes
  for insert with check (
    voter_id = auth.uid()
    and exists (
      select 1
        from public.webinar_questions q
        join public.events e on e.id = q.event_id
       where q.id = question_id
         and e.audience_mode in ('moderated', 'open')
    )
  );

-- Delete: un-vote, your own only.
drop policy if exists "webinar_question_votes delete" on public.webinar_question_votes;
create policy "webinar_question_votes delete" on public.webinar_question_votes
  for delete using (voter_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 7. Questions grow three columns
-- ----------------------------------------------------------------------------

alter table public.webinar_questions
  -- Maintained by the trigger below. Denormalised so the host's panel can sort
  -- by popularity without joining the votes table on every poll.
  add column if not exists vote_count integer not null default 0,
  -- `moderated` mode: a question is invisible to the room until a host lets it
  -- through, exactly like a chat message. Null in `open` mode means "not
  -- approved yet" too — the action stamps it on insert there, so the two modes
  -- share one predicate instead of branching.
  add column if not exists approved_at timestamptz,
  -- The one the host is answering right now, shown to the whole room. Makes a
  -- Q&A legible to someone who joined thirty seconds ago.
  add column if not exists spotlighted boolean not null default false;

create index if not exists webinar_questions_top_idx
  on public.webinar_questions (event_id, vote_count desc, created_at desc);

create or replace function public.touch_question_votes()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- Recount rather than increment. A counter that is stepped up and down drifts
  -- the first time a delete is rolled back or a row is removed by cascade, and
  -- the number is the thing the host sorts by; a subquery over a primary-key
  -- range is cheap enough that being exactly right is free.
  update public.webinar_questions q
     set vote_count = (
           select count(*) from public.webinar_question_votes v
            where v.question_id = q.id
         )
   where q.id = coalesce(new.question_id, old.question_id);
  return null;
end $$;

drop trigger if exists webinar_question_votes_count on public.webinar_question_votes;
create trigger webinar_question_votes_count
  after insert or delete on public.webinar_question_votes
  for each row execute procedure public.touch_question_votes();

-- The 0060 read policy let a viewer see only their own questions, which is the
-- right rule in `private` mode and the wrong one in the other two. Same four
-- clauses as the chat policy, and for the same reasons.
drop policy if exists "webinar_questions read" on public.webinar_questions;
create policy "webinar_questions read" on public.webinar_questions
  for select using (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'events.manage')
    or public.is_event_speaker(auth.uid(), event_id)
    or asker_id = auth.uid()
    or (
      approved_at is not null
      and status <> 'dismissed'
      and exists (
        select 1 from public.events e
        where e.id = event_id
          and e.audience_mode in ('moderated', 'open')
      )
    )
  );

-- 0060's insert policy named `live_mode = 'hosted'`, which was the only hosted
-- mode there was. A premiere takes questions throughout — that is most of what
-- makes it feel live — so the predicate widens to both.
drop policy if exists "webinar_questions insert" on public.webinar_questions;
create policy "webinar_questions insert" on public.webinar_questions
  for insert with check (
    asker_id = auth.uid()
    and exists (
      select 1 from public.events e
      where e.id = event_id
        and e.live_mode in ('hosted', 'premiere')
        and now() >= e.starts_at - interval '15 minutes'
        and now() <=
          coalesce(e.ends_at, e.starts_at + interval '60 minutes')
            + interval '30 minutes'
    )
    and (
      select count(*) from public.webinar_questions w
      where w.event_id = event_id
        and w.asker_id = auth.uid()
    ) < 40
  );

-- A guest speaker runs the Q&A too, so they moderate it.
drop policy if exists "webinar_questions moderate" on public.webinar_questions;
create policy "webinar_questions moderate" on public.webinar_questions
  for update using (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'events.manage')
    or public.is_event_speaker(auth.uid(), event_id)
  ) with check (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'events.manage')
    or public.is_event_speaker(auth.uid(), event_id)
  );

-- ----------------------------------------------------------------------------
-- 8. Polls
-- ----------------------------------------------------------------------------
--
-- The cheapest thing a host can do to find out whether an audience is still
-- there. Options live in a jsonb array rather than a child table because they
-- are written once with the poll, never edited, never queried individually, and
-- never more than a handful — a child table would buy referential integrity for
-- a relationship that has no lifecycle of its own.
--
-- A vote stores the option INDEX. That is safe precisely because the options
-- are immutable: there is no edit path that could renumber them under a vote
-- already cast.

create table if not exists public.webinar_polls (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  question text not null check (char_length(btrim(question)) between 1 and 300),
  -- ["Yes", "No", "Not sure"] — 2 to 6 entries, checked in the action where a
  -- good error message is possible, and bounded here so a hand-written row
  -- cannot render a hundred radio buttons into the room.
  options jsonb not null check (
    jsonb_typeof(options) = 'array'
    and jsonb_array_length(options) between 2 and 6
  ),
  -- Closed polls stop taking votes and show their result. A poll is opened by
  -- the host when they want it, not when they wrote it — so `open` is false
  -- until then, and a host can prepare a webinar's polls in advance.
  open boolean not null default false,
  -- Show the tally to the audience, or keep it to the host.
  results_visible boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists webinar_polls_event_idx
  on public.webinar_polls (event_id, created_at);

drop trigger if exists touch_webinar_polls on public.webinar_polls;
create trigger touch_webinar_polls before update on public.webinar_polls
  for each row execute procedure public.touch_updated_at();

create table if not exists public.webinar_poll_votes (
  poll_id uuid not null references public.webinar_polls(id) on delete cascade,
  voter_id uuid not null references public.profiles(id) on delete cascade,
  choice integer not null check (choice >= 0),
  created_at timestamptz not null default now(),
  primary key (poll_id, voter_id)
);

alter table public.webinar_polls enable row level security;
alter table public.webinar_poll_votes enable row level security;

-- Read a poll: anyone who can see the event, once the host has opened it.
-- Staff and speakers see it while it is still being drafted.
drop policy if exists "webinar_polls read" on public.webinar_polls;
create policy "webinar_polls read" on public.webinar_polls
  for select using (
    public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'events.manage')
    or public.is_event_speaker(auth.uid(), event_id)
    or (
      open
      and exists (select 1 from public.events e where e.id = event_id)
    )
  );

-- Vote: as yourself, on an open poll, on an event you can see. The choice is
-- bounded against the poll's own option count, so a hand-crafted request cannot
-- record a vote for option 97 and skew a tally nobody can explain.
drop policy if exists "webinar_poll_votes insert" on public.webinar_poll_votes;
create policy "webinar_poll_votes insert" on public.webinar_poll_votes
  for insert with check (
    voter_id = auth.uid()
    and exists (
      select 1
        from public.webinar_polls p
        join public.events e on e.id = p.event_id
       where p.id = poll_id
         and p.open
         and choice < jsonb_array_length(p.options)
    )
  );

-- Read votes: your own, plus everything for the people running the room. The
-- audience sees the tally, which the server computes — never the individual
-- votes, which would be one student learning how another voted.
drop policy if exists "webinar_poll_votes read" on public.webinar_poll_votes;
create policy "webinar_poll_votes read" on public.webinar_poll_votes
  for select using (
    voter_id = auth.uid()
    or public.is_admin(auth.uid())
    or public.has_permission(auth.uid(), 'events.manage')
    or exists (
      select 1 from public.webinar_polls p
      where p.id = poll_id and public.is_event_speaker(auth.uid(), p.event_id)
    )
  );

-- Change your mind while the poll is open.
drop policy if exists "webinar_poll_votes update" on public.webinar_poll_votes;
create policy "webinar_poll_votes update" on public.webinar_poll_votes
  for update using (voter_id = auth.uid())
  with check (
    voter_id = auth.uid()
    and exists (
      select 1 from public.webinar_polls p
      where p.id = poll_id and p.open and choice < jsonb_array_length(p.options)
    )
  );

comment on table public.webinar_polls is
  'Host-run polls inside a webinar. Options are immutable jsonb, which is what makes storing a vote as an option index safe.';

-- ----------------------------------------------------------------------------
-- 9. Storage: the webinar-media bucket
-- ----------------------------------------------------------------------------
--
-- Private, mirroring `challenge-uploads` (0047) and `course-videos` (0001).
-- Decks and recordings inherit the visibility of the webinar they belong to —
-- an enrolled-only webinar's deck is enrolled-only — and a public bucket cannot
-- express that. Writes are one-shot signed upload URLs minted server-side (see
-- getWebinarUploadToken); reads are short-lived signed URLs generated with the
-- service role after the same event check the live room runs. Neither path
-- needs a broad policy, so the staff ALL policy below is belt-and-suspenders
-- for any direct access, exactly as 0047 puts it.
--
-- The size limit is the one number here that is not a preference. A recording
-- segment is five minutes of 720p at 1.2 Mbps — about 45 MB — and a premiere
-- video is a whole talk. 2 GB covers both with room to spare and still refuses
-- the accidental upload of something that has no business in this bucket.
--
-- `allowed_mime_types` is deliberately NOT set, which is a departure from 0047
-- and worth the sentence. Supabase matches that list against the request's
-- Content-Type verbatim, and a browser `MediaRecorder` sends the codec-carrying
-- form — `video/webm;codecs=vp8,opus`, and on Safari `video/mp4;codecs=avc1.…`
-- — which does not equal `video/webm`. Listing the bare types would refuse
-- every recording this feature exists to produce, and listing the codec
-- variants would mean enumerating what each browser version happens to emit.
-- So the type is checked in `registerWebinarAsset` instead, where the filename
-- and the event are both known and the error message can say something useful.

insert into storage.buckets (id, name, public, file_size_limit)
values (
  'webinar-media',
  'webinar-media',
  false,
  2147483648            -- 2 GB, matches MAX_UPLOAD_BYTES in lib/webinars.ts
)
on conflict (id) do update
  -- Unlike 0047's `do nothing`: re-running this after someone has tightened the
  -- bucket by hand should restore the limit the code assumes, and `greatest`
  -- means it can only ever raise a limit, never quietly lower one that was
  -- deliberately raised.
  set public = false,
      file_size_limit = greatest(
        coalesce(storage.buckets.file_size_limit, 0),
        2147483648
      );

-- Staff only, directly. A guest speaker uploading a deck goes through the
-- server action, which checks their speaker row and then mints a signed upload
-- URL under the service role — there is deliberately no storage policy trying
-- to express "is a speaker on the event this path belongs to", because a path
-- is a string and parsing authorization out of one is how buckets leak.
drop policy if exists "webinar-media staff all" on storage.objects;
create policy "webinar-media staff all" on storage.objects
  for all to authenticated
  using (
    bucket_id = 'webinar-media'
    and (
      public.is_admin(auth.uid())
      or public.has_permission(auth.uid(), 'events.manage')
    )
  )
  with check (
    bucket_id = 'webinar-media'
    and (
      public.is_admin(auth.uid())
      or public.has_permission(auth.uid(), 'events.manage')
    )
  );

-- ----------------------------------------------------------------------------
-- 10. Tell PostgREST about all of it
-- ----------------------------------------------------------------------------
--
-- Without this the new tables are invisible to the API until the schema cache
-- happens to refresh, which presents as PGRST205 ("table not found") from a
-- deploy that is in fact correct.
notify pgrst, 'reload schema';
