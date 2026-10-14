# Recording

Webinars and 1:1 calls record the same way: **one continuous take** per
Record → Stop, made in one browser, stored as numbered parts, played back as
one seekable file.

## In the room

- **Who records.** Webinar hosts (staff and guest speakers) and a call's team
  (host, co-hosts — never the student). Record/Stop is in the control bar.
  Calls start recording when the first of the team is live; webinars when the
  event records automatically (`events.auto_record`).
- **Auto-start keeps a room recorded.** It fires whenever a tab that may
  record is live and the lease is free — on joining, and again when the
  recorder leaves (or its lease goes stale) while others carry on, after a
  0.5–3.5 s spread so they don't all ask at once. A deliberate **Stop**
  sticks: that tab never restarts on its own, and the server refuses an
  automatic start while the room's latest take ended with Stop
  (`end_reason = 'stop'`) — until someone presses Record. (A Stop before the
  scheduled start — a host trying Record out while setting up — holds only
  until the start.) Failed automatic starts retry at 5/15/30/60 s, then leave
  it to Record.
- **One recorder per room** is a server lease: the row in
  `recording_sessions` with `status = 'recording'` (partial unique index).
  A second host who presses Record gets "Recording · <name>". The same
  person in another tab or device is refused too ("Recording · you, in
  another tab") — only a reload of the recording tab takes its own lease back
  (the take's id is kept in `sessionStorage` and sent as `replaces`). The
  lease is renewed by every part upload (and a heartbeat); one ~45 s stale is
  swept to `interrupted` (the media route, start, lists that see one, the
  follow-up cron and the call-lifecycle cron all sweep). Every take records
  why it ended: `stop`, `leave`, `unload`, `stale` or `replaced`.
- **Everyone sees REC** (viewers included) from the session's heartbeat
  answer (`session.room.recording`, filled by `activeRecordingFor()`), plus
  this tab's own take — no extra polling. The green room says so before Join
  (calls always; webinars that record automatically, or that a single
  `GET /api/recordings/active` on entry finds recording).
- **What is recorded** is the room's main stage
  (`lib/recording-layout.ts`): a screen share or slide deck full-frame with
  faces inset, else the primary camera with insets, else everyone side by side
  — composited on a 1280×720 canvas, every voice mixed through an
  `AudioContext` (`components/live/use-recorder.ts`). One `MediaRecorder` runs
  for the whole take; device switches, people arriving, presenting and
  cameras turning off never restart it. Frames are driven by a Worker timer so
  a hidden tab keeps compositing. A slow machine gets fewer frames, never a
  backlog: the Worker sends a tick only after the last one ran, and a frame
  is skipped while drawing would take more than about a third of the main
  thread — the room comes first (otherwise a starved tab composites queued
  ticks nonstop, the room freezes, uploads stall and memory climbs). On a
  CPU-starved test box this meant 2–11 recorded fps and, in some takes, a
  video track ending a few seconds before the audio (frames still queued in
  the encoder at Stop are dropped); a normal machine composites with the GPU
  and never hits it.

## Upload

`components/live/use-room-recording.ts`. The recorder emits a chunk a second;
chunks are sealed into parts (~10 s or 8 MB) and uploaded **strictly in
order** to the private `recordings` bucket at
`<kind>/<roomId>/<sessionId>/part-000000.webm`, each through a URL the server
signs for that index (`POST /api/recordings/<id>/part`) — only the next index
or the latest again (a retry), never an earlier one. The bookkeeping (sizes,
times, the part's keyframe cues appended in place) is one database call,
`recording_mint_part`. The bucket takes video only, at most 16 MB an object
(twice a part's cap). Failures retry with backoff; an index is never skipped;
unsent parts wait in memory (cap 192 MB, then recording stops and the backlog
keeps uploading). Stop resolves once the
last chunk is captured; the rest uploads in the background (the tab asks
before closing) and `POST /finish` closes the take. Route handlers, not
server actions: a page's actions run one at a time, and nothing here
revalidates the live route.

## Playback

- **Finalize** (`lib/recording-sessions.ts`): the gap-free parts from 0 are
  the take. For WebM the server rewrites only the head (everything before the
  first Cluster): Info gets a **Duration**, and **Cues** go in front of the
  Clusters, built from the keyframe Cluster offsets the recorder noted while
  recording (`WebmScanner` in `lib/recording-webm.ts`) and spot-checked
  against storage. If they don't check out (or don't build) the head carries
  Duration only. Chrome is asked for a keyframe every 2 s, so seeks land
  within 2 s; the head holds up to 20,000 cues (~11 h). MP4 (Safari) parts
  are served as recorded. A take whose finalize keeps failing is counted
  (`finalize_attempts`): the sweep retries the least recently tried first,
  serves the parts as recorded (no head rewrite) after 3 failures, and stops
  after 12.
- **`GET /api/recordings/<id>/media`** serves head + parts as one file:
  Range requests are mapped across objects (`lib/recording-parts.ts`), each
  206 capped at 4 MB, access re-checked on every request. A call watched by
  someone not on it is audited (`recording.viewed`, once per half hour).
- **Download** assembles the file in the browser from 15-minute signed part
  URLs (`GET /download`) — straight to disk where the browser has a save
  dialog, else one Blob.
- **Who may watch**: webinar — staff (`events.manage`), and anyone who can see
  the event once the follow-up shared it (`assets_shared_at`); call — the
  people on it and admins. **Delete** (audited): `events.manage` for a
  webinar's, admins for a call's.
- UI: `components/live/recording-player.tsx` — `EventRecordings`,
  `CallRecordings` (fetch their own list), `RecordingPlayer`. Takes under
  15 s fold under "Also recorded". A call card shows its recordings once the
  call is past and its room had opened — an invite nobody answered included
  (its room opened all the same; `callMayHaveRecording`).
- **Deleting a room**: `deleteRoomRecordings(kind, roomId)` removes every
  take (bytes and rows, audited) — for deleting an event, whose takes no page
  could reach afterwards.

## Legacy

Recordings from before migration 0095 are two-minute segment files
(`event_assets` kind `recording` in `webinar-media`; `call-recordings` bucket
files). They are untouched and play back to back in the legacy player
(`/api/recordings/legacy`). A call whose room opened after the first
one-take recording existed can't have segments, so its bucket isn't listed.

## Deploying

Migration `0095_recordings.sql` (table, RLS, `recording_mint_part`, private
bucket). Before it is applied the room shows no Record control's effect
("unavailable") and lists show no new recordings; nothing errors.
