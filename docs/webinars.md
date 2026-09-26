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

`claim_token` and `email` are revoked from `anon` and `authenticated` at the
column level. Note the spelling in the migration — a column-level `REVOKE` is a
**no-op** against a role holding a table-level grant, and Supabase grants
`anon`/`authenticated` `ALL ON TABLES` through `ALTER DEFAULT PRIVILEGES`. The
table grant has to come off first and the safe columns granted back by name.
`lib/webinars-migration-db.test.ts` asserts this, and it caught the no-op
version.

---

## Recording

Auto-record starts when the host starts broadcasting — once their camera and
mic have settled, so the first segment is not a second of silence. There is no
button to forget.

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

**Exactly one host's browser records.** Every host (staff and guest speakers)
runs the same room, and each recorder captures only its own camera and mic —
so left alone, every host recorded into the same event and the recording came
out as alternating slices of different solo feeds. Each host's browser elects
one recorder from the co-hosts it can see (`electRecorder` in
`lib/webinars.ts`: staff before guests, then lowest user id; a peer's id is its
user id, the speaker list is in the page, so every browser agrees). The
recorder stands down and flushes when someone who outranks it arrives; the
next in line takes over when it leaves. The server backs this up
(`recordingRival`): a segment is refused — before its upload is signed, and
again at registration — when a *different*, higher-ranked host registered a
segment within two segment lengths and is still in the room
(`live_participants`). A refusal is returned as a value, and the room stands
its recorder down for that lease before looking again.

Registering a segment reads the event's segments and then inserts
(`registerRecordingSegment` in `app/admin/events/webinar-actions.ts`, rule in
`recordingSegmentSlot`). It is not an upsert: the unique index is partial
(`where kind = 'recording'`), PostgREST cannot repeat that predicate in an
`ON CONFLICT`, and Postgres refuses with 42P10 — pinned in
`lib/webinars-migration-db.test.ts`. The same file registered twice keeps its
slot, so nothing plays twice. Each segment's name carries its **run** (the
recording tab's mount time) and index — `segment-<run>-<index>-<stamp>.webm` —
and each run is laid out as its own contiguous block: a slow segment still
lands in order behind its successors, and a reload (or a second host taking
over) starts a new block after everything registered instead of filling the
first run's gaps. Registering a segment never revalidates a path: Next
re-renders the *current* route on any revalidate, and from inside the live room
that re-ran the page — which, past the join window, replaced the host's room
with "This event has ended".

The cost is a seam of tens of milliseconds every two minutes, because a
`MediaRecorder` has to be stopped and restarted for each file to carry its own
header.

### The End button (and Leave)

`await recorder.stop()` runs **before** the media tracks are stopped and before
the server is told. Leave does the same flush now — it used to stop the tracks
first, which cut the last segment off any recording whose host left rather
than ended. That ordering is the whole point: `media.stop()` ends the
tracks the recorder is reading, so stopping them first truncates the final
segment — reliably the Q&A, reliably the part people re-watch.

Ending also stamps `live_ended_at`. Without it, a viewer's browser cannot tell a
host who ended from a host who dropped off hotel wifi, and the audience sits on
"waiting for the host to start" until the join window closes half an hour later.
It is reversible — a host who ends by accident presses Reopen.

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
| Admin actions | `app/admin/events/webinar-actions.ts` |
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
