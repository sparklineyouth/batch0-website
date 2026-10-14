# batch0 Live — webinars and 1:1 calls

Webinars and 1:1 calls run on infrastructure this project already owns: no
video vendor, no account, no required environment variable. Media goes
browser to browser over WebRTC; the only thing we run is signalling, over
Supabase Realtime.

| Piece | What runs it |
| --- | --- |
| Signalling | Supabase Realtime broadcast (~100 ms round trip) |
| Media | Browser-to-browser WebRTC |
| NAT traversal | Public STUN; TURN optional (below) |
| Attendance | `live_participants` (0076) |
| Primary host | `events.live_primary_host_id` (0096) |
| Recording | `recording_sessions` + private `recordings` bucket (0095), see [recording.md](recording.md) |

A **webinar** is a star: each host sends one stream per viewer, each viewer
holds exactly one connection per host and is never told another viewer
exists. A **1:1 call** is a small mesh: everyone sends to everyone.

## Files

| File | Role |
| --- | --- |
| `lib/live.ts` | Pure rules: windows (`roomWindow`, `roomAccess`, `callRoomAccess`), `webinarHasBegun`, `mayEndCall`, list status. Unit-tested. |
| `lib/live-signal.ts` | Pure wire protocol: topics, messages, media slots, encodings, `nextStatusAction`. Unit-tested. |
| `lib/call-roster.ts`, `lib/call-lifecycle.ts` | A 1:1's roster folding and its lifecycle (`callPhase`, who may cancel/end/add). Unit-tested. |
| `lib/live-access.ts` | Server-only: who someone is in a room (`resolveEventAccess`, `resolveCallAccess`), primary-host claims, `presentHosts`. |
| `lib/live-rooms.ts` | Server-only: channel keys, credentials, attendance, the server's hints (`notifyStage`, `notifyCallChanged`). |
| `app/live/actions.ts` | `joinRoom`, `announcePresence`, `leaveRoom`, `listAudience`, `setPrimaryHost`, `getHostingStatus`. |
| `app/api/live/leave/route.ts` | The same leave, as a `sendBeacon` target for a closing tab. |
| `app/dashboard/events/[id]/live/room-actions.ts` | A webinar's `endLive` / `reopenLive` / `fetchLiveState`. A 1:1's End call is `endCall` (`app/calls/actions.ts`). |
| `components/live/use-live-session.ts` | The WebRTC engine (both shapes). Exposes `session.room`: primary, live stamps, `canEnd`, the running recording. |
| `components/live/use-local-media.ts`, `room/audio-levels.ts`, `audio-output.ts` | Camera/mic (per-device status), the level meters and speaking rings, the speaker choice. |
| `components/live/room/controller.tsx` | **The room**: phase machine, devices, presentation, session, recording, every exit. Renders the kit. |
| `components/live/room/**` | The room UI kit (`LiveRoom`: green room, stage, tiles, control bar, deck presenter, end screens). Presentational; `/dev/live` renders every state on fake data (localhost only). |
| `components/live/room/panel/*` | The webinar side panel (Chat · Q&A · Polls · People) and reactions; reads/writes through `app/api/live/panel`. |
| `app/dashboard/{events,calls}/[id]/live/` | The pages and their bindings (`builtin-room.tsx`: server actions memoised on the room id). |

## The room

`/dashboard/events/[id]/live` and `/dashboard/calls/[id]/live` render a
full-viewport dark surface over the dashboard chrome (URLs unchanged, so
emails, ICS files and cards keep working).

- **Green room** for everyone: camera preview, mic meter, device pickers,
  test sound, mic test (viewers: speaker only). A webinar host sees **Start
  webinar** when nobody is hosting, else **Join as co-host · Ana is hosting**
  (`getHostingStatus`, never the caller, polled every 10 s, and read once more
  when Join is pressed: if someone went live or started recording since, the
  host stays to see it first); co-hosts join with camera and mic off. Before
  the go-live window the button is **Enter room** with "students can join
  from <time>". The recording notice is shown before Join whenever the room
  records or will (calls always; webinars with auto-record, or a take running
  — hosts learn that from the same 10 s poll, viewers once on entry).
- **Main stage**: your own local pin, else a presentation (screen share or
  slides; the primary's, else the most recent), else the webinar's primary
  host, else (1:1) the other person with yourself as a PiP, else a grid.
  Presentations are never cropped. Everyone else is in the filmstrip.
- **Pin for everyone** (webinar staff): `setPrimaryHost` writes the primary;
  the server publishes `room-changed` and every client reads the new
  `session.room.primaryId`; the presser is told in a toast (their own stage
  may not move: a local pin wins). The first host in becomes primary; a host
  who joins while the primary is gone takes it over.
- **Present**: share a screen, or present a PDF — from disk, or (webinars) the
  event's uploaded deck (`event_assets` kind `deck`, PDF, signed for 6 h).
  pdf.js draws it onto a 1920×1080 canvas whose stream goes through the screen
  slot, so viewers and the recording need nothing new. While another
  presentation holds the stage (the primary's always does), a presenter is
  told so ("Cy is presenting. Yours shows when they stop.") and drives their
  slides from a filmstrip card (n/N, previous, next, Stop).
- **REC badge** for everyone from `session.room.recording` (and this tab's own
  take). Record/Stop for webinar hosts and a call's staff. A recorded 1:1 also
  keeps a line under the top bar saying who can watch it back (from the live
  staff list). The end screens say "Recording saved." once this tab's upload
  is done, or what went wrong (a take that lost its lease while draining).
- **Rehearsal**: a host in the room before the go-live window (start − 60 min)
  sees "Not live yet: students can join from <time>"; nothing is stamped and
  Leave is the only way out. The heartbeat that crosses into the window stamps
  `live_started_at` and the host is told "You're live".

## Leave, End, and the other ways out

Every exit runs in one order (`controller.tsx`): the session goes down at once
(`bye` to every peer — off air now), the recording's final part is captured
(`recording.stop("leave")`, bounded), the presentation and devices stop, the
phase changes. Any upload still running finishes behind the left/ended screen
("keep this tab open"); the unload prompt stays armed while parts are unsent
(held by `use-room-recording.ts` for the whole tab), and Rejoin, Reopen and
Back wait for it first (bounded at 90 s).

- **Leave** — "I go; the room keeps running." "You've left" offers Rejoin,
  which remounts the room and goes back through the green room. The last host
  on air in a live webinar is told so in the Leave menu, next to End for
  everyone; the browser also prompts before that tab closes. Viewers left
  without a host see "The host stepped away" and reconnect on their own.
- **End for everyone** (webinar) — in the Leave menu, confirmed in place. Only
  once the webinar has begun (its start, or a host going live early); staff
  always, a guest speaker only with no staff host present (`canEnd`).
  `endLive` stamps `live_ended_at` (first End wins), closes polls and
  attendance and sends `room-changed`; only then does this tab go off air. If
  it fails nothing is torn down. Everyone else closes on the hint or the next
  heartbeat: hosts see "The webinar was ended", viewers "This webinar has
  ended". The server then refuses joins and audience writes.
- **Reopen** — staff only, on the ended screen or the admin pages. It clears
  the stamp; nobody is reconnected. Every ended screen polls `fetchLiveState`
  (15 s; 30 s after an empty answer; until the hard close) and offers Rejoin.
  Pressing Start never reopens: a host who arrives on an ended webinar lands on
  the ended screen.
- **End call** (1:1) — in the Leave menu, once the other side has been in the
  room (for staff, the student; latched across Rejoin and reload) and the start
  has come. `endCall` completes the invite (idempotent), audits it and calls
  `notifyCallChanged`; the presser sees "This call has ended" and, after the
  upload, goes back to their calls list (if still on the page). Everyone else
  closes on the hint or the next heartbeat. `endCall` revalidates nothing, so
  the room stays mounted through the upload. Cancelling or declining a running
  call closes every room the same way, at once ("This call was cancelled").
- **Someone left a call** — the others see "<name> left the call. They can
  rejoin until <end + 3 h>"; a person not yet on the page reads as "Waiting
  for <name> to join" (`RemotePeer.heard` tells them apart).
- **The server closes it** — a heartbeat or re-check answering `ended`,
  `cancelled` (a declined 1:1 too), `closed` (window over, no host) or
  `revoked` (access removed; `closed`/`revoked` only on two answers in a row)
  runs the same teardown.
- **Rejoin after an End elsewhere** — Rejoin refreshes the page; a host whose
  fresh render says the webinar ended lands on the ended screen (Reopen for
  staff), not on Start.
- **A closing tab is a Leave**: `pagehide` sends `bye` on every connection and
  beacons `POST /api/live/leave` (cookie-authenticated, same-origin only).
  Coming back through the back-forward cache reloads into the green room.
- **The server minted a different role** than the page rendered: the room
  remounts as that role, back through the green room.

## Who may be in the room, and when

`roomAccess` / `callRoomAccess` in `lib/live.ts`, shared by the page,
`joinRoom`, `announcePresence` and every room action.

| | Opens | Closes |
| --- | --- | --- |
| Webinar viewer | start − 15 min, or as soon as a host has gone live | end + 30 min (later while a host is present, up to end + 3 h); at once on End |
| Webinar host (staff or speaker) | any time | end + 3 h, including after End (to Reopen) |
| 1:1 staff side / student | start − 60 min / start − 15 min | End call, cancel, or end + 3 h |

A host in the room from start − 60 min stamps `live_started_at`, which lets
the audience in and makes End available. Leaving is never window-gated.

**Who is a host.** Webinars: `events.manage` (admins through `*`) or a claimed
`event_speakers` row. Guest speakers broadcast and moderate but are never told
audience names. 1:1s: the student, the inviter and any co-hosts
(`call_invite_cohosts`, 0092); co-hosts have the owner's powers. Nobody else
can enter a call — the page 404s and `joinRoom` refuses, admins included; a
`calls.join_any` holder adds themselves visibly as a co-host (`addCallCohosts`).
People added mid-call are dialled from the heartbeat's roster.

Both room paths are exempt from the student-dashboard gate
(`isLiveRoomPath`) and on the pre-cohort allow list; the pages authorize.

## Audience privacy

A student must not learn who else is watching, or how many:

1. The server never tells a viewer that another viewer exists (`credentialsFor`).
2. Every inbox and lobby topic is an HMAC of a server secret.
3. Host↔viewer negotiation runs on the viewer's own inbox in both directions;
   messages carry `to`, and hosts drop anything addressed to someone else.
4. RLS: `live_participants` has no client write policy; viewers read only their
   own row.

Hosts see a live headcount. Server hints (`room-changed`, `host-online`) are
unauthenticated and content-free: they only make clients re-ask the server.

## The connection

Every connection has fixed transceivers — camera, screen, audio — negotiated
once. Camera off detaches the track (`replaceTrack(null)`), presenting swaps
the screen track; nothing renegotiates. Offers and answers carry `slots`, so a
viewer joining mid-share gets the screen from the first frame. Hosts always
offer to viewers; two broadcasters compare ids, so glare is impossible.

Discovery heals itself: a host coming online publishes `host-online`; viewers
announce through a server action (never the lobby directly); everyone
re-announces every 12 s; a link stuck mid-negotiation for 12 s is rebuilt; a
failed link gets ICE restarts first. Subscribe first, announce second — a
Realtime broadcast has no replay.

## Scale

A webinar host encodes once but sends one copy per viewer: camera ~500 kbps,
screen ~1.5 Mbps, split across links between a floor and a ceiling
(`encodingFor`). Comfortable to about **25 viewers** on home broadband; past
that the host's upstream is the limit and the fix is an SFU behind
`lib/live-signal.ts`. Viewers always receive one stream. A 1:1 mesh grows
everyone's upstream with each person: a handful works best
(`MAX_CALL_COHOSTS` = 20 is an abuse guard).

## TURN (optional)

```
LIVE_TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
LIVE_TURN_USERNAME=…
LIVE_TURN_CREDENTIAL=…
```

Server-only, handed out per join, validated first (`turnServerFrom`). Without
it, viewers behind a symmetric NAT or strict firewall cannot connect.
`LIVE_ROOM_SECRET` (default: the service-role key, used only as an HMAC input)
rotates every room key. Camera and mic need HTTPS (`localhost` counts; a LAN IP
does not).

## Checking it

```bash
npm run webinar-doctor     # configuration, signalling, 0095/0096, scheduled webinars
npm run webinar-e2e        # real browsers, real accounts, decoded frames
npm run call-mesh-e2e      # a 1:1 that gains a co-host mid-call
npm run webinar-panel-e2e  # chat, Q&A, polls, reactions across three people
npm run room-screens       # screenshots of every room state (/dev/live)
```

`webinar-e2e` drives the real pages with an admin host, two students, a second
admin and a mentor, and asserts on `getStats()`: viewers decode climbing video
and audio and send nothing; each student holds one connection and the host
one per student; only the host sees a headcount; screen share and the event's
PDF deck reach viewers (including one joining mid-share) as the main stage;
chat Remove reaches everyone; the second admin is offered "Join as co-host"
and "Pin for everyone" moves the viewers' stage; Leave/Rejoin, End for
everyone, Reopen; and a mentor-hosted 1:1 that is recorded as one take whose
media route answers 206. Everything it creates is deleted, including on
failure. A configuration check is not proof: only decoded frames are.

## History

Live video used to run on Daily. The integration worked; the Daily account
could not start a media session (`account-missing-payment-method`), and a
REST-only doctor passed for months while every join failed. batch0 Live
replaced it, and the Daily code, scripts and dependency are gone. The
`daily_room_*` columns stay as history; nothing reads them. Moving to a vendor
again means wiring it behind `lib/live-signal.ts` and proving it with
`webinar-e2e`.

**Deploy step:** delete `DAILY_API_KEY`, `NEXT_PUBLIC_DAILY_DOMAIN`,
`DAILY_ENABLE_RECORDING`, `DAILY_LARGE_CALLS` and `LIVE_PROVIDER` from the
Vercel environment (every environment), and revoke the API key in the Daily
dashboard: it could create rooms and mint owner tokens for any room on the
domain, and nothing uses it now.
