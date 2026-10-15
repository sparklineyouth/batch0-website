# batch0 Chat

batch0's community runs inside the site at **`/chat`**. It replaced the Discord
server in October 2026 (migration 0101). Everything is one model: a text
**channel**, a one-to-one **DM**, or a **group DM**. There are no voice channels
and no categories.

| Surface | What |
| --- | --- |
| `/chat` | The app: channels and conversations on the left, the open one in the middle, members / pins / search on the right. One pane at a time on a phone. In every role's nav, with an unread badge. |
| `/chat?c=<id>` | Open a channel, DM or group (where chat bells link). Add `&m=<message>` to open around one message and flash it. |
| `/chat?to=<user>` | Open a DM with someone. It's a draft until the first message. |
| `/chat?team=<team>` | A team's channel (the Team page's "Team chat" chip). |
| `/admin/chat` | Channels (create, edit, archive, delete, extra members) and the report queue. Needs `chat.manage`. |
| `/admin/chat/reports/<id>` | One report: the reason, the message with every earlier version, and the transcript. |

`/chat` is top-level, not under `/dashboard`, for the same reason
`/notifications` is: every role has chat, and `/dashboard` is gated on
`student.dashboard`. Middleware treats it as signed-in only.

## Channels batch0 starts with

| Channel | Who reads it | Who posts |
| --- | --- | --- |
| `#announcements` | everyone let in | staff only |
| `#general`, `#wins`, `#help` | everyone let in | everyone who reads it |
| `#staff` | staff | staff. It also carries the **staff feed**: new applications, acceptances, refunds and waivers, pass requests and challenge entries, as system lines (`postStaffFeed`, `lib/chat-post.ts`). |
| one per cohort (`#fall-2026`) | that cohort's enrolled students, plus staff | everyone who reads it |
| one per team (`#team-acme`) | that team's members, plus staff | everyone who reads it |

Cohort and team channels are created by triggers when a cohort or team is
created, and backfilled by 0101. Channels batch0 made itself (`system_key`)
can be renamed, archived, made read-only or slowed down, but their audience
is fixed and they can't be deleted.

"Everyone let in" means a non-student role, or a student with an enrollment
or an accepted application. A fresh signup sees no channels. They can still
message the team.

## Who can read what

Each rule is a pure function in **`lib/chat-access.ts`** and is
unit-tested. The read rule is mirrored in SQL by `chat_can_read()` in 0101,
and `lib/chat-migration-db.test.ts` runs both over the same people × channels
matrix so they can't drift.

- **Text channel:** its audience (everyone let in, a cohort, a team; `staff`
  and `members` audiences add nobody), plus staff, plus anyone with an
  explicit `chat_members` row. Staff can add a mentor to a cohort channel, or
  people to a private (`members`) channel.
- **DM or group:** its members only. Staff have **no read path** until one of
  them reports it. Reporting hands the whole conversation to staff, and the
  report dialog says so before anyone commits.
- **Staff** means `chat.manage` or the `*` wildcard. It replaced
  `discord.manage`, and 0101 moved the grant across.

All reads go through the service role (`lib/chat.ts`), with the viewer
checked explicitly, because every screen needs other people's names. RLS is the
backstop, and it's what Realtime applies. Emails never reach the browser:
a person is a name, a role label and two flags.

## Safeguarding

Students are 13–18, and the FAQ promises there are no unmonitored private
channels between students and adults. `conversationAllowed()` enforces it.
A DM or group may not put a student with a non-staff adult (a mentor, an
investor, a custom non-staff role) unless a staff member is in it. Mentors
and students talk in team and cohort channels, which staff can read. The
directory doesn't offer people a viewer can't DM. An old DM carried over by
0101 that breaks the rule stays readable but read-only, and says why.

## Posting

These are enforced in `app/chat/actions.ts`. No browser write path exists:
signed-in users get read policies only.

- **Blocks:** in a DM, neither side can send once either has blocked the
  other, and both keep the history. In channels and groups, a blocked
  person's messages collapse for the blocker. The blocked person is never told.
- **Read-only:** archived channels and staff-posting channels (except for
  staff), and a moderator reading a reported DM.
- **Slow mode:** per channel, 5 seconds to 1 hour. Staff are exempt.
- **Rate limits:** 30 messages/min, 10 new conversations/hour, 60
  reactions/min, 10 reports/hour, 40 uploads/hour.
- **Fines:** an account with a pending fine can only DM the team.
- **Mentions** are stored as `<@uuid>`. The server keeps only people who can
  read the channel, so a mention can't ping a stranger. `@everyone` / `@here`
  are staff-only, in text channels.
- **Edits and deletes:** you can edit or delete your own messages, and staff
  can remove anyone's (that's logged). A delete blanks the row in place, so
  Realtime carries it to every screen. What it said, and every version before
  an edit, goes to `chat_message_revisions`. No policy lets anyone but the
  service role read that table, and the report page shows it.

## Bells

`lib/chat-notify.ts`. In-app only, never email, and never the words: admins
can read every notification row, so 0101's trigger strips any `body` from
chat types.

- DMs and groups: every other member is notified by default.
- Channels: notified only when @mentioned (or on a staff @everyone), unless
  the person set the channel to *All messages*.
- Per channel: *All messages*, *Only @mentions*, or *Nothing* (mute).
- One bell per burst: none while an unread chat bell for that channel exists,
  and none while the person had it open in the last two minutes. Catching up
  clears the bells.

Types: `chat_dm`, `chat_mention`, `chat_message`, and `chat_reported` (to
staff who aren't in the reported conversation).

## Realtime

Only `chat_messages` is in the publication. The client subscribes with a
`channel_id=in.(…)` filter naming the channels the server already cleared it
for, chunked at Realtime's 100-value cap, and Realtime re-applies the read
policy to every row. Inserts and updates both arrive: reactions are folded
onto the message row by a trigger, and deletes are blanking updates.
Presence (online dots) and typing indicators use broadcast topics like the
live rooms do. They carry a user id and nothing else.

A resync covers what Realtime can't deliver: on reconnect, when the tab comes
back, and every 20 seconds while visible. The sidebar refreshes every 30
seconds and whenever a chat bell lands.

## Attachments

These follow support attachments' flow (`lib/chat-files-rules.ts`), with the
same allow-list: images, PDFs, text and short video, up to 5 files of 10 MB
each.

1. The server mints a one-shot upload URL for a path it builds:
   `<channel>/<uploader>/<uuid>-<name>`.
2. The browser uploads straight to the private `chat-files` bucket, which
   has no storage policy at all.
3. On send, every path is checked against the channel and the sender. The
   real size and type are read back from storage.
4. `/chat/files/<message>/<n>` re-checks access on every view and redirects
   to a 10-minute URL. Images show inline; everything else downloads.

## History carried over

0101 brings back the old direct messages (0089) as chat DMs with **the same
ids**. So `/messages?c=<id>`, an old bell, now redirects to that conversation
in chat. It also brings their read cursors, blocks and reports, and each
team's old team thread (0011) as messages in its team channel. Messages
that were unsent arrive deleted, with their words in revisions only.

## Formatting

`lib/chat-format.ts` parses messages and `components/chat/markup.tsx` renders
them as React elements, never HTML:

- `**bold**`, `*italic*`, `~~strike~~`, `||spoiler||`, `` `code` ``
- ```` ``` ```` code blocks, `>` quotes
- auto-linked `http(s)` URLs, mentions
- jumbo emoji

Keyboard: Enter sends, Shift+Enter adds a newline, ↑ edits your last message,
Esc cancels a reply, Ctrl/⌘+K opens the quick switcher.

## Code map

| File | What |
| --- | --- |
| `supabase/migrations/0101_chat.sql` | Schema, policies, predicates, triggers, seeds, history carry-over, Discord teardown |
| `lib/chat-access.ts` | Every rule, pure |
| `lib/chat-format.ts` / `lib/chat-view.ts` | Markup, mentions, previews; message layout and merge helpers, pure |
| `lib/chat.ts` | Service-role reads |
| `lib/chat-payload.ts` | One channel's on-screen state, shared by the page and the actions |
| `lib/chat-notify.ts` / `lib/chat-post.ts` / `lib/chat-files.ts` | Bells; posting from elsewhere (announcements, the staff feed); attachments |
| `app/chat/actions.ts` / `app/chat/manage-actions.ts` | Every chat write; channel management and reports |
| `components/chat/*` | The UI |

Tests:

- `lib/chat-access.test.ts`, `lib/chat-format.test.ts`, `lib/chat-view.test.ts`
- `lib/chat-migration-db.test.ts`: real Postgres via PGlite, with policies
  run as a signed-in user, then triggers, carry-over, the Discord teardown
  and idempotency.

## Deploying

Run **0101** in the Supabase SQL editor after the deploy (see
`docs/migrations-2026-10.md`). Until then `/chat` says chat isn't set up yet,
the nav badge stays at zero, and announcement cross-posts report that they
couldn't post. Nothing returns a 500. 0101 drops the Discord tables and
columns, and **that can't be undone**, so take a backup first if you want the
old Discord ids.

After it runs, delete the Discord application and bot in the Discord
Developer Portal, remove the `DISCORD_*` variables from Vercel, and point
people at `/chat`.
