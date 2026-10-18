# batch0 Chat

batch0's community runs inside the site at **`/chat`**. It replaced the Discord
server in October 2026 (migration 0101). Everything is one model: a text
**channel**, a one-to-one **DM**, or a **group DM**. There are no voice channels
and no categories.

| Surface | What |
| --- | --- |
| `/chat` | The app: channels and conversations on the left, the open one in the middle, members / pins / search / a thread / #help's Unanswered list on the right. One pane at a time on a phone. In every role's nav, with an unread badge. |
| `/chat?c=<id>` | Open a channel, DM or group (where chat bells link). Add `&m=<message>` to open around one message and flash it (a thread reply opens its thread at it). Add `&thread=<message>` to open that message's thread in the side pane (where thread bells link). |
| `/chat?ask=lesson:<id>` | "Ask about this" from a lesson or assignment page (`assignment:<id>`), on the web or the installed app's assignment screen: #help, with the item linked in the composer when the viewer can open it. |
| `/chat?to=<user>` | Open a DM with someone. It's a draft until the first message. |
| `/chat?team=<team>` | A team's channel (the Team page's "Team chat" chip). |
| `/admin/chat` | Channels (create, edit, archive, delete, extra members) and the report queue. Needs `chat.manage`. |
| `/admin/chat/reports/<id>` | One report: the reason, the message with every earlier version and file, the transcript around it (earlier versions included; thread replies indented and marked with the message they answer), and mute controls. |
| `/community-guidelines` | The rules, public: linked from the chat sidebar, the report dialog, the FAQ and the terms. |

`/chat` is top-level, not under `/dashboard`, for the same reason
`/notifications` is: every role has chat, and `/dashboard` is gated on
`student.dashboard`. Middleware treats it as signed-in only.

## Channels batch0 starts with

| Channel | Who reads it | Who posts |
| --- | --- | --- |
| `#announcements` | everyone let in | staff only |
| `#general`, `#wins`, `#help` | everyone let in | everyone who reads it |
| `#staff` | staff | staff. It also carries the **staff feed**: new applications, acceptances, enrollments, refunds (not waivers), pass requests and challenge entries, as system lines (`postStaffFeed`, `lib/chat-post.ts`). A line names the person and links to the admin page; it never carries an email, an amount or a refund reason, which stay behind those pages' own permissions (`lib/staff-feed.ts`). Enrollments and refunds post once, from whichever path records them first: the checkout webhook, the daily Stripe reconcile, an admin refund, or a refund made in the Stripe dashboard. |
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
  `reportPartyIds()`, and a trigger in 0101 that only ever adds). A
  text-channel report is about its one message: its sender, nobody else. A
  DM's or group's report is about everyone in it, everyone who ever posted
  in it, the reported sender, and every party to an earlier report on it.
  - A moderator a report names never sees it, can't resolve it and isn't
    belled about it. For a DM or group that holds across all of its reports:
    a moderator **any** of them names sees none of them and gets no read path
    into the conversation through them (`channelReportsOpenTo()`, and the
    same `exists … and not exists …` in `chat_can_read()`), so leaving the
    group, or a later report filed after they left, changes nothing.
  - A text-channel report stands alone (`reportScope()`): staff read every
    text channel anyway, and judging them together would let anyone bury a
    report with a throwaway one on a moderator's message. Staff can't be
    added to a group that has a report (`addToGroup`), which closes the
    group version of the same trick.
  - Reports are service-role only: no RLS policy, not even for the reporter
    (a row's `party_ids` would say who else was reported). Who removed or
    pinned a message (`deleted_by`, `pinned_by`) isn't selectable by readers
    either, so Realtime doesn't send it.
  - The `chat.report` audit row has no actor, so the audit log doesn't say
    who reported either.
  - When **every** moderator is a party, nobody on the team is shown the
    report at all, not even as a Support ticket: every full admin can open
    every Support ticket, and every full admin moderates chat, so all of
    them are parties. The report stays saved for the first moderator who
    isn't a party, and the reporter is told exactly that and pointed outside
    batch0: the independent safeguarding contact when
    `SAFEGUARDING_CONTACT_EMAIL` is set, a trusted adult, and emergency
    services (`ReportOutcome` `outside`, `outsideReportAdvice()`).

All reads go through the service role (`lib/chat.ts`), with the viewer
checked explicitly, because every screen needs other people's names. RLS is the
backstop, and it's what Realtime applies. The read policies are for signed-in
users only (anonymous requests get nothing, and no message columns at all),
and the big tables (messages, members, reactions) ask whether a row's channel
is in the viewer's readable set (`chat_viewer_channel_ids()`, the same rule
as `chat_can_read()` worked out once per statement): an unfiltered request
over 300k messages costs ~40 ms, not a function call per row (~4.5 s). Emails never reach the browser:
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
doesn't offer people the rule would refuse: for a DM it asks about the pair;
for a group (*New message* once someone is picked, or *Add people* in a
group) about the whole group with each candidate in it (`directoryOffers()`,
`searchDirectory(…, group)`), so with someone from the team in it a student
also finds the mentor it may hold. `createGroup` and `addToGroup` ask the
same question of the whole group again before anything is written, and the
dialog says why a pick leaves a group or DM it would refuse, in the words the
server would use (`pickRefusal()`: one pick is a DM). When the rule alone
left someone matching out, the search says so (`withheld`), and only then
does the picker add "To add a mentor, pick someone from the batch0 team
first" (`withheldHint()`), never under a search that found nobody for another
reason. The admin people
pages show *Message* only where it would work (chat staff, or a non-student,
never yourself). An old DM carried over by 0101 that breaks the rule stays readable
but read-only, and says why.

## Posting

These are enforced in `app/chat/actions.ts`. No browser write path exists:
signed-in users get read policies only.

- **Once, however often it's retried:** the composer gives every message an
  id of its own (`client_id`, migration 0104) and every Retry sends it again.
  A send whose answer was lost after the row committed gets the original
  back (`sendMessage` asks `findSentMessage` before slow mode or the rate
  limit could refuse it, and once more when one of them does, for a Retry
  racing the first send; `unique (sender_id, client_id)` settles two at
  once). A replay asks for the message's bells again, which reaches only
  someone the first request didn't bell (see Bells), so a first request
  that died before ringing them doesn't cost the message its bells. The
  sending screen drops its bubble when the server's copy
  arrives by that id, through the answer, the Realtime echo or a resync
  (`settledBy()` in `lib/chat-view.ts`). Two messages meant twice, word for
  word, have two ids. Before 0104 runs, sends work as before and nothing is
  replayed (`lib/chat-send.ts` checks for the column once a minute).
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
  A muted account can't post, react (`ChannelInfo.canReact` hides reactions
  for it, as for a fined one), pin, or start or change a conversation,
  except a DM with the team to ask about it, and the composer says "You
  can't post in chat right now." Staff are never muted. A mute also holds
  for an announcement's chat copy: the announcement itself still goes out,
  and the composer reports the mute as why it didn't reach chat.
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
  a `chat_flagged` bell linking to the message: Discord's *Flag as Blocker*.
  With 0110 it also files the thread's one help request in Support (see
  *Threads*). In a DM or group, Report is the way to bring the team in.
- **Edits and deletes:** you can edit or delete your own messages, and staff
  can remove anyone's (that's logged) in a text channel, or as a moderator in
  a reported DM or group they're not in. Never in a conversation they're one
  side of: there they're a participant, not a moderator. A delete blanks the row in place, so
  Realtime carries it to every screen. What it said, and every version before
  an edit, goes to `chat_message_revisions`. No policy lets anyone but the
  service role read that table, and the report page shows it.
- **Reporting what was deleted:** history and search leave deleted messages
  out, and only a DM or group can be reported whole, so a text channel's
  menu has *Report a deleted message* (and a reply's "Original message was
  deleted" quote has *Report it*). It lists what was deleted there in the
  last two weeks, however long ago it was posted, most recently deleted
  first, as stubs: who and when, never a word or a file, never your own, and
  not whether the sender or a moderator removed it (`listDeletedForReport`,
  `fetchDeletedMessages`). It pages on `(deleted_at, id)` with *Show older*,
  so fifty junk messages deleted after the one that matters only push it to
  the next page (0104 indexes deleted rows for this). The one picked is
  reported like any message: about its sender, with its earlier versions on
  the report page for the moderators that leaves out, so a moderator who
  posted and deleted it never sees the report. A reporter who isn't a
  moderator never sees the words again. A moderator who files one reviews it
  on the report page like any report they file, and the dialog says so; the
  report names them as its reporter to the rest of the team, which is the
  record of who looked. (No audit row names a reporter: a moderator the
  report is about may read the audit log.)

## Threads and #help's questions

Migration 0110. A message in a **text channel** can start a thread: one
level (a reply can't start its own), in the side pane where members, pins
and search open — a column beside the channel from lg up, a drawer over it
on a tablet, and the whole screen on a phone with Back, the channel mounted
underneath so it's exactly where it was. Under the message the feed shows
"4 replies · 3h" (and a question's state); the replies themselves never
enter the feed. DMs and groups have no threads.

- **Shape, enforced in SQL.** A reply is a `chat_messages` row with
  `thread_root_id`: authorship, edits and revisions, deletes, files,
  reactions, reports and the read policy are the message model's. A
  reply's root is a live person's message, not a reply, in the reply's own
  channel: a `(thread_root_id, channel_id)` foreign key onto `(id,
  channel_id)` and a guard trigger refuse anything else, whoever writes.
  The server checks the same first, in words (`threadRootVerdict`), and a
  quote stays where it's written: a thread quotes its own messages, the feed
  its own (`quoteVerdict`). A reply can't @everyone, and can't be pinned.
- **Access.** A thread grants nothing. Its replies, its count, a search hit
  in it, its files and its bells are all read through its channel's rule:
  `GET /chat/api/thread` checks the channel (`openChannelFor`), then that
  the root is a feed message in it. Following a thread you can no longer
  read rings nothing (bells re-check readers).
- **Not channel messages.** Replies move no channel summary, unread or
  mention count, or read cursor (0110 replaces `chat_unread()` and
  `chat_messages_touch_channel()` with "and not a thread reply"). A mention
  in a reply is a bell to the thread, not a badge on the channel.
- **Reading.** The newest page of replies, then older ones on the feed's
  `(created_at, id)` keyset (`listThreadReplies`), so replies sharing a
  timestamp are neither skipped nor repeated. Live, the open channel's one
  Realtime subscription hands a reply to the pane by its `thread_root_id`
  (granted to readers for exactly this) over a small bus, and bumps the
  root's count once per reply (`bumpThread`). A question settled or a help
  request worked on another screen arrives live too, as a stamp on the
  root (0112, see *Realtime*): the feed's copy of the root, the pane
  showing it and #help's Unanswered count and list read it again. The pane
  reconciles with the newest page every 30 seconds and on a reconnect, and
  the page's deleted set keeps a stale page from bringing a deleted reply
  back. A send carries
  its client id (0104): a Retry is the same reply. A reply still sending, or
  one that failed, is kept by its root outside the pane
  (`components/chat/thread-outbox.ts`): Back on a phone or opening another
  thread mid-send loses nothing, the feed says "A reply didn't send" under
  the root, and the reply is waiting with its Retry when the thread opens.
- **Follows and bells.** The root's author and everyone who replies follow
  by default (a trigger); unfollowing sticks — replying again doesn't undo
  it. A reply bells its followers (`chat_thread`) and the people it
  @mentions (`chat_mention`), never a channel's *All messages* list and
  never everyone, so a busy thread rings a handful of people, not a cohort
  (`notifyThreadReply`, `threadBellRecipients`). Per person: still a
  reader, no block of the sender, the channel not muted (*Nothing*), and
  one bell per burst (none while an unread one for the thread is up, none
  while they had the pane open in the last two minutes — the pane says
  "still here" once a minute and takes the thread's bells down). One bell
  per message by the same dedupe key as a channel bell, and none for a
  reply that isn't fresh (`bellFresh`): history carried in rings nobody.
- **Questions.** In #help every top-level post from someone outside the
  team is an open question the moment it's in (a trigger, so every insert
  path agrees; quotes aren't questions). The asker or chat staff
  (`canDecideQuestion`) can accept a reply as the answer, mark it answered
  without one, reopen it, say it isn't a question, or make a post one
  (`setQuestion`, `questionTransition`), each against the state the screen
  showed, so a second person's change is never silently overwritten. The
  accepted answer must be a live reply in that thread (checked again by
  trigger). Deleting it reopens the question in the delete's own
  statement; deleting the question retires it. Every transition, by whom,
  is in the append-only `chat_thread_events`, written by trigger.
- **Unanswered.** #help's header has an Unanswered button with the count:
  its open questions, waiting longest first, in the side pane
  (`/chat/api/unanswered`, `lib/chat-questions.ts`). The count moves when a
  question is settled in the pane, when one arrives live, when one is
  settled on someone else's screen (0112: an open list reads itself again),
  and on the 30-second resync (#help's newest page carries it). A question
  from someone the viewer blocked is listed without its words, and its thread
  shows it collapsed with "show", as the feed does. The admin Overview's
  *Unanswered questions* (`chat.manage`) reads the same count, lists the
  oldest as rows that open their thread, and leaves out only a question
  whose help request is in Support's *Needs reply* queue (status `open`),
  for someone who sees Support's rows: that's a Support row already. One the
  team has answered in Support (waiting on the asker) is in no queue, so it
  stays a row here (`questionLeftToSupport`).
- **Ask the team.** Pressing it on a message (or in the thread's header)
  files ONE help request per thread in Support (`lib/chat-help.ts`): a
  program ticket with the asker as requester, their note and a link to the
  thread, never a word of the thread itself (Support is readable by people
  who may not read that channel). Its owner and open/handled state are the
  ticket's, worked in Support like any request; the thread shows them (live
  from 0112: a ticket picked up, answered or resolved stamps the thread's
  root), and links the asker to their request and the team to the ticket.
  Asking again while it's in the team's queue adds a team-only note to the
  same ticket.
  One the team answered (waiting on the asker) or resolved goes back in the
  queue — open, needing a reply, its reply clock from this ask, as a
  requester's follow-up would — with the note; the thread says "The team
  replied: over to you" (or "waiting on the asker") while it waits. A closed
  one is final and a new one takes the thread. Two people asking at once end
  on one ticket. The reference is shown only to whoever filed the request
  and the team (`helpReferenceFor`): someone else asking is told the team
  heard them. It's never confidential: safeguarding stays with Report,
  which the dialog points to.
- **Ask about this.** A lesson or assignment page links to
  `/chat?ask=lesson:<id>`: the web's lesson and assignment pages, and the
  installed app's assignment screen (`app/app/(student)/assignments/[id]`;
  the app has no lesson screen, its course list opens the web lesson
  page). The message it sends stores the item's id on its thread (never a
  title, never anything the student wrote for it), and each
  viewer's chip is resolved through their OWN database client
  (`lib/chat-about.ts`): someone who reads #help but not that item sees no
  chip at all. The sender must be able to open it too. The chip shows under
  any top-level message that carries one — a question, a staff post, a
  quote-reply, a question someone unmarked — with or without replies.
- **Before 0110** (`threadsReady()`, asked once a minute): no thread
  buttons, question states or Unanswered list; the feed, sends, search and
  *Ask the team* (bell only, no ticket) work as before.

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
- One bell per message, however often it's asked for: each carries
  `chat-message:<message id>` as its dedupe key, so the notifications index
  drops a second one for the same person. A replayed send asks again with
  the message's `postedAt`, which also skips anyone whose read cursor is
  already past it.
- An announcement cross-posted to chat bells nobody its own `announcement`
  bell already reached (`excludeBells`), with or without @everyone. One too
  long for a single message is posted whole, as consecutive messages split
  between paragraphs (`lib/chat-post-split.ts`, code blocks kept intact), with
  @everyone and the bell on the first only.

Types: `chat_dm`, `chat_mention`, `chat_message`, `chat_thread` (a reply in
a thread you follow, 0110), `chat_reported` (to staff no report on that
channel names), and `chat_flagged` (*Ask the team*, to chat staff; the
flagger's note is its body). All six are rows in the notification settings
(`lib/notification-importance.ts`).

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
onto the message row by a trigger, and deletes are blanking updates. A thread
reply (`thread_root_id` set) goes to the thread pane, not the feed. Every
other channel's unread count comes from the sidebar poll and the bell ping.

A thread's question and help request (0112) ride the same subscription.
`chat_threads` and `support_tickets` aren't in the publication: the first
holds a help request's ticket and the course item a question links to,
which no reader may see, and a second subscription would fail wherever the
table isn't published. Instead triggers set `chat_messages.thread_changed_at`
on the root when the question's state or accepted answer changes, or its
help request is linked, unlinked, or changes status or owner in Support, so
Realtime sends the root's readers an UPDATE like an edit's. It's a hint, not
the change: the client reads the thread again through the GET routes, which
check the channel and the root as always (the root by id for the feed, the
pane if it shows that thread, #help's Unanswered list), spread over a second
or so since everyone in the channel heard it at once. Every UPDATE of a root
carries its stamp, so it counts only when Realtime's commit time says that
commit wrote it (`threadStampNews()`, the database's clock on both sides),
once per stamp. Never for a reply's count (its INSERT already arrives) or
the course item (a stamp right after a post would tell #help it links
something); a deleted root isn't stamped, and one another transaction is
writing is skipped rather than waited for (the 30-second resync catches it).

Presence (online dots, `chat-presence`) and typing (`chat-typing:<channel>`)
are **private** Realtime topics: 0101's `realtime.messages` policies let in
signed-in, let-in people for presence and the channel's readers for its
typing topic, to listen and to send. They carry a user id and nothing else;
in a DM or group, a typing event naming someone who isn't in it is ignored.
If a join is refused, presence and typing stay empty; chat works without
them.

They are **hints, not facts**. Realtime authorizes who may join a topic,
not what a sender puts in the payload, so a let-in user could claim to be
someone else's dot or "typing…". The client narrows it (a DM's or group's
typing must come from a member; a text channel's from someone it already
knows reads there), and nothing ever trusts either: no access, no unread
count, no bell and no record depends on presence or typing.

A resync covers what Realtime can't deliver: on reconnect, when the tab comes
back, and every 30 seconds while visible, with the sidebar. The nav badge
reads `/chat/api/attention`: one shared poll a minute while visible, however
many badges are mounted, again on a new chat bell, and always on the first
badge to mount on a page (coming back from `/chat`, the count is fresh).

Reading: the read cursor moves only while the window has focus and you're at
the bottom of the conversation. The once-a-minute "still here" stamp that
holds back bells for the conversation you have open is sent whenever the tab
is visible, focused or not, so a conversation open on a second screen
doesn't ring.

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
(`lib/chat-purge.ts`):

- Their Chat messages are blanked, their earlier versions deleted and their
  files removed from storage, staged ones included.
- Their direct messages from before Chat (`dm_messages`, unsent ones too)
  are deleted outright; 0089's trigger recomputes each old conversation's
  preview from what's left. Their old team-thread posts (`team_messages`) go
  with the profile (the foreign key cascades); the Chat copies are blanked as
  above.
- Evidence stays as it is: a reported message, and every message in a
  reported DM or group, including an old DM reported before Chat
  (`dm_reports`) or in it.

It's idempotent and throws on a failure, so the account is only deleted once
the purge has worked, and 0101 carries history only once, so a re-run can't
bring anything back. The privacy policy says so.

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
its actions, Esc goes back to the composer. A message's links, mentions,
files, reactions and avatar join the Tab order only while focus is inside
that message. On a touch screen, tap a message for its actions; a long press
opens More.

## Code map

| File | What |
| --- | --- |
| `supabase/migrations/0101_chat.sql` | Schema, policies, predicates, triggers, seeds, history carry-over, Discord teardown |
| `lib/chat-access.ts` | Every rule, pure |
| `lib/chat-format.ts` / `lib/chat-view.ts` | Markup, mentions, previews; message layout and merge helpers, pure |
| `lib/chat.ts` | Service-role reads |
| `lib/chat-send.ts` | Inserting a message once per client id, and finding the one a retry already sent (0104) |
| `supabase/migrations/0110_chat_threads.sql` | Threads, #help's questions, follows and the question audit trail |
| `supabase/migrations/0112_chat_thread_live.sql` | The stamp on a thread's root that carries its question and help request changes over Realtime |
| `lib/chat-threads-rules.ts` | Threads' rules, pure: where a reply hangs, questions, counting, who a reply bells, the help request's plan |
| `lib/chat-thread-rows.ts` / `lib/chat-threads.ts` / `lib/chat-questions.ts` | Is 0110 there, and the thread rows for a page; a thread for one viewer, follows, question writes; the read-only Unanswered lists |
| `lib/chat-help.ts` / `lib/chat-about.ts` | A thread's one Support help request; a question's course item, per viewer |
| `components/chat/thread-panel.tsx` / `thread-bus.ts` | The thread pane; how it hears the open channel's Realtime |
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
  rows on the client), `lib/chat-post-split.test.ts` and `lib/chat-post.test.ts`
  (long posts split whole, mutes, rollback), `lib/chat-purge.test.ts` (what
  an account deletion removes and keeps), `lib/chat-server.test.ts` (bulk
  bell clearing, mention search ranking, the sidebar's mention counts, the
  directory for a group against a DM's and its `withheld`, deleted-message
  stubs and their paging, one bell per message),
  `lib/chat-actions.test.ts` (a retry after a lost answer, the race on the
  key and into slow mode or the rate limit, a replay's bells, two identical
  messages, before 0104; the group directory's membership),
  `lib/chat-view.test.ts` and `components/chat/live-rows.test.ts` (a bubble
  settled by its client id, whichever way the server's copy arrives)
- `lib/chat-migration-db.test.ts`: real Postgres via PGlite, with policies
  run as a signed-in user, then triggers, carry-over, the Discord teardown
  and idempotency; and 0104 on top: one message per sender and client id,
  the column readable for the echo, and a deleted message reported.
- Threads (0110): `lib/chat-threads-migration-db.test.ts` (PGlite: same
  channel and one level whoever writes, counts and follows, #help's
  automatic questions, an answer from its own thread and its delete
  reopening the question, the audit trail, who reads replies and the thread
  tables, a channel full of threads deleted, the verify query; then 0112:
  what stamps a root and what never does, Support's state and owner, who
  reads the stamp, its verify query),
  `lib/chat-threads-rules.test.ts`, `lib/chat-actions.test.ts` (a reply's
  Retry, where a reply may hang, *Ask the team*, settling a question,
  following, *Ask about this*), `lib/chat-server.test.ts` (the feed without
  replies, reply paging, thread bells, a moderator's transcript marking
  replies with their roots), `lib/chat-thread-route.test.ts` (`GET
  /chat/api/thread`: the channel checked first, a root from another channel,
  a reply or a system line opening nothing), `lib/chat-help.test.ts` (one help
  request per thread; a course item shown only to who can open it),
  `components/chat/live-rows.test.ts` (live replies routed and counted once;
  which UPDATE's thread stamp is news), and `lib/attention*.test.ts` (the
  Overview's Unanswered questions).
- `lib/staff-feed.test.ts`, `lib/stripe-staff-feed.test.ts`,
  `lib/announcement-chat.test.ts`, `lib/account-deletion.test.ts`,
  `lib/app-host.test.ts`: what the feed says and that every payment path
  posts it once, what an announcement hands chat, that deleting an account
  purges its chat first, and that every legal page (the guidelines included)
  is served like the others.
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

Then **0104**, any time after 0101. Until it runs, chat works as before, and
a Retry of a send whose answer was lost can still post it twice. If 0101 is
ever run again, run 0104 after it: 0101's re-grant of the message columns
takes `client_id`'s away.

Then **0110** (threads), any time after 0104, before or after its code.
Until it runs, Chat has no threads, question states or Unanswered list, and
*Ask the team* only rings the bell. If 0101 is ever run again, run 0110
after it: 0101 re-creates `chat_unread()` and
`chat_messages_touch_channel()` without the thread clause, and takes
`thread_root_id`'s column grant away.

Then **0112** (live thread state), any time after 0110, before or after its
code. Until it runs, a question settled or a help request worked reaches
other screens on their 30-second resync, as before; the code before it
ignores the new column. If 0101 is ever run again, run 0112 after 0104 and
0110: 0101 takes `thread_changed_at`'s column grant away.

**Don't roll the code back past 0110 once threads are in use; fix
forward.** The migration itself never needs undoing (the previous code
ignores the new column and tables). But the previous code's feed doesn't
know about `thread_root_id`: every thread reply would show in its channel's
main feed as a plain message, out of its thread, and live clients would
add new ones there (and could pin or quote them), while 0110's
`chat_unread()` still leaves them out of the unread count. Before anyone
has replied in a thread, a revert is harmless. If a revert can't be
avoided, expect replies in the feeds until the fix-forward ships — never
drop the column to hide them: it's the only record of which thread each
reply belongs to.

When the deploy goes live, **lock the Discord server**. The code no longer
manages it: nobody is kicked or loses a role there when they leave the
program, change role or have their account deleted, and deleting the bot or
the application removes no member, role or channel. Post a pointer to
`/chat`, then take away the student and mentor roles' (and `@everyone`'s)
permission to view channels, or delete the server. Until it's locked, remove
anyone you take out of the program from it by hand. Then delete the Discord
application and bot in the Discord Developer Portal and remove the
`DISCORD_*` variables from Vercel.
