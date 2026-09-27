# Direct messages

One-to-one chat between **any two accounts on the site**. A chat dock sits
bottom-right on every signed-in page; `/messages` is the same feature with room
to breathe.

The directory is deliberately site-wide rather than cohort-scoped: reaching the
person you need is the point. A student can message a mentor, a mentor can
message the team, an applicant can message a student. What keeps that open graph
safe is blocking, rate limits, and reporting — not a narrow address book.

## Surfaces

| Where | What |
| --- | --- |
| Chat dock (bottom-right, every authed shell) | Conversation list, directory search, live thread. `components/messages/chat-dock.tsx` mounts it from the dashboard, admin, mentor and investor layouts. |
| `/messages` | Two-pane inbox: list + thread, one pane at a time on a phone. `?c=<conversationId>` opens a conversation (the notification link target), `?to=<userId>` opens a draft. |
| `/admin/messages` | The **reported**-DM queue. Gated on `moderation.manage`. |
| `/admin/messages/[id]` | One reported conversation, read-only, with its reports and a per-message remove. |

`/messages` is a top-level route, not `/dashboard/messages`. It has to be:
`/dashboard` is gated on `student.dashboard`, so a mentor following a "someone
messaged you" link into a `/dashboard` page would be bounced straight back out.
`/notifications` sits outside for the same reason. Middleware lists `/messages`
as authenticated with no role gate of its own
(`lib/supabase/middleware.ts`).

The dock and the page are not two implementations. Both mount the same
`MessageThread` against the same server actions, and both build their thread
state with `buildThreadPayload()` (`lib/dm-thread.ts`) — so the popup can never
end up being the surface with the weaker access rule.

## Data model (migration 0089)

- **`dm_conversations`** — the pair, stored **ordered** (`user_a < user_b`) with
  a unique index over it, so "find or create the DM with this person" is one
  upsert and two people pressing send at the same instant can't race their way
  into two parallel conversations. `orderPair()` in `lib/dm-access.ts` is the
  application-side half of that contract; the `dm_conversations_ordered` check
  constraint refuses any row that skipped it.
- **`dm_messages`** — `conversation_id`, `sender_id`, `body`, `created_at`. A
  trigger recomputes `message_count` / `last_message_at` /
  `last_message_preview` / `last_sender_id` on the conversation from the
  messages (rather than incrementing), so a delete needs no special case and
  concurrent sends can't lose a count to a read-then-write race.
- **`dm_blocks`** — one-way rows, **symmetric effect**.
- **`dm_reports`** — the only thing that opens a DM to staff.

Read state is **one cursor per side on the conversation row**, not a
participants table: a DM has exactly two sides forever, so a join to learn "have
I read this" would buy nothing. Unread, everywhere, means
`sender_id <> me AND created_at > my cursor` — which is why a person's own
message is never unread to them whatever their cursor says, and why sending
doesn't have to move the sender's own cursor.

## The rules, and where each one lives

Every rule is a pure function in **`lib/dm-access.ts`** (unit-tested in
`lib/dm-access.test.ts`), enforced explicitly in **`lib/dm.ts`** /
**`app/messages/actions.ts`**, and backstopped by an RLS function in
**migration 0089**. Keep the three in lockstep; the reads use the service-role
client, so RLS is the backstop rather than the thing that saves us. (It has to
be service-role: a student may only read their *own* `profiles` row, and every
screen here needs the other person's name.)

**Privacy.** A DM is readable by its two participants, full stop — until
somebody reports it. `dm_can_read_conversation()` gates the staff branch on a
report existing, so an unreported conversation has *no* staff read path, and
`/admin/messages/<id>` 404s for an admin who types the id in. A conversation the
viewer may not read is indistinguishable from one that doesn't exist, so a
guessed id can't confirm a DM happened.

**Blocking** is symmetric in effect: once either side has blocked the other,
neither can send. Both keep their history — it just goes read-only. The person
blocked is never told, and blocked people are filtered out of directory search
in both directions: showing someone who blocked you and then failing the send
would announce the block. The blocker's own list is at the bottom of the left
pane on `/messages` (`components/messages/blocked-list.tsx`) — a block can exist
with no conversation, so there has to be a way back.

**Reporting** hands the whole thread to `moderation.manage` holders, including
the reporter's own messages. The confirm dialog says exactly that before they
commit, because it's the one moment the privacy promise changes.

**Emails never reach a student.** `DmPerson` carries a name, a role label, and
nothing else. Directory search matches on email only when the searcher holds
`moderation.manage` — otherwise a student typing a guessed address could confirm
it.

**Rate limits** (`lib/rate-limit.ts`, not expressible in SQL): 30 messages/min,
and **10 new conversations/hour** — cold outreach to a stranger is the spammable
act, so it carries its own slower limit. The block check runs *before* the
conversation row is created, or a blocked sender could push an empty
"no messages yet" row into the blocker's inbox on every attempt.

## Notifications

One bell **per burst**, not per message: `sendDm` reads the conversation before
inserting, and only notifies when the recipient was caught up. A conversation
they haven't caught up on already has an unread bell pointing at it. No email —
a DM is a conversation, not an announcement, and mailing every line would make
the feature unusable.

## Realtime

Only `dm_messages` is in the publication, and the client only ever subscribes to
it **with a `conversation_id` filter**, for the one thread it has open
(`useThreadLive`). That restraint is deliberate: an unfiltered
`postgres_changes` subscription would be trusting Realtime to re-apply the read
policy to every DM body in the system, and a DM body is the last payload here
worth betting on that.

The global unread badge therefore rides on **`notifications`** instead
(`useInboxLive`), which is already per-user (migration 0016) — and the numbers
line up exactly, because the badge counts unread *conversations*, which can only
rise at the moment a caught-up recipient is bell-ed. A 60s poll backs both up,
the same safety net the notification bell uses.

## Permissions

No new permission. Moderation reuses **`moderation.manage`** — admins hold it
via `'*'`, and it can be granted to a custom role at `/admin/roles`.

## Deploying

Migration **0089 must be applied by hand** in the Supabase SQL editor. Until it
is, the pages render empty and the dock shows no conversations.
