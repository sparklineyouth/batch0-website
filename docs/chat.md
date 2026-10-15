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
| `/admin/chat/reports/<id>` | One report: the reason, the message with every earlier version and file, the transcript around it (earlier versions included), and mute controls. |
| `/community-guidelines` | The rules, public: linked from the chat sidebar, the report dialog, the FAQ and the terms. |

`/chat` is top-level, not under `/dashboard`, for the same reason
`/notifications` is: every role has chat, and `/dashboard` is gated on
`student.dashboard`. Middleware treats it as signed-in only.

## Channels batch0 starts with

| Channel | Who reads it | Who posts |
| --- | --- | --- |
| `#announcements` | everyone let in | staff only |
| `#general`, `#wins`, `#help` | everyone let in | everyone who reads it |
| `#staff` | staff | staff. It also carries the **staff feed**: new applications, acceptances, enrollments, refunds (not waivers), pass requests and challenge entries, as system lines (`postStaffFeed`, `lib/chat-post.ts`). A line names the person and links to the admin page; it never carries an email, an amount or a refund reason, which stay behind those pages' own permissions (`lib/staff-feed.ts`). |
| one per cohort (`#fall-2026`) | that cohort's enrolled students, the mentors assigned to any of them, plus staff | everyone who reads it |
| one per team (`#team-acme`) | that team's members, the mentors assigned to any of them, plus staff | everyone who reads it |

Cohort and team channels are created by triggers when a cohort or team is
created, and backfilled by 0101. Channels batch0 made itself (`system_key`)
can be renamed, archived, made read-only or slowed down, but their audience
is fixed and they can't be deleted.

"Everyone let in" means a non-student role, or a student with an enrollment
or an accepted application. A fresh signup sees no channels. They can still
message the team.

Deleting a team or cohort doesn't take its channel along: a trigger in 0101
(`chat_keep_scoped_channels()`) first archives it and re-homes it as a staff
channel, history, revisions and reports intact. It stops being batch0's own
(no `system_key`), so staff can delete it later, once nothing in it was
reported. No channel with a report can be deleted (archive it):
`deleteChannel` refuses, and `chat_reports.channel_id` is `on delete
restrict`.

## Who can read what

Each rule is a pure function in **`lib/chat-access.ts`** and is
unit-tested. The read rule is mirrored in SQL by `chat_can_read()` in 0101,
and `lib/chat-migration-db.test.ts` runs both over the same people × channels
matrix, building each TypeScript viewer from the database rows the way
`getChatViewer()` does (vetting, teams, enrollments, mentor assignments) and
each channel's `reported` from its real reports. `getChatViewer()` itself
reads through the service role and isn't in that test.

- **Text channel:** its audience (everyone let in, a cohort, a team; `staff`
  and `members` audiences add nobody), plus staff, plus anyone with an
  explicit `chat_members` row. Staff can add anyone to any channel: people to
  a private (`members`) channel, a guest to a cohort's.
- **DM or group:** its members only. Staff have **no read path** until one of
  them reports it (a message, or the whole conversation). Reporting hands the
  whole conversation to staff, and the report dialog says so before anyone
  commits.
- **Staff** means `chat.manage` or the `*` wildcard. It replaced
  `discord.manage`, but 0101 does **not** move that grant across: Discord
  config was harmless, while `chat.manage` opens reported DMs. Grant it on
  purpose at `/admin/roles`.
- **Team and cohort channels** also open to every mentor assigned
  (`mentor_assignments`) to anyone on the team, or enrolled in the cohort —
  what the Discord sync used to grant for teams. `getChatViewer()` folds a
  mentor's mentees' teams and cohorts in on every read, so assigning,
  unassigning or moving a student needs no resync.
- **Reports** freeze who they're about (`chat_reports.party_ids`,
  `reportPartyIds()`, and a trigger in 0101 that only ever adds): the
  reported message's sender, every party to an earlier report on the same
  channel, and for a DM or group everyone in it and everyone who ever posted
  in it. A text channel's report is about its one message, not the room. A
  moderator that **any** report on a channel names never sees that channel's
  reports, can't resolve them, isn't belled about them, and gets no read path
  into the conversation through them (`channelReportsOpenTo()`, and the same
  `exists … and not exists …` in `chat_can_read()`): leaving the group, or a
  later report filed after they left, changes nothing. The `chat.report` audit
  row has no actor, so the audit log doesn't say who reported either. When
  every moderator is a party, the report becomes a confidential concern in
  Support instead (`escalateReport`), and the report action's result
  (`ReportOutcome`) says where it went.

All reads go through the service role (`lib/chat.ts`), with the viewer
checked explicitly, because every screen needs other people's names. RLS is the
backstop, and it's what Realtime applies. Emails never reach the browser:
a person is a name, a role label and two flags, and the #staff feed names
people without them. Names resolve only for people a message actually
involves (its mentions, sender, reactors, the reply's sender); any other
`<@id>` typed into a message shows as `@unknown`.

Reads that only look (the sidebar, a page of messages, messages by id,
members, pins, the unread count) are GET routes under `app/chat/api/`: JSON,
`cache-control: no-store`, the viewer from the session's signed claims (no
auth-server round trip), and never a 500. Next runs server actions one at a
time, so a poll there would hold up a send. Writes stay server actions,
checked against the auth server.

Search (the side panel) is a substring match over the channels the viewer
reads, backed by a trigram index on `chat_messages.body` that 0101 creates
where `pg_trgm` is installed.

## Safeguarding

Students are 13–18. What the FAQ, the privacy policy and
`/community-guidelines` promise is exactly what `conversationAllowed()`
enforces: a DM or group may not put a student with a non-staff adult (a
mentor, an investor, a custom non-staff role) unless a staff member is in it.
Mentors and students talk in team and cohort channels, which staff can read;
investors meet students in #general, #wins and #help. Students may message
each other, and staff, privately, and only a report opens those
conversations to anyone else: they are not monitored, and the copy says so.
`chat.manage` is what makes someone staff, so its description at
`/admin/roles` says it can message any student privately. The directory
doesn't offer people a viewer can't DM, and the admin people pages show
*Message* only where it would work (chat staff, or a non-student, never
yourself). An old DM carried over by 0101 that breaks the rule stays readable
but read-only, and says why.

## Posting

These are enforced in `app/chat/actions.ts`. No browser write path exists:
signed-in users get read policies only.

- **Blocks:** in a DM, neither side can send once either has blocked the
  other, and both keep the history. In channels and groups, a blocked
  person's messages collapse for the blocker. The blocked person is never told.
- **Read-only:** archived channels and staff-posting channels (except for
  staff), and a moderator reading a reported DM.
- **Slow mode:** per channel, 5 seconds to 1 hour. Staff are exempt.
- **Rate limits:** 30 messages/min, 30 edits/min, 10 new conversations/hour,
  60 reactions/min, 20 pins per 10 minutes, 10 reports/hour, 5 *Ask the
  team* flags/hour, 40 uploaded files/hour (files, not calls).
- **Mutes:** staff can mute someone from the report page or a message's menu
  (`mutePerson`, `chat_mutes`): for an hour, a day, a week or until lifted.
  A muted account can't post, react, pin, or start or change a conversation,
  except a DM with the team to ask about it, and the composer says "You
  can't post in chat right now." Staff are never muted.
- **Fines:** an account with a pending fine can only DM the team. Posting,
  editing, reacting (channels included), pinning and starting or changing a
  group are all locked elsewhere; reporting, blocking and leaving still work.
- **Mentions** are stored as `<@uuid>`. The server keeps only people who can
  read the channel, so a mention can't ping a stranger. `@everyone` / `@here`
  are staff-only, in text channels. The composer's picker answers from the
  people it already has, then asks `searchChannelPeople` (readers only, eight
  at most), so anyone in a big channel can be mentioned.
- **Replies** ping the replied-to message's sender, as a mention, when they
  can still read the channel and neither has blocked the other.
- **Ask the team for help:** any message in a text channel can be flagged
  with a one-line note (`flagForTeam`). Every other `chat.manage` holder gets
  a `chat_flagged` bell linking to the message: Discord's *Flag as Blocker*. In
  a DM or group, Report is the way to bring the team in.
- **Edits and deletes:** you can edit or delete your own messages, and staff
  can remove anyone's (that's logged) in a text channel, or as a moderator in
  a reported DM or group they're not in. Never in a conversation they're one
  side of: there they're a participant, not a moderator. A delete blanks the row in place, so
  Realtime carries it to every screen. What it said, and every version before
  an edit, goes to `chat_message_revisions`. No policy lets anyone but the
  service role read that table, and the report page shows it.

## Bells

`lib/chat-notify.ts`. In-app only, never email, and never the words: 0101's
trigger strips any `body` from the message bells. A title never names a
group or its members (`bellTitle()`: "<Sender> in a group chat"), and 0101's
notifications policy no longer lets admins read anyone else's chat bells.

- DMs and groups: every other member is notified by default.
- Channels: notified only when @mentioned (or on a staff @everyone), unless
  the person set the channel to *All messages*.
- Per channel: *All messages*, *Only @mentions*, or *Nothing* (mute).
- One bell per burst: none while an unread chat bell for that channel exists,
  and none while the person had it open in the last two minutes. Catching up
  clears the bells.
- An announcement cross-posted to chat bells nobody its own `announcement`
  bell already reached (`excludeBells`), with or without @everyone.

Types: `chat_dm`, `chat_mention`, `chat_message`, `chat_reported` (to
staff no report on that channel names), and `chat_flagged` (*Ask the team*,
to chat staff; the flagger's note is its body). All five are rows in the
notification settings (`lib/notification-importance.ts`).

Unread counts (`chat_unread()`) skip people you've blocked, and a text
channel you've never opened counts only its last 14 days. System lines
("Maya pinned a message.") never count, except in #staff, where the feed is
nothing but system lines: `chat_counts_as_message()` makes them count there
for the unread number, the channel's summary and the cursor `markRead`
clamps to, all three at once, so the feed shows up as new and can be read.

## Realtime

Only `chat_messages` is in the publication. The client subscribes for the
**open** channel only (`channel_id=eq.<id>`), and Realtime re-applies the read
policy to every row. Inserts and updates both arrive: reactions are folded
onto the message row by a trigger, and deletes are blanking updates. Every
other channel's unread count comes from the sidebar poll and the bell ping.

Presence (online dots, `chat-presence`) and typing (`chat-typing:<channel>`)
are **private** Realtime topics: 0101's `realtime.messages` policies let in
signed-in, let-in people for presence and the channel's readers for its
typing topic, to listen and to send. They carry a user id and nothing else;
in a DM or group, a typing event naming someone who isn't in it is ignored.
If a join is refused, presence and typing stay empty; chat works without
them.

A resync covers what Realtime can't deliver: on reconnect, when the tab comes
back, and every 30 seconds while visible, with the sidebar. The nav badge
reads `/chat/api/attention`: one shared poll a minute while visible, however
many badges are mounted, and again on a new chat bell.

## Attachments

These follow support attachments' flow (`lib/chat-files-rules.ts`), with the
same allow-list: images, PDFs, text and short video, up to 5 files of 10 MB
each. The file picker leaves HEIC out, so an iPhone hands over a JPEG, which
shows inline.

1. The server mints a one-shot upload URL for a path it builds:
   `<channel>/<uploader>/<uuid>-<name>`.
2. The browser uploads straight to the private `chat-files` bucket, which
   has no storage policy at all.
3. On send, every path is checked against the channel and the sender. The
   real size and type are read back from storage.
4. `/chat/files/<message>/<n>` re-checks access on every view (the redirect
   is `no-store`) and redirects to a 10-minute signed URL, minted per view
   and never put on the page. Images show inline; everything else downloads.

A file picked and never sent stays in the bucket until the daily sweep
(`/api/cron/chat-housekeeping`, `lib/chat-housekeeping.ts`) deletes it: only
paths the app builds, only after 24 hours, only when no message and no kept
revision points at it (`chat_files_in_use()`), and nothing at all when a read
fails or most old files look unreferenced.

Deleting an account (`deleteUserAccount`) first runs `purgeChatContentFor()`
(`lib/chat-purge.ts`): their messages are blanked, their earlier versions
deleted and their files removed from storage, staged ones included. Evidence
stays as it is: a reported message, and every message in a reported DM or
group. It's idempotent and throws on a failure, so the account is only
deleted once the purge has worked. The privacy policy says so.

## History carried over

0101 brings back the old direct messages (0089) as chat DMs with **the same
ids**. So `/messages?c=<id>`, an old bell, now redirects to that conversation
in chat (and `/notifications?c=<id>`, where browsers that cached the old
permanent `/messages` redirect land, forwards there too). Old
*Reported conversation* bells (`/admin/messages/<id>`) go to Support, where
0099 filed those reports. 0101 also brings the DMs' read cursors, blocks and
reports, and each team's old team thread (0011) as messages in its team
channel. Messages that were unsent arrive deleted, with their words in
revisions only. The old tables keep their rows, but their read policies are
gone: only the service role reads them now.

## Formatting

`lib/chat-format.ts` parses messages and `components/chat/markup.tsx` renders
them as React elements, never HTML:

- `**bold**`, `*italic*`, `~~strike~~`, `||spoiler||`, `` `code` ``
- ```` ``` ```` code blocks, `> ` quotes (with the space, as on Discord, so
  `>.<` stays an emoticon)
- auto-linked `http(s)` URLs, mentions
- jumbo emoji

Keyboard: Enter sends, Shift+Enter adds a newline (on a phone, Enter is a
newline and the Send button sends), ↑ edits your last message, Esc cancels a
reply, Ctrl/⌘+K opens the quick switcher. The message list is one Tab stop:
↑/↓, Page Up/Down, Home and End move between messages, Tab goes into one for
its actions, Esc goes back to the composer. On a touch screen, tap a message
for its actions; a long press opens More.

## Code map

| File | What |
| --- | --- |
| `supabase/migrations/0101_chat.sql` | Schema, policies, predicates, triggers, seeds, history carry-over, Discord teardown |
| `lib/chat-access.ts` | Every rule, pure |
| `lib/chat-format.ts` / `lib/chat-view.ts` | Markup, mentions, previews; message layout and merge helpers, pure |
| `lib/chat.ts` | Service-role reads |
| `lib/chat-payload.ts` | One channel's on-screen state, shared by the page and the actions |
| `lib/chat-notify.ts` / `lib/chat-post.ts` / `lib/chat-files.ts` | Bells; posting from elsewhere (announcements, the staff feed); attachments |
| `lib/staff-feed.ts` | The #staff feed's lines: a name and an admin link, nothing else |
| `lib/chat-purge.ts` | What account deletion takes out of chat, and the evidence it keeps |
| `lib/chat-housekeeping.ts` / `app/api/cron/chat-housekeeping` | The daily sweep of uploads nobody sent |
| `app/chat/actions.ts` / `app/chat/manage-actions.ts` | Every chat write; channel management, reports and mutes |
| `app/chat/api/*` | The read-only GET routes |
| `components/chat/*` | The UI |

Tests:

- `lib/chat-access.test.ts`, `lib/chat-format.test.ts`, `lib/chat-view.test.ts`,
  `lib/chat-files-rules.test.ts` (the attachment path grammar and the
  staged-file checks), `lib/chat-housekeeping.test.ts` (the sweep, against an
  in-memory bucket), `components/chat/live-rows.test.ts` (applying Realtime
  rows on the client)
- `lib/chat-migration-db.test.ts`: real Postgres via PGlite, with policies
  run as a signed-in user, then triggers, carry-over, the Discord teardown
  and idempotency.
- `lib/staff-feed.test.ts`, `lib/announcement-chat.test.ts`,
  `lib/account-deletion.test.ts`: what the feed says, what an announcement
  hands chat, and that deleting an account purges its chat first.
- `lib/legal-pages.test.ts` pins the privacy policy's and the FAQ's chat
  sentences to the rules above.

## Deploying

Run **0101** in the Supabase SQL editor after the deploy (see
`docs/migrations-2026-10.md`). Until then `/chat` says chat isn't set up yet,
the nav badge stays at zero, and announcement cross-posts report that they
couldn't post. Nothing returns a 500. 0101 drops the Discord tables and
columns, and **that can't be undone**, so take a backup first if you want the
old Discord ids. If 0099 ever runs after 0101, run 0101 again: 0099 rewrites
lesson copy back to Discord.

When the deploy goes live, **lock the Discord server**. The code no longer
manages it: nobody is kicked or loses a role there when they leave the
program, change role or have their account deleted, and deleting the bot or
the application removes no member, role or channel. Post a pointer to
`/chat`, then take away the student and mentor roles' (and `@everyone`'s)
permission to view channels, or delete the server. Until it's locked, remove
anyone you take out of the program from it by hand. Then delete the Discord
application and bot in the Discord Developer Portal and remove the
`DISCORD_*` variables from Vercel.
