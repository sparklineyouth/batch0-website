# Discord

Discord is batch0's community: cohort chat, team channels, voice, wins. The
site links accounts, syncs roles, provisions team channels (the team page links
to its own), cross-posts announcements and answers slash commands. It does not
run its own chat or post to #wins; bootstrap/repair still create #wins.

## Admin: `/admin/discord` (`discord.manage`)

- The page reads only the database. **Run check** calls Discord on demand:
  the doctor (`lib/discord-doctor.ts`: token, app id, OAuth redirect URIs,
  public key, interactions endpoint, guild, bot permissions and role order,
  configured channel/role ids, command sync, invite link) plus link stats.
- **Register slash commands** pushes `SLASH_COMMANDS` (`lib/discord.ts`). It is
  a PUT that replaces the whole set, so **press it after any deploy that adds
  or removes a command** — until then Discord keeps showing the old list and
  removed commands answer "Unknown command".
- Repair recreates missing channels/roles and never deletes; Bootstrap wipes
  and rebuilds the server.

## Slash commands

`/me /link /cohort /events /sync /help /whois /team /ask /start /queue
/oncall` and the "Flag as Blocker" message action. Handler:
`app/api/discord/interactions/route.ts` (signature-verified, configured guild
only, rate-limited per user).

`/events` and `/team` read with the service role, so they filter events like
the `events read` policy would (`lib/student-event-filter.ts`): public events
plus `enrolled` events of the caller's cohorts. Staff-only events never show.
Public means "Everyone signed in", so a Discord member who never linked a
batch0 account gets "Link your account first" instead of a list.

## Retired (October 2026)

Discord already does these, so the in-app copies were removed:

| Feature | Tables (kept) | Old links |
|---|---|---|
| Discussions + "Ask the team" | `discussion_threads`, `discussion_replies` | `/dashboard/discussions/*` → Support |
| Direct messages + chat dock | `dm_conversations`, `dm_messages`, `dm_blocks`, `dm_reports` | `/messages` → `/notifications` |
| Team thread | `team_messages` | — |
| Announcement reactions | `announcement_reactions` | — |
| Lesson comments | `lesson_comments` | — |
| `/announce` (use `/admin/announcements`) | — | — |
| `/checkin`, #wins cross-posts | `student_checkins` | — |
| Event RSVP buttons | `event_rsvps` | old buttons link to `/dashboard/events` |

Migration 0099 drops the client write policies on the discussion, team
thread, reaction and lesson-comment tables (read policies stay), removes
`discussions.manage` from roles, and takes `dm_messages` out of realtime.
Private questions go to Support (`topic=program`).

### Open items at deploy

The code removes the "Questions awaiting reply" and "Reported DMs" queues;
0099 moves what they still held into `/admin/support`:

- a private question still waiting on the team → a `program` ticket from its
  author, the thread so far as the body;
- an open DM report → a sensitive `concern` ticket from the reporter, the
  conversation as a staff-only note (unsent messages included).

No email goes out; reply from the ticket. Re-running 0099 adds nothing.
Between the deploy and 0099 these items show nowhere, so run 0099 right after
the deploy. To see what will move:

```sql
select id, author_id, title, created_at from discussion_threads
  where visibility = 'admin' and needs_reply;
select id, conversation_id, reporter_id, reason, created_at from dm_reports
  where status = 'open';
```

Old `team_message`, `direct_message`, `discussion_*` and `dm_reported` bells
stay in Notifications under "Everything else"
(`RETIRED_NOTIFICATION_KINDS` in `lib/notification-importance.ts`). Staff
bells for the two queues (`/admin/discussions/…`, `/admin/messages/…`) open
`/admin/support`; a student's `/dashboard/discussions/new` opens a new
support request.
