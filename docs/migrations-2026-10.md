# Migrations 0093–0105 (October 2026)

**Fastest:** `npm run db:migrate -- --apply` (SETUP.md §2). It runs exactly the
files below that the database is missing, in order, each in one transaction
checked against its verify query, backing up first. It holds 0101 back until
the Chat code is live in production (0101 drops columns the previous code
reads), runs everything before it, and exits with code 3 so you know to run it
again after the deploy. The verify queries at the end of this page are the
ones it uses (`lib/migration-plan.ts`; a test keeps the two identical).

By hand: run each file in the Supabase SQL editor: paste the whole file and run it.
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
2. **Right after the deploy is live: 0093, 0094, 0097, 0098, 0099, 0100,
   0101**, in that order. Treat them as part of the deploy, not a follow-up: finish
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
   - 0101: there is no community at all until it runs — `/chat` says chat
     isn't set up yet, the Discord integration is already gone from the code,
     and announcement cross-posts report that they couldn't post. Run it
     after 0099: it rewrites the lesson sentences 0099 wrote. **If 0099 ever
     runs after 0101, run 0101 again**, or those lessons say "Discord" again.
     (The DM reports can't end up in two queues either way: 0101 files each
     one it carries as closed when 0099 already moved it to Support, and
     otherwise marks the old report handled, so a later 0099 has nothing to
     move.)
   - The Discord server itself: the deploy stops managing it (nothing kicks
     people or strips their roles any more), and deleting the bot or the app
     removes nobody. Lock it when the deploy goes live (`docs/chat.md`,
     *Deploying*).
3. **Any time: 0102.** It only swaps `email_outbox`'s partial dedupe index
   for a plain one, and no code depends on which runs first. Until it runs,
   every scheduled email automation fans out to nobody: the insert fails with
   42P10 (the notifications bug 0090 §9 fixed, on the outbox) and the run is
   recorded as an error on the automation.
4. **Any time after 0093: 0105.** It only adds the drafts table and its
   two functions; nothing reads or writes them until it runs. Until then
   assignment forms work as before, without autosave (the page reads the
   missing table as "not set up yet", and Submit never touches it).

- **Safe to re-run.** Every file is idempotent (`if not exists`,
  `create or replace`, `drop policy if exists`, guarded data moves). Running
  one again changes nothing, even after the app is in use: 0093 seeds Fall's
  assignments only on its first complete run, so a re-run doesn't bring back
  one an admin deleted, and 0101 carries the old DMs and team threads into
  Chat only once (the `chat_history_carried` setting), so a re-run can't bring
  back what an account deletion or a moderator removed. A database that ran
  an earlier draft of 0101 fails 0101's verify query (it checks the newest
  pieces too), so `npm run db:migrate -- --apply` runs it again there.
- **The app works before they run.** Code that reads a new table or column
  treats "does not exist" as "not set up yet" (`lib/schema-ready.ts`): the
  feature shows an empty state, nothing returns a 500.
- **0093–0100 drop no tables or columns**, and retired features keep their
  tables and rows. **0101 does drop** the Discord integration's tables
  (`discord_auto_*`, `oh_queue`, `mentor_oncall`, `team_blockers`,
  `event_rsvps`), the `discord_*` columns on `profiles` and `teams`, and the
  `discord*` site settings — that part can't be undone, so back up first if
  you want them. All of these files **change data**, not only policies,
  grants and defaults (each change is guarded, so a re-run changes nothing).
  Take a backup first if you may want the old wording back:
  - 0093 rewrites check-in wording to "weekly update" / Assignments in
    lesson titles and descriptions, the stored `cohort.next_steps` and
    `cohort.week3` emails, the mentor role's description and the Fall Demo
    Day event. It repoints old check-in, Pulse, at-risk and cohort-health
    notification links, and marks unread check-in and at-risk notifications
    read. It disables the `cohort.checkin_reminder` email, every automation
    step that sends it, and any automation left with no enabled step. It
    seeds Fall's weeks 5–9 and Demo Day assignments, and copies check-ins
    already posted for those weeks (with mentor replies) in as submissions.
    Roles lose `pulse.view` and `interventions.manage`; an intern role that
    runs the course gains `assignments.manage`.
  - 0094 repairs pitch video links that aren't https; one it can't repair is
    cleared and kept in the team's notes as "Video link: …". Lesson and
    notification links to the Files page point at the team's Drive tab.
  - 0097 repoints old office-hours notification links to 1:1 calls.
  - 0099 removes `discussions.manage` from roles, takes DMs off realtime,
    turns open private questions and open DM reports into Support tickets,
    and rewrites lesson text that sent students to Discussions, office hours
    or the check-in.
  - 0100 removes `ai_usage.view` from roles and **deletes** leftover
    founder-pass self-check rows (`batch = 'selftest'`, negative serials;
    never real passes).
  - 0101 creates batch0 Chat and its starting channels (one per cohort and
    team), copies the old DMs (same ids), their read state, blocks and
    reports, and every team thread into Chat, removes `discord.manage`
    (**not** converted: grant `chat.manage` at `/admin/roles` to whoever runs
    Chat, since it opens reported DMs), drops the Discord schema above, and
    rewrites the lesson sentences, the one stored email and the saved kickoff
    checklist rows that sent students to Discord. DM reports 0099 already
    moved to Support arrive closed (decided once, when carried, so a report
    staff reopen stays open after a re-run); one still open in the old table
    is marked handled there, since Chat now has it. Blocks are copied once (a
    `chat_blocks_carried` setting), so a re-run never undoes an unblock. The
    old DM and team-thread tables keep their rows but lose every policy:
    only the service role reads them now. Unread old "messaged you" bells
    are marked read (Chat counts those DMs itself), old Discord blocker bells
    lose their dead discord.com links, and admins can no longer read other
    people's chat bells (the `notifications` read policy is replaced).
- **Don't roll back past this deploy once 0093, 0099, 0100 or 0101 has
  run.** The previous code writes check-ins (0093), lesson comments and
  announcement reactions (0099) as the signed-in user, and those write
  policies are gone: posting would fail with a permission error. Roles also
  lose the pulse, interventions (0093), discussions (0099) and AI-usage (0100)
  permissions its pages need. 0101 drops the Discord columns and tables the
  previous code selects by name: its admin person pages 404 (they read
  `profiles.discord_username`), its every-minute Discord cron fails, and
  Discord linking can't save. Fix forward instead. Before any of them has
  run, rolling back is safe.
- People with `settings.manage` see one line on `/admin`, *Database update
  needed: run migrations 0093–0101*, while a probe finds one missing
  (`lib/pending-migrations.ts`, cached 5 minutes). It checks the new tables and
  columns of 0093–0096 and 0101, and the retired permission keys 0099, 0100
  and 0101 strip from roles. The policy changes in 0097–0099 are invisible to it: the line
  going away does not prove those ran, so run the verify queries below.

| # | File | What it does |
|---|------|--------------|
| 0093 | `0093_assignments.sql` | Assignment tracker tables (`course_assignments`, `course_assignment_targets`, `course_assignment_submissions`), read-only to clients. Check-ins go read-only, the check-in reminder is disabled, and the running Fall cohort gets weeks 5–9 plus Demo Day (check-ins already posted for those weeks carry over as submissions). Check-in wording in lessons, two stored emails and the Fall Demo Day event becomes "weekly update"; old notification links are repointed. |
| 0094 | `0094_google_drive.sql` | `team_drive_links` (a team's Drive folder and pinned files) and `pitch_submissions.deck_url`. Pitch links must be https: existing video links are repaired, or moved into the team's notes. The old in-app file stores freeze read-only, and links to the Files page point at the Drive tab. |
| 0095 | `0095_recordings.sql` | `recording_sessions` (one continuous file per take), `recording_mint_part()`, and the private `recordings` bucket (16 MB parts, WebM/MP4). |
| 0096 | `0096_live_stage.sql` | `events.live_primary_host_id`: the webinar host everyone sees on the main stage. |
| 0097 | `0097_calls.sql` | 1:1 calls, 1:1 requests and office hours lose client write policies; writes go through server actions. Old office-hours links point at 1:1 calls. |
| 0098 | `0098_events.sql` | Event writes need `events.manage`; "Everyone signed in" events are no longer readable without signing in. New events default to chat on and auto-record (the admin form starts "Everyone signed in" events moderated). |
| 0099 | `0099_retire_community.sql` | Discussions, team thread, reactions, lesson comments and DMs lose client write policies. Open private questions and open DM reports move into Support. Lessons that sent students to Discussions, office hours or the check-in point at Discord, Support and 1:1 calls. |
| 0100 | `0100_admin_cleanup.sql` | Removes the retired `ai_usage.view` permission from roles and deletes leftover founder-pass self-check rows (negative serials). |
| 0101 | `0101_chat.sql` | batch0 Chat: channels, DMs and group DMs (`chat_*` tables including `chat_mutes`, read-only policies, `chat_can_read()`, realtime on `chat_messages`, private presence and typing topics on `realtime.messages`, a trigram index for search, the private `chat-files` bucket), the starting channels plus one per cohort and team (kept, archived, when their team or cohort is deleted), old DMs and team threads carried in, `discord.manage` removed (not converted), admins kept out of other people's chat bells, and the Discord integration's tables, columns and settings dropped. See `docs/chat.md`. |
| 0102 | `0102_email_outbox_dedupe_index.sql` | `email_outbox.dedupe_key` gets a plain unique index in place of 0052's partial one, so the scheduled-automation fan-out's `on conflict (dedupe_key)` works. Changes no data and sends nothing by itself. |
| 0105 | `0105_assignment_drafts.sql` | `course_assignment_drafts`: a student's private, autosaved unsubmitted assignment work, readable by its owner only (no staff policy), with a version that only goes up (a submit empties the row instead of deleting it). `save_course_assignment_draft()` re-checks access on every save and refuses one from a tab holding an older version; `clear_course_assignment_draft()` empties it after a submit. Both service role only. Adds only; changes no existing data. |

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

-- 0101
select to_regclass('public.chat_channels') is not null
   and to_regclass('public.chat_message_revisions') is not null
   and exists (select 1 from public.chat_channels where system_key = 'general')
   and not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'profiles'
                     and column_name like 'discord%')
   and not exists (select 1 from public.app_roles
                   where permissions @> array['discord.manage']::text[])
   and exists (select 1 from pg_publication_tables
               where pubname = 'supabase_realtime' and tablename = 'chat_messages')
   -- The newest pieces, so a database that ran an earlier draft of 0101
   -- reads as not done, and gets 0101 again (it's idempotent).
   and to_regclass('public.chat_mutes') is not null
   and to_regprocedure('public.chat_files_in_use(text[])') is not null
   and to_regprocedure('public.chat_counts_as_message(text, text)') is not null
   and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'chat_reports')
   and exists (select 1 from public.site_settings where key = 'chat_history_carried') as ok;

-- 0102
select exists (select 1 from pg_index ix
               join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = ix.indkey[0]
               where ix.indrelid = to_regclass('public.email_outbox')
                 and ix.indisunique and ix.indpred is null and ix.indnkeyatts = 1
                 and a.attname = 'dedupe_key') as ok;

-- 0105
select to_regclass('public.course_assignment_drafts') is not null
   and to_regprocedure('public.save_course_assignment_draft(uuid, uuid, text, text, integer)') is not null
   and to_regprocedure('public.clear_course_assignment_draft(uuid, uuid, integer)') is not null
   -- By oid: NULL (not an error) when a function doesn't exist yet.
   and not has_function_privilege('authenticated',
         to_regprocedure('public.save_course_assignment_draft(uuid, uuid, text, text, integer)'), 'execute')
   and not has_function_privilege('authenticated',
         to_regprocedure('public.clear_course_assignment_draft(uuid, uuid, integer)'), 'execute') as ok;
```

Background for each change: `docs/assignments.md`, `docs/google-drive.md`,
`docs/recording.md`, `docs/batch0-live.md`, `docs/calls.md`,
`docs/webinars.md`, `docs/chat.md`, `docs/admin.md`.
