# 1:1 calls

One student and a staff side (the host plus any co-hosts), in a batch0 Live
room at `/dashboard/calls/<id>/live`. Every call is recorded.

## Booking

- **Start call now** (`/admin/calls`, `/mentor/calls`, `/investor/calls`): pick a
  student (and optionally people from the team), and the call is booked on the
  current minute and the host lands in the room. The student gets a bell and an
  email with the Join link.
- **Schedule**: the same, at a chosen time. The server accepts a start up to
  5 minutes in the past (`callStartProblem`).
- **No accept step.** A booked call (`invited`) is joinable. The student sees
  **Join** when their room opens and, until the call starts, a small
  **Can't make it? Decline**. `accepted` exists only on older rows and behaves
  the same.
- **Edit** (staff side or admin): time, length, topic (`updateInvite`). A new
  time goes back to `invited` (so it can be declined); the student gets a bell
  and, for a new time or length, an email.
- The invite email carries the Join link and an **Add to calendar** link
  (`/api/calls/<id>/ics`, signed-in, same UID + increasing SEQUENCE so a
  re-import after a reschedule updates the entry).

## Request a 1:1

Enrolled students ask the team from one card on `/dashboard/calls`
(`interview_requests`): a preferred time, an optional backup, a note. One open
request at a time; a booked call doesn't count, so the card (and a
scholarship balance) is always there. A student with scholarship mentor calls
ticks "Use a scholarship mentor call"; the credit is spent when the team books
it and handed back if the call is cancelled or declined. The team books or
declines from **Requests** on `/admin/calls`.

## Windows (`lib/call-lifecycle.ts`, numbers from `lib/live.ts`)

| | |
|---|---|
| Staff side may enter | start − 60 min |
| Student may enter | start − 15 min |
| Room stays open | until End call, a cancel, or the hard close (end + 3 h) |
| Lists | a call nobody ended shows "running over" until end + 30 min, then moves to Past (with **Rejoin** while the room is still open) |
| Student may decline | until the start |
| Staff side may cancel, edit, add people | until end + 30 min |
| End call | completes the call once it has started; anyone on the call |
| Sweep (`/api/cron/call-lifecycle`, every 15 min) | stamps `completed` on booked calls past the hard close (last 7 days only) |

**No-shows.** A booked call nobody cancelled counts as held: the sweep
completes it and a scholarship credit stays spent. A student who can't make it
declines before the start; a host whose student doesn't show cancels (until
end + 30 min). Both hand the credit back.

**Before the accept step went** (`ACCEPT_STEP_REMOVED_AT`), an unanswered
invite could not be joined. The sweep withdraws those that had already expired
(`cancelled`, credit back) instead of completing them.

End call, cancel, decline and edits publish `room-changed` on the call's stage
topic (`notifyCallChanged`), so everyone in the room re-checks at once.

## Data

Writes go only through service-role server actions (`app/calls/*`). Since 0097
the API roles have no write policies or privileges on `call_invites`,
`call_invite_cohosts`, `interview_requests`, `mentor_slots`, `mentor_bookings`;
reads are unchanged (the people on a call, and admins). Test:
`npm run test:calls-db`.

Office hours (mentor slots) are retired; `/dashboard/office-hours` and
`/mentor/office-hours` redirect to the calls pages.
