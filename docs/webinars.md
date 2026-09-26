# Webinars

A webinar is now a first-class event type with a deck, a recording, guest
speakers, a live audience channel, and — optionally — a pre-recorded talk played
on the schedule with a genuinely live Q&A at the end.

Everything here sits on top of batch0 Live (`docs/batch0-live.md`), which is
unchanged: the media path, the star topology and the signalling protocol are
exactly as they were. What is new is everything around the video.

---

## Deploying this, in order

**The order is not a preference.** Migrations in this project are pasted into
the Supabase SQL editor by hand — there is no runner, no ledger, and nothing
that verifies a file on disk was applied. Code that reads `audience_mode` or
`event_assets` before the SQL exists gets PostgREST `42703` / `PGRST205` errors
at runtime, live, in front of an audience.

1. **Do not deploy while a webinar is running.** `0084_webinars.sql` drops and
   re-adds `events_type_check` and `events_live_mode_check`, each of which takes
   a brief `ACCESS EXCLUSIVE` lock on `public.events` — the table every viewer's
   12-second heartbeat reads. It also drops and recreates the `events read`,
   `webinar_questions read` and `webinar_questions insert` policies, and in the
   gap between the drop and the create, joins and question submissions fail
   closed.
2. Apply `supabase/migrations/0084_webinars.sql` in the SQL editor.
3. Run `npm run webinar-doctor`. It now checks every table, column and bucket
   0084 adds, and prints an audience-mode census.
4. Deploy the code.

**Never run `npm run webinar-e2e` against production.** It creates a real admin
account, two student accounts, and a `visibility: 'public'` event that starts
five minutes ago — visible on every student's events list for an hour. Its
cleanup is best-effort (`.catch(() => {})` on every delete), so a crash or a
`^C` leaves an admin account and a live public event behind. Point it at a
separate Supabase project first.

---

## The one decision that matters: `audience_mode`

Everything else in this feature is additive and safe. This one is a
safeguarding decision, and it is per-webinar.

Until now, audience privacy in this system was a **constant**. `canSeeRoster()`
takes a role and nothing else — deliberately, with no override parameter, so no
call site can opt out. Migration 0076 made the hiding structural by never
disclosing one viewer to another. Migration 0060 kept Q&A off the video
provider's chat because a hidden viewer could read it but not send to it.

Live chat cannot exist under that constant. Chat **is** the audience seeing
itself: a name on a message is a disclosure that the person is in the room, and
no amount of care in the UI changes that. So rather than quietly weakening a
guarantee the rest of the system is built on, it became a setting:

| Mode | What a student sees | Use it for |
|---|---|---|
| `private` | Their own questions. No chat. No evidence anyone else exists. | **The default.** Public intake webinars. Anything with strangers in the room. |
| `moderated` | Approved messages and questions, plus their own pending ones. | A public webinar where you want a live channel but nothing unreviewed reaching the room. |
| `open` | Every message, with names. | A cohort call, where the students already know each other. |

`private` is the default in the database, in `normalizeAudienceMode()`, and in
the admin form. Every event that existed before 0084 has it. A deploy that is
ahead of the database shows a webinar with no chat rather than one with
unmoderated chat, because the normaliser fails closed on an unrecognised value.

**Switching modes is not retroactive.** A question's visibility is gated on
`approved_at`, and a question asked while the room was `private` is never
approved — so widening the mode later does not publish it. Students who asked
under a private promise stay private.

### Where that rule is actually enforced

Not in the UI. In four places, in this order of authority:

1. **The join payload.** `credentialsFor()` does not give a viewer the room
   channel at all in `private` mode. There is no channel on which one student
   could observe another — not a hidden one, not a disabled one, none.
2. **RLS.** `webinar_messages read` requires `approved_at is not null` plus an
   `audience_mode in ('moderated','open')` check on the event. The anon-key
   browser client carries the student's JWT and can query the table directly;
   this is the copy that binds.
3. **The server actions.** `fetchRoomState` shapes its result from
   `audienceMode` and `isModerator`, which it derives itself.
4. **The components**, which draw what they were given.

---

## Guest speakers

A guest needs a camera. Before this, the only way to get one was
`events.manage` — a **global** staff permission that also hands over every event
on the calendar and, through the `events read` policy's `is_staff` clause, a
great deal more. Not a trade worth making for someone talking for forty minutes.

So broadcast rights are per-event: a row in `event_speakers` says "this person
may host **this** webinar", and nothing else.

A claimed speaker broadcasts and moderates (chat, questions, polls) exactly
like a staff host. What separates them is in `docs/batch0-live.md` under
*Who is a host*: a speaker never sees names, cannot Reopen, and can End for
everyone only when no staff host is in the room — their normal exit is Leave.
They record under the same election as staff: the recorder is whichever
host's browser has the lowest user id among those present, guest speakers
included, so a guest-only webinar with auto-record on is recorded from a
guest's browser (see *Recording* below). That keeps a guest-only webinar closable without letting a
founder who presses End "for their segment" end a room an admin is running.
(If attendance can't be read, the rule fails open and the speaker may End:
ending is reversible by staff, and failing closed would strand a guest-only
webinar.)

### What a guest speaker is deliberately NOT given

A star topology gives a broadcaster no choice about reaching every viewer —
they hold one send-only connection per person, and reaching someone needs their
inbox. It does **not** need their name.

So `discloseNames` is false for a speaker: they get `peerId` and `inbox` for
everyone and a blank `name` for every viewer. They see a headcount and a set of
opaque ids. The attendance list of a room containing minors stays with the staff
who are accountable for it. A viewer's name also never crosses the lobby
channel at all, because a speaker holds the lobby key.

### The claim link

`speakerInviteLink()` mints a single-use link. It is a **claim, not an
authentication**: the guest must already be a signed-in batch0 user, and all the
token does is attach that account to the speaker row an admin created. It is
cleared on first use, so a forwarded link is spent.

In the event form, every saved speaker who has not claimed yet has **Copy
invite link** (`speakerInviteLink`) and **Send invite** (`sendSpeakerInvite`,
which emails the address on the *saved* row — never one typed into the form —
and refuses once the slot is claimed). A claimed row says so. The room page
runs the claim before it reads the event, so a guest outside the event's
audience (a mentor, or a guest on an enrolled-only webinar) is not turned away
before their link is spent. Staff never claim: an admin who opens a copied
link to check it hosts through `events.manage` as always, and the token is
left for the guest.

`claim_token` and `email` are revoked from `anon` and `authenticated` at the
column level. Note the spelling in the migration — a column-level `REVOKE` is a
**no-op** against a role holding a table-level grant, and Supabase grants
`anon`/`authenticated` `ALL ON TABLES` through `ALTER DEFAULT PRIVILEGES`. The
table grant has to come off first and the safe columns granted back by name.
`lib/webinars-migration-db.test.ts` asserts this, and it caught the no-op
version.

---

## Recording

Auto-record starts when the elected host starts broadcasting — once their
camera and mic have settled, so the first segment is not a second of silence.
There is no button to forget. It runs only while its host is live, not during
a premiere's recording, and never after End.

Until September 2026 it never started at all: `useRecorder` returned a
`start()` that nothing called, and the register step below failed on every
segment. Both are fixed; there are no recordings from before that.

**It records what the audience saw, not what the camera captured.** The host's
picture changes mid-webinar — camera, then slides, then back — and a
`MediaRecorder` bound to one track stops when that track is replaced. So
`use-recorder.ts` composites onto a `<canvas>` and records
`canvas.captureStream()`, which survives every switch as one continuous track.

**It uploads in 2-minute segments while the webinar is still running.** Holding
an hour in a tab and pushing it at the end fails three ways at the worst moment:
memory grows all hour, the upload starts exactly when the host wants to close
the laptop, and any failure costs the whole recording. Each segment is a
self-contained file; `event_assets.sort_order` is its position. Two minutes
(~19 MB at the recording bitrates) rather than five (~49 MB before VBR
overshoot) because Supabase's default global upload limit is 50 MB and binds
every signed upload whatever the bucket says.

**It records the whole stage, from exactly one host's browser.** The recorder
composites every live host's camera and screen share (a presenter's screen
full-frame with faces inset, otherwise everyone side by side, each labelled)
and mixes every voice through an `AudioContext` — the same stage machine a 1:1
uses (`use-recorder.ts`). So a staff moderator's intro and the guest speaker's
slides and talk are both in the file, whichever laptop made it. Every host
(staff and guest speakers) runs the same room, so each host's browser elects
one recorder from the co-hosts it can see (`electRecorder` in
`lib/webinars.ts`: the lowest user id present — a peer's id is its user id, the
one fact every browser holds identically; an earlier staff-before-guests rank
depended on a speaker list rendered at page load, which a guest claiming their
slot later made two browsers disagree about). The recorder stands down and
flushes when a lower id arrives; the next in line takes over when it leaves. A
co-host whose connection dropped counts as present for two segment lengths
(`presentForRecording`), and the engine's heartbeat rebuilds a wedged
connection to every co-host (not only the join-time roster), so a recorder who
vanished without a goodbye cannot hold the election. The server backs this up
(`recordingRival`): a segment is refused — before its upload is signed, and
again at registration — when a *different*, lower-id host registered a segment
within two segment lengths, after this segment began (worked out on the server
from the segment's length, so a skewed client clock can't move it), and is
still in the room (`live_participants`). A refusal is returned as a value, and
the room stands its recorder down for that lease before looking again. A
refused segment's bytes are deleted only when no `event_assets` row already
claims that path, so naming someone else's registered segment deletes nothing.

A handover is the case that rule has to get right. The recorder who presses
Leave is off air at once, and its final segment uploads behind the "You've
left" screen while the co-host who takes over is already recording. That tail
is filed *after* its uploader has left the room, so it is dated to their last
heartbeat rather than its arrival (`recordingFiledAt`) — it can never pass for
a registration made during the successor's segment, which would otherwise
refuse (and delete) the successor's handover flush the moment the old
recorder rejoined. A host still in the room is dated by arrival as before, so
two hosts genuinely recording at once are still caught.

Registering a segment reads the event's segments and then inserts
(`registerRecordingSegment` in `app/admin/events/webinar-actions.ts`, rule in
`recordingSegmentSlot`). It is not an upsert: the unique index is partial
(`where kind = 'recording'`), PostgREST cannot repeat that predicate in an
`ON CONFLICT`, and Postgres refuses with 42P10 — pinned in
`lib/webinars-migration-db.test.ts`. The same file registered twice keeps its
slot, so nothing plays twice. Each segment's name carries its **run** (the
recording room's mount time — a reload, a Rejoin or a Reopen each start a new
one) and index — `segment-<run>-<index>-<stamp>.webm` —
and each run is laid out as its own contiguous block: a slow segment still
lands in order behind its successors, and a reload (or a second host taking
over) starts a new block after everything registered instead of filling the
first run's gaps. A new block starts a few slots (`RECORDING_RUN_GAP`) past the
last, so a departing recorder's tail that lands after its successor's first
segment still files in its own block, ahead of it; empty slots are harmless.
Registering a segment never revalidates a path: Next
re-renders the *current* route on any revalidate, and from inside the live room
that re-ran the page — which, past the join window, replaced the host's room
with "This event has ended".

The cost is a seam of tens of milliseconds every two minutes, because a
`MediaRecorder` has to be stopped and restarted for each file to carry its own
header.

### The End button (and Leave)

There is **one** End for everyone, in the room's control bar, with a two-step
confirm. Staff hosts always see it (during a premiere too); a guest speaker sees
it only in the last-host Leave prompt, and only when no staff host is present.
Admins also have End for everyone and Reopen on `/admin/webinars` and
`/admin/events/[id]`, so a webinar a host walked away from can be closed
without going on air.

Nobody can End a webinar that has not begun — its scheduled start, or an early
"Go live now" on a premiere (`webinarHasBegun`, enforced by `endLive` through
the room's `canEnd`). Hosts can open the room an hour early to set up, and an
End there used to end the real webinar before it started: the audience got
"This webinar has ended" at the start, and a guest speaker who pressed it could
not undo it. Before the start the control bar has no End, and the last-host
prompt offers only Leave, which keeps the room ready. To take an event off the
calendar, edit or delete it.

The order, and why:

1. **`endLive` first.** It stamps `live_ended_at` (the first End wins; a retry
   returns the stored time), closes open polls and attendance rows, and sends
   the content-free `room-changed` hint that makes every other client re-check
   and tear down. Without the stamp a viewer's browser cannot tell a host who
   ended from a host who dropped off hotel wifi. If it fails, **nothing** is
   torn down: the host stays live with an error and can retry.
2. **Off air.** The session goes down at once — `bye` to every peer — so the
   host stops broadcasting now, not after anything uploads.
3. **`await recorder.stop()`**, before the media tracks are stopped.
   `media.stop()` ends the tracks the recorder is reading, so stopping them
   first truncates the final segment — reliably the Q&A, reliably the part
   people re-watch. `stop()` resolves once the final segment is *captured*
   (its blob built — milliseconds, capped at a few seconds), never on its
   upload. It used to wait for the upload with no bound on the final
   segment, which on a host's Leave meant staying on air to the whole room
   for as long as the final segment took to climb their uplink.
4. Screen, camera and mic stop, and the host lands on the ended screen, which
   shows "Saving the recording — keep this tab open"; the tab's unload prompt
   is armed until the upload lands (held by `use-recorder.ts` for the whole
   tab, so it survives the room unmounting). Reopen, Rejoin and Back wait for
   those uploads first, bounded at 90 seconds, because each takes the room
   off the screen.
   The room stops the devices itself, after the capture: `useLocalMedia`
   deliberately does not stop them when its auto-start gate turns off,
   because an End that arrives by poll would otherwise kill the tracks
   before the recorder had its last frame.

End is reversible, but only deliberately: **staff** press Reopen (on the ended
screen or on the admin pages). Pressing Start again does **not** reopen an
ended webinar, and a host who arrives after End sees when it ended and a
"Reopen and go live" choice instead of their camera switching on. Every ended
screen — a host's, a guest speaker's, the ended green room, a viewer's —
slowly polls for a Reopen pressed elsewhere and offers the way back (Rejoin,
or the ordinary Start) when it comes.

After End, viewers see "This webinar has ended" with no media and no Rejoin;
chat, questions and polls close for the audience (moderators can still read
and tidy them); the webinar shows **Ended** on every list.

---

## Premieres (pre-recorded, played as live)

`live_mode = 'premiere'`. A recording plays on the schedule and hands over to a
genuinely live room for the Q&A.

Every viewer is positioned at `(serverNow - starts_at)`. A viewer arriving
twenty minutes late joins twenty minutes in — which is the difference between a
premiere and a video, and it makes the position self-healing across a reload
with no per-viewer signalling.

**The offset is server-computed and must stay that way.** A viewer whose laptop
clock is four minutes fast would otherwise sit four minutes ahead of the room —
visibly, in chat, reacting to something nobody has seen yet — and one whose
clock is out by an hour would watch a black screen and conclude the webinar
never started.

`live_ended_at` beats everything: End for everyone stops a playing premiere
too, rather than leaving the recording running under an "Ended" badge.

`live_started_at` beats the schedule absolutely. A host who presses "Go live
now" thirty minutes into a forty-minute recording has made a decision about the
room; the alternative is an audience watching a recording of someone who is, at
that moment, live on the other side of the same page.

### What is and is not pretended

The talk is pre-recorded. Everything else is real and happening now: the chat,
the questions, the polls, the attendance record, and the host answering at the
end. A premiere is a talk that was rehearsed instead of improvised.

There is deliberately **no** support for fabricated audience activity — no
scripted student messages, no synthetic reactions. `display_viewer_count`
(migration 0071) remains the one announced figure an admin can set, and it is
display-only and gates nothing. If you want the room to look busier than it is,
that field is the honest place to say so.

---

## Chat transport: why it is not a poll

The old Q&A panel polled every 5s (host) / 15s (viewer). Fifty students at 5s is
600 requests a minute against a table that changes a few times an hour.

The room channel replaces it. A message lands, the server publishes a
**content-free** `bump`, and every client re-reads through its own RLS about
250ms later. Roughly one request per client per thing that actually happened.

Content-free is load-bearing, not an optimisation. Every participant holds the
room key, so anything one participant could verify, another could mint —
publishing the message body would be publishing something forgeable. A bump is
not worth forging, because answering one returns only what the caller could
already read. The worst a student in devtools achieves is making the room
re-fetch.

Realtime broadcasts are not replayed, so the feed also re-syncs every
`ROOM_RESYNC_MS` regardless of bumps. A dropped bump is a blip for one person
rather than a message that never appears for exactly one person.

---

## Auto-share

`auto_share` is handled by `/api/cron/webinar-followups`, every 15 minutes.

It is a cron and not the End button for two reasons, both of which have
happened: the last recording segment is still uploading when the host clicks
away, and hosts do not always press End — they close the laptop, and the
students who missed it are exactly the ones the email is for.

When it is due: 15 minutes after `live_ended_at` when a host pressed End
during the run (an End stamped before the scheduled start is a rehearsal's
and is ignored — the room no longer accepts one, but older stamps exist);
otherwise 15 minutes after the audience window closed
(scheduled end + 30 minutes) — but a webinar nobody ended is skipped as
`still-running` while a host is still in the room, up to the hard stop at
end + 3h, so an overrunning talk is never mailed about while it is live. The
claim is conditional on the `live_ended_at` the run read, so a Reopen in
between cancels the send. The email and the notification link to the event's
room page (`/dashboard/events/<id>/live`; the bare `/dashboard/events/<id>`
redirects there), which after the webinar lists the recording and the slides
once the follow-up has gone out. Editing the event later does not re-arm the
follow-up: the claim is cleared only when it predates the event's (new) host
window, like the other live stamps. An auto-recorded webinar with no recording attached yet is left for later
runs (up to two hours) rather than being marked as having nothing to share.
A **staff-only** event is never shared — it is a rehearsal — and the form shows
"Share afterwards" off for one.

`assets_shared_at` is the claim, and it is stamped **before** the sending
starts. A run that dies halfway costs one webinar's follow-up rather than
mailing the whole cohort twice on the next run.

It goes to everyone enrolled, not only to attendees. The people who most need a
recording are the ones who missed it.

The email and the bell link to `/dashboard/events`. They used to link to
`/dashboard/events/<id>`, which has no page.

---

## Files touched

| Layer | File |
|---|---|
| Schema | `supabase/migrations/0084_webinars.sql` |
| Rules (pure, tested) | `lib/webinars.ts`, `lib/webinars.test.ts` |
| Schema test | `lib/webinars-migration-db.test.ts` |
| Server reads | `lib/webinar-data.ts` |
| Signalling | `lib/live-signal.ts`, `lib/live-rooms.ts` |
| Room actions | `app/dashboard/events/[id]/live/room-actions.ts` |
| Who is a host | `lib/live-access.ts` |
| Admin actions | `app/admin/events/webinar-actions.ts` |
| Admin pages | `app/admin/webinars/*` (live status, Host room, End / Reopen), `app/admin/events/[id]/page.tsx` |
| Follow-up job | `app/api/cron/webinar-followups/route.ts` |
| Room | `components/live/broadcast-room.tsx`, `room-panel.tsx`, `use-recorder.ts`, `premiere-player.tsx`, `speaker-strip.tsx` |
| Admin form | `app/admin/events/webinar-fields.tsx` |

---

## Known gaps

- **A background tab throttles the recording.** `requestAnimationFrame` is
  throttled or paused when the tab is hidden, and the `setInterval` fallback is
  itself clamped to about 1 Hz. A host who tabs away to read their notes gets a
  choppy picture for that stretch; audio is continuous throughout and it
  recovers on return. Holding the frame rate properly would need a Web Worker
  timer or an audio-clock-driven loop.
- **The elected recorder is chosen by presence, not by capability.** If the
  host's browser that wins the election cannot record at all (no
  `MediaRecorder`, no canvas capture), it says so to that host and nobody else
  records — the other hosts defer to it. The server backstop only ever
  *refuses* segments; it never asks a second browser to start.
- **A failed segment upload is dropped, not retried.** That is what keeps memory
  bounded to one segment, but a host with two minutes of dead network loses
  two minutes of the talk. Retry belongs in `onSegment`, where the caller can
  tell a network failure from a rejected file.
- **Students have no player for auto-recorded segments.** The follow-up says the
  recording is up, and `/dashboard/events` still only shows the manual
  `events.recording_url`. The segments are listed (as a count) on the admin
  event page only.
- **No PDF/PPTX rendering.** A deck is a download, not an in-page viewer — there
  is no renderer in the repo and adding one would be a new dependency.
- **Existing webinars are not backfilled** to `type = 'webinar'`. They are still
  `type = 'workshop'` with `live_mode = 'hosted'`, and `/admin/webinars` accepts
  both. A backfill would break `scripts/prepare-course-schedule.mts`, which
  hard-asserts the counts of each type in the seeded schedule.
