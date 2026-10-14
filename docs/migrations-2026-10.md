# Migrations 0093–0100 (October 2026)

Run these after the code deploys, in number order, in the Supabase SQL editor:
paste the whole file and run it.

- **Safe to re-run.** Every file is idempotent (`if not exists`,
  `create or replace`, `drop policy if exists`, guarded data moves). Running
  one twice changes nothing.
- **The app works before they run.** Code that reads a new table or column
  treats "does not exist" as "not set up yet" (`lib/schema-ready.ts`): the
  feature shows an empty state, nothing returns a 500.
- **Nothing is dropped.** Retired features keep their tables and rows; only
  policies, grants and defaults change.
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
| 0098 | `0098_events.sql` | Event writes need `events.manage`; "Everyone signed in" events are no longer readable without signing in. New events default to chat on and auto-record. |
| 0099 | `0099_retire_community.sql` | Discussions, team thread, reactions, lesson comments and DMs lose client write policies. Open private questions and open DM reports move into Support. |
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
