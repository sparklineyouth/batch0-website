# Migrations 0093–0107 (October 2026)

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
4. **Right after its deploy: 0103.** It only adds a function and two
   triggers, and changes no data. Until it runs, "Move to a different
   cohort" on a person's profile refuses with "needs database migration
   0103" (the old move could leave a student with no enrollment, so the new
   code doesn't fall back to it), and "at least one full admin" is enforced
   by the app alone, not by the database.
5. **Any time after 0101: 0104.** It adds `chat_messages.client_id` and a
   unique `(sender_id, client_id)`, so a Chat message is sent once however
   many times it's retried. The code works without it: until it runs, a
   send whose answer is lost can still be posted twice by Retry, and the
   failed bubble stays beside the message that went through until it's
   discarded. It also indexes deleted messages for *Report a deleted
   message*, which works without the index, just less directly.
   **If 0101 ever runs again after 0104, run 0104 again**: 0101
   re-grants the message columns it knows by name, which takes away
   `client_id`'s (0104's verify query notices).
6. **Any time after 0093: 0105.** It only adds the drafts table and its
   two functions; nothing reads or writes them until it runs. Until then
   assignment forms work as before, without autosave (the page reads the
   missing table as "not set up yet", and Submit never touches it).
7. **Any time: 0106.** Texting's tables (`docs/sms.md`). It only creates new
   tables and touches nothing that exists. Until it runs, `/dashboard/phone`
   collects a number with no texting checkbox and the Texting admin pages say
   texting isn't set up; after it runs, texting is still inert until someone
   saves a sending number and credentials at `/admin/sms/settings`.

8. **Any time: 0107.** It only adds the `student_followups` table (no client
   policies, no data changes). Until it runs, Student progress says
   "Follow-ups aren't set up yet", the Overview's attention list leaves
   follow-ups out, and `settings.manage` holders see "run migration 0107" on
   the Overview; everything else on both pages works.

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
  needed: run migration(s) …* naming the ones missing, while a probe finds one
  (`lib/pending-migrations.ts`, cached 5 minutes). It checks the new tables and
  columns of 0093–0096, 0101 and 0107, and the retired permission keys 0099, 0100
  and 0101 strip from roles. The policy changes in 0097–0099 are invisible to it: the line
  going away does not prove those ran, so run the verify queries below.

| # | File | What it does |
|---|------|--------------|
| 0078 | `0078_event_display_viewer_count.sql` | Not part of this release: September's webinar "shown attendees" count (`events.display_viewer_count`), renamed out of 0071 (*Versions* below). Production has the column and its check but not the column comment, so its verify query fails there until the file runs; Supabase's GitHub integration runs it when it reaches `main`. |
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
| 0103 | `0103_admin_integrity.sql` | `admin_move_student_cohort()` (service role only): moving a student to another cohort is one transaction — their enrollment (kept even without an application), the application it belongs to and their live scholarship rows move together, or nothing does; picking the cohort a student paid for while they're enrolled nowhere puts that enrollment back. Triggers `keep_a_full_admin` (on `profiles`) and `keep_a_full_admin_role` (on `app_roles`) refuse any change that would leave nobody holding a `*` role, serialised so two admins can't demote each other at once. Changes no data. |
| 0104 | `0104_chat_client_ids.sql` | `chat_messages.client_id` (the composer's id for a message, kept by every Retry), unique per sender, readable by signed-in readers so Realtime's echo carries it: a resend of a message that went through gets the original back instead of posting it twice. Plus a partial index on deleted messages, `(channel_id, deleted_at desc, id desc)`, for *Report a deleted message*. Changes no data. See `docs/chat.md`. |
| 0105 | `0105_assignment_drafts.sql` | `course_assignment_drafts`: a student's private, autosaved unsubmitted assignment work, readable by its owner only (no staff policy), with a version that only goes up (a submit empties the row instead of deleting it). `save_course_assignment_draft()` re-checks access on every save and refuses one from a tab holding an older version; `clear_course_assignment_draft()` empties it after a submit. Both service role only. Adds only; changes no existing data. |
| 0106 | `0106_sms_messaging.sql` | Texting: `messaging_consent` (consent per number, no promotional consent on a student's number), the append-only `messaging_consent_log`, `sms_outbox`, `sms_campaigns`, `sms_events`, and the `sms_settings` singleton seeded with no credentials. Service-role only (RLS on, no policies, no grants). Creates only new tables, changes no data, and sends nothing: texting stays off until a number and credentials are saved. See `docs/sms.md`. |
| 0107 | `0107_student_followups.sql` | `student_followups`: who on the team owns a check on a student, the next check date and a factual note (one open per student), written from the drawer on `/admin/progress` and due ones listed in the Overview's attention list. RLS on with no policies, every API privilege revoked. Changes no data and sends nothing. |

## Verify

Each query returns one row, `ok = true`, once its migration has run.

```sql
-- 0078
select exists (select 1 from pg_attribute a
               where a.attrelid = to_regclass('public.events')
                 and a.attname = 'display_viewer_count' and not a.attisdropped
                 and col_description(a.attrelid, a.attnum) is not null)
   and exists (select 1 from pg_constraint
               where conrelid = to_regclass('public.events')
                 and conname = 'events_display_viewer_count_check') as ok;

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

-- 0103
select to_regprocedure('public.admin_move_student_cohort(uuid, uuid, uuid)') is not null
   and exists (select 1 from pg_trigger
               where tgrelid = to_regclass('public.profiles') and tgname = 'keep_a_full_admin')
   and exists (select 1 from pg_trigger
               where tgrelid = to_regclass('public.app_roles') and tgname = 'keep_a_full_admin_role') as ok;

-- 0104
select exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'chat_messages'
                 and column_name = 'client_id')
   and exists (select 1 from pg_constraint
               where conrelid = to_regclass('public.chat_messages')
                 and conname = 'chat_messages_sender_id_client_id_key' and contype = 'u')
   -- Readers may select it (Realtime's echo carries it); re-running 0101 takes that away.
   and exists (select 1 from information_schema.column_privileges
               where table_schema = 'public' and table_name = 'chat_messages'
                 and column_name = 'client_id' and grantee = 'authenticated'
                 and privilege_type = 'SELECT')
   and to_regclass('public.chat_messages_channel_deleted_idx') is not null as ok;

-- 0105
select to_regclass('public.course_assignment_drafts') is not null
   and to_regprocedure('public.save_course_assignment_draft(uuid, uuid, text, text, integer)') is not null
   and to_regprocedure('public.clear_course_assignment_draft(uuid, uuid, integer)') is not null
   -- By oid: NULL (not an error) when a function doesn't exist yet.
   and not has_function_privilege('authenticated',
         to_regprocedure('public.save_course_assignment_draft(uuid, uuid, text, text, integer)'), 'execute')
   and not has_function_privilege('authenticated',
         to_regprocedure('public.clear_course_assignment_draft(uuid, uuid, integer)'), 'execute') as ok;

-- 0106
select to_regclass('public.messaging_consent') is not null
   and to_regclass('public.messaging_consent_log') is not null
   and to_regclass('public.sms_outbox') is not null
   and to_regclass('public.sms_events') is not null
   and exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'sms_campaigns'
                 and column_name = 'client_key')
   and exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'messaging_consent'
                 and column_name = 'opted_out_by')
   and exists (select 1 from pg_trigger
               where tgname = 'messaging_consent_log_no_update'
                 and tgrelid = to_regclass('public.messaging_consent_log'))
   and exists (select 1 from public.sms_settings where id) as ok;

-- 0107
select to_regclass('public.student_followups') is not null
   and exists (select 1 from pg_indexes
               where schemaname = 'public' and tablename = 'student_followups'
                 and indexname = 'student_followups_one_open_idx')
   and (select relrowsecurity from pg_class
        where oid = to_regclass('public.student_followups')) as ok;
```

Background for each change: `docs/assignments.md`, `docs/google-drive.md`,
`docs/recording.md`, `docs/batch0-live.md`, `docs/calls.md`,
`docs/webinars.md`, `docs/chat.md`, `docs/admin.md`.

## Versions

A file's version is the four digits before its first `_`. The Supabase CLI
(`supabase db push`, `supabase migration repair`) and Supabase's GitHub
integration key a file by its version and record it in
`supabase_migrations.schema_migrations`, whose primary key is the version.
Three rules follow from that.

- **No two files share a version.** From 2026-09-20 two files were 0071
  (`0071_scholarships.sql` and the webinar viewer count). The second one's
  history INSERT fails and rolls the file back: `supabase db push` refused
  (it wanted `--include-all`, which then fails that way), and the Supabase
  check failed on every push to `main`. Scholarships kept 0071: production's
  history row for 0071 is that file, and 0072 has to run after it. The viewer
  count, which only needs `public.events`, is now
  `0078_event_display_viewer_count.sql`, renamed with its SQL unchanged.
  Production has its column and check (added by hand in September) but not
  its column comment, so 0078 still runs there rather than only being
  recorded: the integration runs it when the rename reaches `main` (the first
  two statements find their work done, the comment is added) and records it.
  Don't also `supabase migration repair --status applied 0078`: that records
  the comment as applied without adding it, and a repair that commits while
  the integration is running 0078 fails the integration's history INSERT
  (23505), which turns the check red again. Afterwards, `supabase migration
  list --linked` shows 0078 under both Local and Remote, and the 0078 verify
  query above returns `ok`.
- **A version is recorded in production only once its file is on `main`.**
  On every push to `main` the integration first compares production's
  history with `main`'s files, and a version production has recorded but
  `main` has no file for stops it there, before it runs anything: "Remote
  migration versions not found in local migrations directory" (on
  2026-09-26 that was 0085 and 0086, recorded from a branch). Until the file
  lands, every push to `main` fails the check and applies nothing, not even
  other new files. So never `supabase migration repair --status applied` a
  branch's file before it merges. To get a file live before its code deploys
  (an expand step), merge it in a pull request of its own, which the
  integration applies; or run it by hand without recording it (`supabase db
  query --linked -f …`), and the integration runs it again when it reaches
  `main` (every file is idempotent) and records it then. `npm run db:migrate`
  does the same on its own: it runs a pending file that isn't on
  `origin/main` yet but leaves it unrecorded, and refuses `--mark-applied`
  for one.
- **A new file takes a number neither `main` nor an open pull request
  uses.** Two branches that each take the next free number both pass their
  checks and both merge, and on the second merge the integration fails that
  file's history INSERT: rolled back, so its schema never reaches production
  while Vercel deploys its code. CI's *Migration versions* step
  (`npm run check:migration-versions`) fails a pull request whose new file
  has a version that `main`, or another open pull request, already holds,
  read from GitHub when the step runs, so whichever of the pair runs its
  checks second fails. It can't see a file pushed straight to `main`, or a
  pull request merged while red; re-run the *check* job before merging a
  migration if other migration pull requests merged since its checks ran.
  Requiring branches to be up to date before merging (branch protection)
  would close the rest; it isn't on.

How it's enforced: `npm test` fails when two files share a version or when
name order and number order disagree (`lib/migration-plan.test.ts`);
`npm run db:migrate` refuses to plan with a shared version; and
`npm run test:migrations-replay-db` (in CI) replays every file onto an empty
database the way the CLI does (its statement splitter, its order, its
history rows), and plays production's history through the integration.

**Supabase's GitHub integration applies migrations to production.** On every
push to `main` it runs the CLI against the production project (the *Supabase
Preview* check), files numbered below the newest recorded one included. The
shared 0071 stopped it at `0071_scholarships.sql` every time (rolled back, so
nothing changed). With every version unique, it applies any file production
hasn't recorded as soon as that file reaches `main`, typically before Vercel
has finished deploying the code. An additive file is fine there (the code
treats a missing table or column as "not set up yet"). A file that removes
what the live code reads (a contract step like 0088, or 0101) must reach
`main` only once that code is live, in a pull request of its own. Since the
integration applies a file itself, the step after merging one is to wait for
the merge commit's *Supabase Preview* check and then run the file's verify
query. Don't record it by hand meanwhile (`migration repair`, or
`npm run db:migrate -- --apply`): a record that commits while the
integration is running that file fails the integration's history INSERT
(23505) and turns the check red, though nothing is lost. To keep applying
everything by hand instead, turn the integration's production deploys off in
Supabase → Project Settings → Integrations → GitHub.
`docs/webinars.md`, `docs/chat.md`, `docs/admin.md`, `docs/sms.md`.
