# Migrations 0093–0100 (October 2026)

Run each file in the Supabase SQL editor: paste the whole file and run it.
**The order matters more than usual**, because the deploy removes the old
check-ins, in-app files, discussions and the old recorder at once:

1. **Before the deploy (or together with it): 0095, then 0096.** Both only
   add things (0095: the `recording_sessions` table with its policies and
   functions, and the private `recordings` bucket; 0096: one column on
   `events`). The code in production today never
   touches them, and neither needs 0093 or 0094. Without 0095 **nothing
   records**: the deploy removes the old two-minute recorder, so a webinar or
   1:1 held between the deploy and 0095 is not recorded at all, and that can't
   be fixed afterwards. (The rooms say so to hosts instead of claiming to
   record.)
2. **Right after the deploy is live: 0093, 0094, 0097, 0098, 0099, 0100**, in
   that order. Treat them as part of the deploy, not a follow-up: finish
   before the next weekly due date (Sundays 23:59 New York time; week 5 is
   due Sunday, October 18) and before the next scheduled webinar or call.
   Nothing returns a 500 in between, but until each file runs its part of the
   site is switched off:
   - 0093: students can't submit weekly updates (Assignments says "not set up
     yet"); Fall's weeks 5–9 and Demo Day don't exist yet.
   - 0094: no deck links on pitch submissions; the Google Drive panel says
     "not set up yet".
   - 0097: the old call policies still let a student rewrite their own call
     row. The app already ignores a call whose host is a student, but close
     the hole.
   - 0099: open DM reports (a safeguarding queue) and private questions still
     waiting on the team show nowhere until 0099 moves them into Support, and
     Week 1 lessons still point at Discussions and office hours.

- **Safe to re-run.** Every file is idempotent (`if not exists`,
  `create or replace`, `drop policy if exists`, guarded data moves). Running
  one again changes nothing, even after the app is in use: 0093 seeds Fall's
  assignments only on its first complete run, so a re-run doesn't bring back
  one an admin deleted.
- **The app works before they run.** Code that reads a new table or column
  treats "does not exist" as "not set up yet" (`lib/schema-ready.ts`): the
  feature shows an empty state, nothing returns a 500.
- **Nothing is dropped.** Retired features keep their tables and rows; only
  policies, grants and defaults change.
- **Don't roll back past this deploy once 0093, 0099 or 0100 has run.** The
  previous code writes check-ins (0093), lesson comments and announcement
  reactions (0099) as the signed-in user, and those write policies are gone:
  posting would fail with a permission error. Roles also lose the pulse,
  interventions (0093), discussions (0099) and AI-usage (0100) permissions
  its pages need. No data is lost. Fix forward instead. Before any of them
  has run, rolling back is safe.
- People with `settings.manage` see one line on `/admin`, *Database update
  needed: run migrations 0093–0100*, while a probe finds one missing
  (`lib/pending-migrations.ts`, cached 5 minutes). It checks the new tables and
  columns of 0093–0096, and the retired permission keys 0099 and 0100 strip
  from roles. The policy changes in 0097–0099 are invisible to it: the line
  going away does not prove those ran, so run the verify queries below.

| # | File | What it does |
|---|------|--------------|
| 0093 | `0093_assignments.sql` | Assignment tracker tables (`course_assignments`, `course_assignment_targets`, `course_assignment_submissions`), read-only to clients. Check-ins go read-only, the check-in reminder is disabled, and the running Fall cohort gets weeks 5–9 plus Demo Day. |
| 0094 | `0094_google_drive.sql` | `team_drive_links` (a team's Drive folder and pinned files) and `pitch_submissions.deck_url`. Pitch links must be https. The old in-app file stores freeze read-only. |
| 0095 | `0095_recordings.sql` | `recording_sessions` (one continuous file per take), `recording_mint_part()`, and the private `recordings` bucket (16 MB parts, WebM/MP4). |
| 0096 | `0096_live_stage.sql` | `events.live_primary_host_id`: the webinar host everyone sees on the main stage. |
| 0097 | `0097_calls.sql` | 1:1 calls, 1:1 requests and office hours lose client write policies; writes go through server actions. Old office-hours links point at 1:1 calls. |
| 0098 | `0098_events.sql` | Event writes need `events.manage`; "Everyone signed in" events are no longer readable without signing in. New events default to chat on and auto-record (the admin form starts "Everyone signed in" events moderated). |
| 0099 | `0099_retire_community.sql` | Discussions, team thread, reactions, lesson comments and DMs lose client write policies. Open private questions and open DM reports move into Support. Lessons that sent students to Discussions, office hours or the check-in point at Discord, Support and 1:1 calls. |
| 0100 | `0100_admin_cleanup.sql` | Removes the retired `ai_usage.view` permission from roles and leftover founder-pass self-check rows. |

## Verify

Each query returns one row, `ok = true`, once its migration has run.

```sql
-- 0093
select to_regclass('public.course_assignments') is not null
   and to_regclass('public.course_assignment_targets') is not null
   and to_regclass('public.course_assignment_submissions') is not null as ok;

-- 0094
select to_regclass('public.team_drive_links') is not null
   and exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'pitch_submissions'
                 and column_name = 'deck_url') as ok;

-- 0095
select (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'recording_sessions'
          and column_name in ('end_reason', 'finalize_attempts')) = 2
   and exists (select 1 from storage.buckets
               where id = 'recordings' and file_size_limit = 16777216) as ok;

-- 0096
select exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'events'
                 and column_name = 'live_primary_host_id') as ok;

-- 0097
select count(*) = 0 as ok from pg_policies
where schemaname = 'public'
  and tablename in ('call_invites', 'interview_requests', 'mentor_bookings', 'mentor_slots')
  and cmd <> 'SELECT';

-- 0098
select exists (select 1 from pg_policies
               where schemaname = 'public' and tablename = 'events'
                 and policyname = 'events staff write'
                 and qual like '%events.manage%') as ok;

-- 0099
select count(*) = 0 as ok from pg_policies
where schemaname = 'public'
  and tablename in ('discussion_threads', 'discussion_replies', 'team_messages',
                    'announcement_reactions', 'lesson_comments')
  and cmd <> 'SELECT';

-- 0100
select count(*) = 0 as ok from public.app_roles
where permissions @> array['ai_usage.view']::text[];
```

Background for each change: `docs/assignments.md`, `docs/google-drive.md`,
`docs/recording.md`, `docs/batch0-live.md`, `docs/calls.md`,
`docs/webinars.md`, `docs/discord.md`, `docs/admin.md`.
