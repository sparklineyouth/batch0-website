# batch0 Live — the built-in webinar and call provider

Webinars and 1:1 calls run on infrastructure this project already owns. No
video vendor, no new account, no new environment variable.

This replaced Daily. The [live-video](./live-video.md) document has the full
history; the short version is that the Daily *integration* was fine and the
Daily *account* cannot start a media session — every join, including into a
bare public room with no properties set, is refused with
`account-missing-payment-method`. That is an account-level block no code
change clears, so live video moved onto something we control.

---

## How it works

A webinar is a host (or a few — see [Who is a host](#who-is-a-host))
broadcasting to N viewers. That is a **star**, not a mesh:

```
                 ┌─────────┐
                 │  HOST   │  camera + mic + screen
                 └────┬────┘
        ┌─────────────┼─────────────┐
        │             │             │        one send-only connection
        ▼             ▼             ▼        per viewer
   ┌────────┐    ┌────────┐    ┌────────┐
   │viewer A│    │viewer B│    │viewer C│    each: one recv-only
   └────────┘    └────────┘    └────────┘    connection, to the host

   Viewers are never connected to each other, and are never
   told that another viewer exists.
```

Media goes **browser to browser** over WebRTC and never touches our servers.
The only thing we run is signalling — the short exchange of offers, answers,
and ICE candidates that lets two browsers find each other — and that rides
**Supabase Realtime**, which is already in the stack and already used by
`components/notification-bell.tsx`.

| Piece | What runs it | Cost |
| --- | --- | --- |
| Signalling | Supabase Realtime broadcast (~100ms round trip) | included |
| Media | Browser-to-browser WebRTC | free |
| NAT traversal | Public STUN | free |
| Relay for hostile networks | TURN (optional, see below) | only if you add one |
| Attendance | `live_participants` (migration 0076) | included |
| Q&A | `webinar_questions` (migration 0060), unchanged | included |

### Files

| File | Role |
| --- | --- |
| `lib/live.ts` | Pure rules: the audience window, `roomAccess` (who may be in a room now, by role), `eventLiveStatus` (what a list shows), `callPhase` (where a 1:1 stands). Unit-tested. |
| `lib/live-signal.ts` | Pure wire protocol: channel names, message shapes, media slots, and the client's reaction to a status answer (`nextStatusAction`). Import-free, unit-tested. |
| `lib/live-access.ts` | Server-only. **Who someone is in a room**, computed once: `resolveEventAccess` / `resolveCallAccess`, and the identity-only `leaveInternal`. Every gate below calls it. |
| `lib/live-rooms.ts` | Server-only. Derives channel keys, issues credentials, records attendance, publishes the server's hints. Holds the room secret. |
| `app/live/actions.ts` | The server actions: `joinRoom`, `announcePresence`, `leaveRoom`, `listAudience`, `endCall`. The access-control surface for media. |
| `app/api/live/leave/route.ts` | The same leave as `leaveRoom`, as a `sendBeacon` target for a closing tab. |
| `app/dashboard/events/[id]/live/room-actions.ts` | Everything in a webinar that isn't video — chat, Q&A, polls — plus `endLive` / `reopenLive`. |
| `components/live/use-live-session.ts` | The WebRTC engine. Runs both webinars and 1:1s. |
| `components/live/broadcast-room.tsx` | The room UI. Reuses `PreJoin`, `VideoTile`, `CallControls`, `QAPanel`. |
| `supabase/migrations/0076_builtin_live.sql` | Attendance table + RLS. Optional — see below. |

---

## Audience privacy

A student must not be able to tell whether they are one of three people or one
of thirty. With Daily that was a token flag (`hasPresence: false`). Here it is
a property of the topology and of what the server is willing to say, which is
a stronger guarantee — and it is enforced in four independent places:

1. **The server never tells a viewer that another viewer exists.** `joinRoom`
   filters the peer list by role (`lib/live-rooms.ts`, `credentialsFor`). A
   viewer's payload contains hosts and nothing else. The audience is not
   hidden from the response — it is never fetched into it.

2. **Channel names are HMACs.** Every inbox and lobby topic is
   `HMAC(server secret, …)`, truncated to 128 bits. A viewer cannot derive
   another viewer's inbox, so there is no channel it could subscribe to on
   which someone else would appear.

3. **A host↔viewer connection is negotiated entirely on the *viewer's* inbox**,
   in both directions. This is the subtle one. If a viewer answered on the
   *host's* inbox it would have to know that topic — and so would every other
   viewer, any of whom could then subscribe and watch each answer go by,
   carrying a user id and a display name. Routing both directions through the
   viewer's own channel means a viewer never learns any topic but its own.
   Pinned by `connectionTopic()` and its tests in `lib/live-signal.test.ts`.
   The corollary: every host connected to a viewer listens on that viewer's
   inbox, so with two broadcasters on air each hears the viewer's traffic for
   the other. A viewer's `answer`, `ice` and `bye` therefore carry `to` (the
   host they are for), and a host drops anything addressed to someone else
   (`isAddressedTo`). A message without `to` — a tab from before the field —
   is still accepted, so a deploy never splits a live room; as a backstop an
   answer is applied only while our own offer is outstanding
   (`shouldApplyAnswer`), and a stray one is dropped quietly.

4. **RLS.** `live_participants` lets a host read the room and a viewer read
   only their own row. There is deliberately no insert/update policy at all —
   every write goes through a server action under the service role, because a
   viewer able to insert its own row with `role: 'host'` would be a viewer who
   can broadcast.

**What's better than before:** Daily's `hasPresence: false` hid viewers from
the *host* too, so nobody could tell whether anyone was watching. Here the
host sees a live headcount and the audience still cannot see itself.

Role is always derived server-side, never accepted from the client — see
[Who is a host](#who-is-a-host). A guest speaker is a broadcaster who is
deliberately **not** told names: they get a headcount and opaque ids, never
the attendance list (`discloseNames` is false; `docs/webinars.md` has the
detail). None of the End / Leave machinery below carries a name either: the
server's `room-changed` hint is content-free, and a departure is a `bye` on the
departing viewer's own inbox.

---

## Why the connection is negotiated exactly once

Renegotiation is where naive WebRTC falls apart in front of an audience: the
host switches to slides, twelve connections renegotiate at once, two collide
mid-exchange, and those two students get a frozen frame with nothing in the
console to explain it.

So it never renegotiates. Every connection is built with a fixed set of
transceivers — **camera, screen, audio, in that order, always all three**, even
before the host has a screen to share — and the SDP is then settled for the
life of the call:

- camera off → `track.enabled = false`
- start presenting → `sender.replaceTrack(screenTrack)`
- stop presenting → `replaceTrack(null)`

None of those touch the SDP. The fixed order is also how a receiver tells
camera from screen: slot *i* is transceiver *i* is `mid` *i*. No side-channel
message, nothing to fall out of sync.

Glare is impossible rather than merely unlikely: a host always offers to a
viewer, and two hosts break the tie by comparing peer ids.

---

## Discovery, and how it heals itself

The ordering problem is that students arrive before the host does.

- A host coming online publishes `host-online` to the **stage** channel, which
  every participant subscribes to. Every waiting viewer re-announces at once,
  so a room full of students assembles in about one round trip.
- A viewer announces itself through a **server action**, never by
  broadcasting. The server then publishes into the hosts-only **lobby**
  channel with the service role. That indirection is the point: if viewers
  published to the lobby directly they would need its key, and a viewer with
  that key could watch every other arrival.
- Everyone re-announces every `HEARTBEAT_MS` (12s). This is a self-healing
  interval, not a keepalive — it is what lets a host who reloads mid-webinar
  pick the whole room back up without anyone clicking anything.
- A connection stuck mid-negotiation past `STUCK_MS` (12s) is torn down and
  rebuilt by the next announcement. The retry path is the same code as the
  first attempt, so there is no separate recovery mechanism to get wrong.
- The heartbeat is also how the server says **stop**. `announcePresence`
  answers with a status (`ok | ended | cancelled | closed | revoked | error`,
  `RoomStatus` in `lib/live.ts`), and `nextStatusAction` decides what the
  client does: `ended` and `cancelled` close the session at once; `closed` and
  `revoked` only on the second consecutive answer, so one read at a boundary
  ends nobody's session; `error` (a query failed) is never acted on, so a
  database blip cannot look like a revocation and empty a room.
- The server's own changes arrive as a hint. On End, Reopen, End call and
  Cancel the server publishes a content-free `{ t: "room-changed" }` on the
  **stage** topic — the one channel every participant holds, including a viewer
  in a `private` webinar who has no room topic. A client that hears it
  re-announces immediately (throttled to one re-check per
  `ROOM_CHANGED_THROTTLE_MS`) and acts on what the server answers. The hint
  itself is **unauthenticated** — the stage topic is derivable, and nothing
  verifies a stage message in the browser — so it carries nothing and decides
  nothing. A forged one costs one throttled re-check. `host-online` is a hint
  in exactly the same sense.
- A departure is a `bye` with `reason: "leave"` (a connection being rebuilt
  sends `reason: "rebuild"`, which is not a departure), addressed with `to` to
  the one peer it concerns. The other side marks
  that peer as **left** instead of drawing a frozen tile, and the heartbeat
  never resurrects a peer who left on purpose — reconnecting after a Leave is
  always the leaver's own Rejoin. Hosts also prune viewer connections that
  have not been live for longer than `PEER_TIMEOUT_MS`, and the headcount
  counts only live connections, so a closed laptop does not inflate it.

> **A bug worth remembering.** `joinRoom` originally announced the viewer in
> the same round trip. That raced the viewer's own subscription: the host's
> offer went out before the viewer was listening, and a Realtime broadcast has
> no replay, so the offer was simply lost. The host sat at `have-local-offer`
> forever and the student held no peer connection at all. The contract now is
> **subscribe first, announce second**, and `joinRoom` deliberately does not
> announce.

---

## Who is a host

**Webinars.** A host is anyone who holds `events.manage` **or** a claimed
`event_speakers` row for that event (`canBroadcast` in `lib/webinars.ts`,
called once, from `resolveEventAccess`). Admins pass through `*`; so does any
intern or custom role with `events.manage` ticked. There are two kinds:

| | Staff host (`events.manage`) | Guest speaker (speaker row) |
| --- | --- | --- |
| Camera, mic, screen | yes | yes |
| Moderates chat, questions, polls | yes | yes |
| Sees audience **names** | yes | **never** — headcount and opaque ids only |
| End for everyone | always | only when no staff host is present |
| Reopen | yes | no |
| Records | the one the server picks | never |

Every host is on air. There is no backstage mode.

Who among the hosts *present in a room* is staff — for the speaker End rule
and the recorder pick — is decided by each person's own role
(`presentHostRoles` in `lib/live-access.ts`), never by "not on the speaker
list". Staff cannot claim a speaker slot at all: opening a guest's claim link
while signed in as staff is a no-op, and the link stays good for the guest.

An admin is **never downgraded to viewer**. The event is read through the
caller's own RLS first, and a caller with `events.manage` who gets no row
(the `events read` policy's staff clause is `is_staff()`, which is
`mentor.panel`) is re-read with the admin client. That re-read lives only in
`lib/live-access.ts` and is only for `events.manage`; it must never be reused
for a viewer.

**1:1 calls.** Exactly two people, and both send media (signal role `host`).
The inviter (`call_invites.host_id`) is the **owner**; the invitee — always a
student — is the other participant. Since invitees are students, an admin in a
call is always its owner. An admin who is *not* a party can never enter: the
page 404s and `joinRoom` answers `no-access`, whoever is asking. That is the
safeguarding rule, and the privacy between two people, and both are kept on
purpose. Such an admin sees the call on `/admin/calls` as a read-only
observer card (both names, no Join); a superAdmin may Cancel it from there,
which disconnects both people.

## Who may be in the room, and when

`roomAccess` in `lib/live.ts`, per role, shared by the page, `joinRoom`,
`announcePresence` and every room action:

| | Opens | Closes |
| --- | --- | --- |
| Viewer | start − 15 min | end + 30 min; **or** later while a host is still present and nobody pressed End, up to end + 3 h; **or** immediately when End is pressed |
| Host (staff or speaker) | start − 60 min | end + 3 h — including after End, so staff can reach the ended screen and Reopen |

Leaving is never window-gated (it authorizes by identity alone), and End /
Reopen are bounded only by the hard stop at end + 3 h, so an overrunning
webinar never loses its End button.

Lists — the student events page, `/admin/webinars`, the cards — use
`eventLiveStatus`, which reads `live_ended_at` **before** the clock: an ended
webinar shows **Ended**, with no Join, from the moment it ends.

### Reaching the room

`/dashboard/events/[id]/live` and `/dashboard/calls/[id]/live` are exempt from
the middleware's `student.dashboard` role gate and from the pre-cohort
lockdown (`isLiveRoomPath` in `lib/permissions.ts`). The page and the actions
do the authorizing instead, so a mentor or investor who booked a call, an
intern with `events.manage`, and a mentor invited as a guest speaker can all
reach a room they host. Back links are role-aware: a staff webinar host goes
back to `/admin/webinars`, a call owner to their own calls page
(`callsHomeFor`: `/admin/calls`, `/mentor/calls` or `/investor/calls`), a
student to `/dashboard/events` or `/dashboard/calls`.

## Leave, and End for everyone

**Leave means "I go; the room keeps running."** A viewer who leaves stops
their tracks, tears down, is marked left, and sees "You've left" with a Rejoin
that really goes back through the green room. A host who leaves while another
host is on air just leaves. Leaving takes a host off air at once — the
session (and every peer connection) goes down the moment Leave is confirmed;
the recorder then captures its final segment, the devices stop, and any upload
still running finishes behind the "You've left" screen, which says "keep this
tab open" and arms the unload prompt until it lands. The **last** host on
air in a webinar nobody has ended gets a choice: End for everyone, Leave and
keep the room open, or Cancel. While no host is on, viewers see "The host
stepped away — you'll reconnect automatically", not "waiting for the host to
start". A viewer who (re)joins during the gap has not seen the host this
session, so past the scheduled start they get the neutral "The host isn't on
air right now" instead — never "waiting for the host to start" mid-webinar.

A viewer on the ended screen keeps polling (30s, 60s after an empty answer)
for a Reopen until the hard stop, so a reopen is noticed even when the first
answers come back empty because no host is on air yet.

**End for everyone** is one control, in the room's control bar, with a
two-step confirm (admins also have it on `/admin/webinars` and
`/admin/events/[id]`, without going on air). `endLive` stamps
`live_ended_at` — the first End wins and later presses return the same stamp —
closes open polls and open attendance rows, and sends `room-changed`. Only
then does the host's own client go off air, capture the recorder's final
segment and stop its tracks (the upload finishes on the ended screen, as for
Leave); if `endLive` fails, nothing is torn down and the host can retry. Everyone else
tears down when they hear it (the hint, the next heartbeat, or the room's
poll): other hosts see "The webinar was ended", viewers a terminal "This
webinar has ended" with no Rejoin. From then on the server refuses
`joinRoom` / `announcePresence` for the room, refuses audience chat, question
and poll writes, and stops touching attendance.

**Reopen** is staff only: the ended screen's Reopen, or the admin pages. It
clears the stamp and sends `room-changed`. Nobody is reconnected
automatically — hosts go back to the green room, viewers on the ended screen
are offered Rejoin. **Pressing Start never reopens** an ended webinar.

**The last host gone, never ended.** The room stays open. Once the audience
window has passed with no host present, heartbeats answer `closed` and viewers
see "This webinar is over". Nothing stamps `live_ended_at` on its own, so a
wifi drop can never end a webinar.

**A closing tab is a Leave.** On `pagehide` the client sends `bye` (reason
`leave`) on every connection and a `navigator.sendBeacon` to
`POST /api/live/leave` with `{ kind, id }` — a server action fired from a dying
page is usually aborted, and the beacon is not. The route authenticates by
cookie, never takes identity from the body, accepts only same-origin requests,
and answers 204 even for a no-op. A refresh goes back through the green room,
and so does coming back to the tab through the browser's back-forward cache:
the page reloads instead of resuming a session whose peers were already told
it left.
The browser's "leave this page?" prompt appears only while you are the sole
host on air in a live, un-ended webinar, or while recording segments are still
uploading.

### 1:1 calls

Either person can **Leave**; the other sees "<name> left the call — they can
rejoin until <end>", and the leaver can Rejoin inside the window. **End call**
belongs to the owner alone (two-step confirm): `endCall` sets the invite to
`completed` (only from `accepted`, so it is idempotent), audits it and sends
`room-changed`, and both sides see "The call has ended" with no Rejoin. The
invitee's Leave is always enough to get out, and the owner can never pull
them back in. **Cancelling** a call that is in progress disconnects both
people the same way ("This call was cancelled"). An accepted call whose
window has closed counts as completed everywhere — Past, no Join, no Cancel —
even if nobody pressed End call.

---

## Scale, and its honest limit

The host encodes once but **sends one copy per viewer**. That is the cost of
having no media server.

| Viewers | Host upstream needed (~600 kbps each) |
| --- | --- |
| 5 | ~3 Mbps |
| 12 (a current cohort) | ~7 Mbps |
| 25 | ~15 Mbps |
| 50 | ~30 Mbps — don't |

**Comfortable to about 25 viewers** on decent home broadband. Past that the
host's upstream, not the code, is the limit, and the right fix is an SFU
(LiveKit, mediasoup) or a vendor with a payment method attached — at which
point `LIVE_PROVIDER` is the switch and `lib/live-signal.ts` is the seam.

Viewers are unaffected by audience size: each receives exactly one stream.

---

## TURN (optional)

STUN alone gets a direct connection on most home and school networks. A viewer
behind a symmetric NAT or a strict corporate firewall needs a **TURN** relay,
and without one they will simply fail to connect.

```
LIVE_TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
LIVE_TURN_USERNAME=…
LIVE_TURN_CREDENTIAL=…
```

Server-only, and handed to the browser per join rather than inlined into the
bundle, so credentials can be rotated or made short-lived without a redeploy.
`npm run webinar-doctor` warns when it is unset.

---

## Configuration

**Nothing is required.** batch0 Live works with the environment this project
already has.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LIVE_PROVIDER` | `builtin` | Set to `daily` to use Daily instead. |
| `LIVE_ROOM_SECRET` | `SUPABASE_SERVICE_ROLE_KEY` | HMAC input for channel keys. Set it to rotate every room key without touching Supabase credentials. |
| `LIVE_TURN_*` | unset | Optional relay, above. |

The fallback to the service-role key is safe: it is a one-way HMAC input and
is never transmitted. Only truncated HMACs of it reach a browser, each scoped
to one channel that participant is entitled to.

### Migration 0076 is optional

`supabase/migrations/0076_builtin_live.sql` adds `live_participants`.
**Webinars work without it** — discovery runs entirely over Realtime, and
every attendance write is best-effort and swallows a missing table. Applying
it turns on the attendance record and gives the host's roster a reconcile
backstop.

It also clears the stale `daily_room_name` values described below.

---

## Checking it

```bash
npm run webinar-doctor    # configuration, signalling, scheduled webinars
npm run dev               # then, in another terminal:
npm run webinar-e2e       # two real browsers, real accounts, decoded frames
npm run webinar-e2e -- --headed    # watch it happen
```

`webinar-doctor` is provider-aware and checks what `LIVE_PROVIDER` selects.

**`webinar-e2e` is the one that matters.** It creates a throwaway admin and
two throwaway students, schedules a webinar that is live right now, signs them
all in for real, drives the actual `/dashboard/events/[id]/live` page, and
asserts:

- the student **decodes** the host's video, and the frame count **keeps
  climbing** (a negotiated-but-frozen stream is the most common way a call is
  "broken", and a single sample cannot tell the difference)
- the student receives audio
- the student sends **no** media at all, on the wire, not just in the UI
- the student is shown **no** audience count and has no camera/mic controls
- with two students: the host holds **two** connections, each student holds
  **exactly one**, and neither can see the other
- the host's headcount reads **2**

Everything it creates is deleted in a `finally` block, including on failure.

This exists because `daily-doctor` passed for months while webinars were
completely broken. A configuration check cannot tell you a student sees the
host; only decoded frames can.

---

## The stale-room bug this also fixed

Migration 0069 moved every webinar onto a Sunday but left the Daily rooms
stamped with their old `exp`. The result: **17 of 18 scheduled webinars
pointed at a room that expires before the webinar starts**, and one pointed at
a room Daily had already deleted. The join page healed it at join time — which
means the repair ran on the critical path, with an audience waiting.

batch0 Live deletes the entire class of bug. There is no provider-side room to
expire: **the event id is the room**, credentials are minted per join, and a
webinar is joinable the moment it is scheduled. `app/admin/events/actions.ts`
skips the room lifecycle entirely, and the "no room yet — re-save to create
one" warning is gone from `/admin/webinars`.

---

## Going back to Daily

Nothing was removed. `lib/daily.ts`, `daily-doctor`, and the `LiveRoom`
component are all intact.

1. Add a payment method to the Daily account.
2. `LIVE_PROVIDER=daily`
3. `npm run webinar-e2e -- --provider=daily` — confirm the **media plane**
   works before trusting it with an audience. Do not rely on
   `npm run daily-doctor` alone; that is exactly the mistake that let this go
   unnoticed.
