-- 0094_google_drive.sql
--
-- Google Drive replaces the in-app file stores (personal Files and the team
-- drive). Idempotent: safe to run more than once.
--
--   1. team_drive_links: a team's Google Drive folder plus pinned Docs, Sheets,
--      Slides, Forms and Drive files. Only the parsed parts of a link are
--      stored (kind, id, resource key, gid); the app rebuilds every URL from
--      them (lib/google-drive-links.ts). Read-only to signed-in users; every
--      write goes through service-role server actions
--      (app/dashboard/team/drive-link-actions.ts). Not on public.teams: public
--      teams are readable by anyone and members can update any teams column.
--   2. pitch_submissions.deck_url: the Demo Day deck is a link now. Deck and
--      video links are https-only (old video links repaired first).
--   3. Freeze the legacy uploads (student_files, team_drive_files and their
--      buckets). Rows and bytes stay readable so nobody loses work; nothing
--      new can be written through the API.
--   4. Repoint lesson text and old notifications from /dashboard/files.

-- ---------------------------------------------------------------------------
-- 1. team_drive_links
-- ---------------------------------------------------------------------------
create table if not exists public.team_drive_links (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  kind text not null
    check (kind in ('folder', 'doc', 'sheet', 'slides', 'form', 'drawing', 'file')),
  google_id text not null check (google_id ~ '^[A-Za-z0-9_-]{10,128}$'),
  resource_key text
    check (resource_key is null or resource_key ~ '^[A-Za-z0-9_-]{1,128}$'),
  published boolean not null default false,
  gid text check (gid is null or gid ~ '^[0-9]{1,12}$'),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  -- The team's folder (embedded at the top of the Drive tab). One per team.
  is_folder_root boolean not null default false,
  position integer not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_drive_links_root_is_folder
    check (not is_folder_root or (kind = 'folder' and not published)),
  constraint team_drive_links_published_kinds
    check (not published or kind in ('doc', 'sheet', 'slides', 'form', 'drawing'))
);

create unique index if not exists team_drive_links_one_root
  on public.team_drive_links (team_id) where is_folder_root;
create unique index if not exists team_drive_links_pin_unique
  on public.team_drive_links (team_id, kind, google_id) where not is_folder_root;
create index if not exists team_drive_links_team_idx
  on public.team_drive_links (team_id, position, created_at);

drop trigger if exists touch_team_drive_links on public.team_drive_links;
create trigger touch_team_drive_links before update on public.team_drive_links
  for each row execute procedure public.touch_updated_at();

alter table public.team_drive_links enable row level security;

-- Is the signed-in user on this team? SECURITY DEFINER so the check doesn't
-- run through team_members' own read policy, which refers to itself and
-- fails with "infinite recursion detected" for a signed-in student. Takes
-- no user id: it only ever answers for the caller.
create or replace function public.caller_on_team(p_team_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team_id and user_id = auth.uid()
  );
$$;
revoke execute on function public.caller_on_team(uuid) from public, anon;
grant execute on function public.caller_on_team(uuid) to authenticated;

-- Members of the team, mentors and team managers. Not investors: a team's
-- working folder is not part of what they assess (they see the pitch links).
drop policy if exists "team_drive_links read" on public.team_drive_links;
create policy "team_drive_links read" on public.team_drive_links
  for select to authenticated using (
    public.has_permission(auth.uid(), 'mentor.panel')
    or public.has_permission(auth.uid(), 'teams.manage')
    or public.caller_on_team(team_id)
  );

-- Supabase grants table privileges to the API roles by default. Writes are
-- service-role only, so take them away rather than relying on the absence of
-- a write policy.
revoke insert, update, delete, truncate on public.team_drive_links from anon, authenticated;
revoke select on public.team_drive_links from anon;

-- ---------------------------------------------------------------------------
-- 2. Demo Day deck link
-- ---------------------------------------------------------------------------
alter table public.pitch_submissions add column if not exists deck_url text;

alter table public.pitch_submissions
  drop constraint if exists pitch_submissions_deck_url_https;
alter table public.pitch_submissions
  add constraint pitch_submissions_deck_url_https
  check (deck_url is null or (deck_url ~* '^https://[^[:space:]]+$' and char_length(deck_url) <= 2048));

-- Members can still write this table directly (policy "pitch_submissions
-- member write"), so the https rule for the video link lives here too. Older
-- rows were saved under a looser rule (anything starting http(s)://). Repair
-- them first so the check is fully validated: a NOT VALID check would still
-- reject every later update of a bad row, Submit included. A link that can't
-- be repaired moves into the notes, so nothing typed is lost.
with bad as (
  select team_id, video_url as raw,
    regexp_replace(
      regexp_replace(btrim(video_url, E' \t\r\n'), '^http://', 'https://', 'i'),
      '[[:space:]]+', '%20', 'g'
    ) as fixed
  from public.pitch_submissions
  where video_url is not null
    and not (video_url ~* '^https://[^[:space:]]+$' and char_length(video_url) <= 2048)
), checked as (
  select team_id, raw, fixed,
    (fixed ~* '^https://[^[:space:]]+$' and char_length(fixed) <= 2048) as ok
  from bad
)
update public.pitch_submissions p
set video_url = case when c.ok then c.fixed end,
    notes = case
      when c.ok or c.fixed = '' then p.notes
      else concat_ws(E'\n\n', nullif(btrim(p.notes), ''), 'Video link: ' || btrim(c.raw))
    end
from checked c
where p.team_id = c.team_id;
alter table public.pitch_submissions
  drop constraint if exists pitch_submissions_video_url_https;
alter table public.pitch_submissions
  add constraint pitch_submissions_video_url_https
  check (video_url is null or (video_url ~* '^https://[^[:space:]]+$' and char_length(video_url) <= 2048));

-- ---------------------------------------------------------------------------
-- 3. Freeze legacy uploads (read-only; drop in a later migration)
-- ---------------------------------------------------------------------------
-- Insert/update let a user register a row pointing at any storage path, which
-- the old service-role download then signed. Owners keep delete.
drop policy if exists "student_files own insert" on public.student_files;
drop policy if exists "student_files own update" on public.student_files;
drop policy if exists "team_drive_files member write" on public.team_drive_files;

drop policy if exists "team-drive write" on storage.objects;
-- Was FOR ALL (read + write). Reads keep their old reach; writes go.
drop policy if exists "student-files own write" on storage.objects;
drop policy if exists "student-files own read" on storage.objects;
create policy "student-files own read" on storage.objects
  for select to authenticated using (
    bucket_id = 'student-files' and (
      split_part(name, '/', 1) = auth.uid()::text
      or public.is_staff(auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Links into the removed Files page
-- ---------------------------------------------------------------------------
update public.lessons
set description = replace(
  replace(description, '[Files](/dashboard/files)', '[Google Drive](/dashboard/team?tab=drive)'),
  '/dashboard/files', '/dashboard/team?tab=drive'
)
where description like '%/dashboard/files%';

update public.notifications
set link = '/dashboard/team?tab=drive'
where link like '/dashboard/files%';

notify pgrst, 'reload schema';
