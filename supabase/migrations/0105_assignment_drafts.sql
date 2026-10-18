-- ============================================================================
-- 0105 — Private, autosaved assignment drafts.
--
-- Until now a student's answer lived only in the form's memory until they
-- pressed Submit: a reload, a closed tab or a phone that dropped the page
-- lost it. This adds one row per (assignment, student) holding what they have
-- typed so far.
--
--   course_assignment_drafts   the unsubmitted text and link, with a version
--                              that every save must name.
--
-- A draft is NOT a submission. It lives in its own table so nothing that
-- counts, lists, reviews or reminds about submissions (the matrix, the review
-- queue, the overdue count, the reminders cron) can ever see one, and its read
-- policy is the owner's alone: no staff or admin clause, unlike every other
-- assignment table. Submitting copies the text into
-- course_assignment_submissions (the server action), then clears the draft.
--
-- Writes go through two functions, called by the service role only:
--
--   save_course_assignment_draft()    every autosave. Re-checks, on every
--       save, everything submitAssignment checks: the assignment is published
--       and open, the student is enrolled in its cohort (and targeted, for a
--       students-only one), the cohort has started, and the work hasn't been
--       reviewed or excused. Losing any of those stops the saves at once. It
--       also refuses a save that doesn't name the version it was typed on top
--       of, so a tab left open on an older copy can't overwrite newer text
--       written in another tab or on another device.
--   clear_course_assignment_draft()   after a submit.
--
-- The version only ever goes up. Clearing a submitted draft empties the row
-- and bumps it rather than deleting it: a deleted row would come back at
-- version 1 on the next save, and a tab still holding an old "1" would then
-- match text it never saw.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0001..0102 (0093: the assignment tables) are applied.
-- ============================================================================

create table if not exists public.course_assignment_drafts (
  assignment_id uuid not null references public.course_assignments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- Whatever has been typed, valid or not yet: no https rule on the link here
  -- (a half-typed URL is a normal draft). Same length caps as a submission.
  body text check (body is null or char_length(body) <= 10000),
  link_url text check (link_url is null or char_length(link_url) <= 2048),
  -- Bumped by every write; a save names the version it started from.
  version integer not null default 1 check (version >= 1),
  -- Set when a submit cleared it: the row is then "no draft", kept only so
  -- its version keeps counting up. The next save unsets it.
  cleared_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (assignment_id, user_id)
);

-- A database that ran an earlier draft of this file (a branch preview).
alter table public.course_assignment_drafts add column if not exists cleared_at timestamptz;

create index if not exists course_assignment_drafts_user_idx
  on public.course_assignment_drafts (user_id);

drop trigger if exists touch_course_assignment_drafts on public.course_assignment_drafts;
create trigger touch_course_assignment_drafts before update on public.course_assignment_drafts
  for each row execute procedure public.touch_updated_at();

alter table public.course_assignment_drafts enable row level security;

-- The owner only. Deliberately no has_permission / is_staff clause: a draft is
-- private until the student submits it.
drop policy if exists "course_assignment_drafts own read" on public.course_assignment_drafts;
create policy "course_assignment_drafts own read" on public.course_assignment_drafts
  for select using (user_id = auth.uid());

revoke insert, update, delete on public.course_assignment_drafts from anon, authenticated;

-- ----------------------------------------------------------------------------
-- save_course_assignment_draft(user, assignment, body, link, base_version)
--
-- base_version is the version the caller's text was typed on top of: 0 when
-- it saw no draft (creates one), otherwise the version it last saved or
-- loaded (replaces exactly that one). Returns one jsonb object:
--
--   {"outcome": "saved",     "version": n, "saved_at": t}
--   {"outcome": "stale",     "version": n | null, "saved_at": t | null}
--                            a newer draft exists, or a submit from another
--                            tab cleared the one named; nothing written
--   {"outcome": "closed"}    not published, not open yet, or cohort not started
--   {"outcome": "forbidden"} not enrolled in its cohort / not targeted
--   {"outcome": "locked"}    the submission was reviewed or excused
--
-- A save whose version moved on but which holds exactly the text sent is
-- "saved", not "stale": that's this same save arriving twice (its first
-- answer was lost on a dropped connection, and the form retried), and
-- refusing it would stop autosave over a write that already happened.
--
-- The same rules as app/dashboard/assignments/actions.ts submitAssignment and
-- lib/pre-cohort.ts cohortHasStarted (today is the UTC date there too).
-- ----------------------------------------------------------------------------
create or replace function public.save_course_assignment_draft(
  p_user_id uuid,
  p_assignment_id uuid,
  p_body text,
  p_link_url text,
  p_base_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assignment public.course_assignments%rowtype;
  v_submission_status text;
  v_version integer;
  v_saved_at timestamptz;
  v_current public.course_assignment_drafts%rowtype;
begin
  if p_user_id is null or p_assignment_id is null then
    return jsonb_build_object('outcome', 'forbidden');
  end if;

  select * into v_assignment from public.course_assignments where id = p_assignment_id;
  if not found
     or v_assignment.status <> 'published'
     or (v_assignment.opens_at is not null and v_assignment.opens_at > now()) then
    return jsonb_build_object('outcome', 'closed');
  end if;

  if not exists (
       select 1 from public.enrollments e
       where e.user_id = p_user_id and e.cohort_id = v_assignment.cohort_id
     )
     or (
       v_assignment.audience = 'students'
       and not exists (
         select 1 from public.course_assignment_targets t
         where t.assignment_id = v_assignment.id and t.user_id = p_user_id
       )
     ) then
    return jsonb_build_object('outcome', 'forbidden');
  end if;

  if not exists (
    select 1 from public.cohorts c
    where c.id = v_assignment.cohort_id
      and (
        c.status in ('active', 'completed')
        or (c.starts_on is not null and c.starts_on <= (now() at time zone 'utc')::date)
      )
  ) then
    return jsonb_build_object('outcome', 'closed');
  end if;

  select s.status into v_submission_status
  from public.course_assignment_submissions s
  where s.assignment_id = v_assignment.id and s.user_id = p_user_id;
  if v_submission_status in ('reviewed', 'excused') then
    return jsonb_build_object('outcome', 'locked');
  end if;

  if coalesce(p_base_version, 0) <= 0 then
    -- First save from a tab that saw no draft. If one exists by now, it was
    -- written elsewhere after this tab loaded: don't overwrite it.
    insert into public.course_assignment_drafts (assignment_id, user_id, body, link_url)
    values (v_assignment.id, p_user_id, p_body, p_link_url)
    on conflict (assignment_id, user_id) do nothing
    returning version, updated_at into v_version, v_saved_at;
  else
    -- Compare-and-set: a concurrent save of the same version waits for this
    -- one, re-reads the row, no longer matches, and comes back stale. Saving
    -- over a cleared (submitted) row is a draft again.
    update public.course_assignment_drafts d
    set body = p_body,
        link_url = p_link_url,
        cleared_at = null,
        version = d.version + 1,
        updated_at = now()
    where d.assignment_id = v_assignment.id
      and d.user_id = p_user_id
      and d.version = p_base_version
    returning d.version, d.updated_at into v_version, v_saved_at;
  end if;

  if v_version is null then
    select * into v_current
    from public.course_assignment_drafts d
    where d.assignment_id = v_assignment.id and d.user_id = p_user_id;
    if found
       and v_current.cleared_at is null
       and v_current.body is not distinct from p_body
       and v_current.link_url is not distinct from p_link_url then
      return jsonb_build_object('outcome', 'saved', 'version', v_current.version, 'saved_at', v_current.updated_at);
    end if;
    return jsonb_build_object('outcome', 'stale', 'version', v_current.version, 'saved_at', v_current.updated_at);
  end if;

  return jsonb_build_object('outcome', 'saved', 'version', v_version, 'saved_at', v_saved_at);
end;
$$;

-- The server action passes the signed-in user's id, so a client must never be
-- able to call this with someone else's.
revoke execute on function public.save_course_assignment_draft(uuid, uuid, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.save_course_assignment_draft(uuid, uuid, text, text, integer)
  to service_role;

-- ----------------------------------------------------------------------------
-- clear_course_assignment_draft(user, assignment, up_to_version)
--
-- After a submit: empties the draft and bumps its version, but only if it is
-- no newer than up_to_version (what the submitting tab last saved, or saw and
-- chose to overwrite). A newer one was written in another tab since, isn't
-- the text just handed in, and is left alone. Returns
--
--   {"cleared": true,  "version": n}   cleared (or already clear, or no row:
--                                      version 0) — the next save names n
--   {"cleared": false, "version": n}   a newer draft exists; nothing changed
--
-- No access checks: it only ever empties the caller's own row, which the
-- submit that precedes it has just checked.
-- ----------------------------------------------------------------------------
create or replace function public.clear_course_assignment_draft(
  p_user_id uuid,
  p_assignment_id uuid,
  p_up_to_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version integer;
  v_cleared_at timestamptz;
begin
  update public.course_assignment_drafts d
  set body = null,
      link_url = null,
      cleared_at = now(),
      version = d.version + 1,
      updated_at = now()
  where d.assignment_id = p_assignment_id
    and d.user_id = p_user_id
    and d.version <= coalesce(p_up_to_version, 0)
    and d.cleared_at is null
  returning d.version into v_version;
  if v_version is not null then
    return jsonb_build_object('cleared', true, 'version', v_version);
  end if;

  select d.version, d.cleared_at into v_version, v_cleared_at
  from public.course_assignment_drafts d
  where d.assignment_id = p_assignment_id and d.user_id = p_user_id;
  if v_version is null then
    return jsonb_build_object('cleared', true, 'version', 0);
  end if;
  return jsonb_build_object(
    'cleared', v_cleared_at is not null and v_version <= coalesce(p_up_to_version, 0),
    'version', v_version
  );
end;
$$;

revoke execute on function public.clear_course_assignment_draft(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.clear_course_assignment_draft(uuid, uuid, integer)
  to service_role;

comment on table public.course_assignment_drafts is
  'Unsubmitted assignment work (0105). Owner-read only; writes via save_/clear_course_assignment_draft() from the service role.';

notify pgrst, 'reload schema';
