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

A webinar is one host broadcasting to N viewers. That is a **star**, not a
mesh:

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
| `lib/live-signal.ts` | Pure wire protocol: channel names, message shapes, media slots. Import-free, unit-tested. |
| `lib/live-rooms.ts` | Server-only. Derives channel keys, issues credentials, records attendance. Holds the room secret. |
| `app/live/actions.ts` | The four server actions: `joinRoom`, `announcePresence`, `leaveRoom`, `listAudience`. The whole access-control surface. |
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

4. **RLS.** `live_participants` lets a host read the room and a viewer read
   only their own row. There is deliberately no insert/update policy at all —
   every write goes through a server action under the service role, because a
   viewer able to insert its own row with `role: 'host'` would be a viewer who
   can broadcast.

**What's better than before:** Daily's `hasPresence: false` hid viewers from
the *host* too, so nobody could tell whether anyone was watching. Here the
host sees a live headcount and the audience still cannot see itself.

Role is always derived server-side from the `events.manage` permission, never
accepted from the client — the same derivation the Daily path turned into
`is_owner`.

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

> **A bug worth remembering.** `joinRoom` originally announced the viewer in
> the same round trip. That raced the viewer's own subscription: the host's
> offer went out before the viewer was listening, and a Realtime broadcast has
> no replay, so the offer was simply lost. The host sat at `have-local-offer`
> forever and the student held no peer connection at all. The contract now is
> **subscribe first, announce second**, and `joinRoom` deliberately does not
> announce.

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
