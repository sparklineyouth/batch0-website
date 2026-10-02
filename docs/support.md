# Support requests

Every kind of request — refunds, billing, account access, tech help, a
concern, a privacy request — is a ticket with a reference (`B0-XXXX-XXXX`), a
recorded arrival time, and a thread. Requesters file and follow up on the
site; the team works them at `/admin/support`.

A ticket is a **binding refund channel**: the recorded arrival time
(`received_at`) is what stops the refund policy's 48-hour clock. Email to the
contact inbox (hello@batch0.org) is a co-equal channel — parents often have no
account — and the team logs those as tickets with their true arrival time
(below).

## Where people file and follow up

| Who | Where | Credential |
|---|---|---|
| Anyone signed in | `/support` (marketing chrome) or `/dashboard/support/new` | the session |
| The owner, signed in | `/dashboard/support` (their list) and `/dashboard/support/<reference>` | the session |
| Whoever has the emailed link | `/support/t/<token>` | the token in the URL |
| The team | `/admin/support`, `/admin/support/<id>`, `/admin/support/new` | `support.view` / `support.manage` (+ `support.sensitive` for concerns) |

- Signed out, `/support` explains that filing needs an account and that email
  counts the same; it never just bounces to `/login`.
- The owner opening their emailed link while signed in is redirected to
  `/dashboard/support/<reference>` — the same thread, with the token out of
  the address bar. Anyone else keeps the token page.
- `/dashboard/support/**` is reachable by every role, before day one, and
  through a pending fine — disputing a fine *is* a support request.
- Links into the form can prefill it: `?topic=<category>`, `?from=<pathname>`
  (sanitized: secret paths are dropped), `?source=<tag>`, `?digest=<error
  digest>`, and `?payment=<id>` (one of the person's own charges; anything
  else is ignored). The billing page, receipts, settings and every error
  screen link in with these.
- Refund and billing requests ask "Which charge is this about?" from the
  person's own tuition payments, fees and fines, and Demo Day tickets. The
  pick is re-checked on the server; the team sees it on the ticket.

## Files

Requesters attach files when they file and on every follow-up; the team
attaches them to replies and to internal notes. Up to **5 files per message,
10 MB each**: PNG, JPG, GIF, WebP, HEIC, PDF, TXT, LOG, CSV, MP4, MOV, WebM.
Screenshots can be pasted straight into the message box or dropped on the
form.

How it works (and why each step exists):

1. **Mint** — `mintSupportUploads` (`app/support/attachment-actions.ts`)
   decides who is asking (`new` = signed in, no ticket yet; `own` = the owner
   by reference; `token` = the emailed link; `staff` = `support.manage`, plus
   `support.sensitive` on a concern), builds the storage path itself, and
   returns a one-shot signed upload URL. Paths: `u/<user id>/<uuid>-<name>`
   for a request that doesn't exist yet, `t/<ticket id>/<uuid>-<name>` for
   everything else.
2. **Upload** — the browser puts the bytes straight into the private
   `support-attachments` bucket (a server action body caps at 1 MB).
3. **Record** — after the message is saved, `recordAttachments`
   (`lib/support-attachments.ts`) checks every claim the browser made: the
   path is in a folder this uploader may record from, the object exists, and
   storage's own size and type are within limits and not active content.
   Files on an internal note are always internal. A file that fails costs the
   file, never the message — the person is told which one and why.
4. **Download** — every file link goes through a route that re-authorizes the
   click and redirects to a 10-minute signed URL:
   `/support/files/<id>` (signed in: the owner, or staff who can see the
   ticket) and `/support/t/<token>/files/<id>` (the link holder; never an
   internal file). Images open in a tab; everything else downloads under its
   own name.

The bucket has **no storage policies**: only the service role can read or
write it. Emails never carry the files themselves — the receipt names them,
the team alert and a reply's email say how many and point at the thread.

Files that were uploaded but never sent (removed in the picker, or a form
abandoned) are deleted by the daily housekeeping job once they're more than a
day old and no message references them.

## Working the queue (`/admin/support`)

- **Views**: Needs reply · Waiting on requester · Resolved · Closed · All,
  with counts. Filters for kind, priority and owner (Mine / Unassigned), a
  search box (an exact reference jumps to that request; anything else matches
  reference, email, name or subject), and pages of 50.
- Needs-reply rows show how long the person has waited against the reply
  target for the priority (urgent 4h, high 24h, normal 48h, low 72h) — these
  are internal targets, never promised to requesters.
- **A request** (`/admin/support/<id>`): who they are (role, application,
  enrolment, their other requests), where they filed from (page, error digest,
  browser), the charge it's about and — for a refund — whether it arrived
  inside the 48-hour window, the thread with internal notes marked, and the
  history of every change.
- **Replying**: *Send reply* (emails them; the request then waits on them),
  *Send & resolve* (one email that says both, with an optional outcome), or
  tick *Internal note* (the team only; never emailed, never moves the status).
  ⌘/Ctrl+Enter sends a plain reply or note. Files go with any of the three.
- **Controls**: Resolve & notify, Reopen, Close without reply, Take it, owner,
  priority, kind, confidentiality (`support.sensitive` only), and the charge.
- **Refunds are not issued here.** A full refund tears down the enrolment, so
  it stays on `/admin/payments`; the request links there.

### Logging a request that arrived by email or phone

`/admin/support/new` (`support.manage`). Enter the address it came from (it
attaches to their account when one exists), how it arrived, **when it
arrived** (New York time — for a refund this is what stops the clock, so use
the email's time, not now), the kind, and paste the request. Leave *Email them
a confirmation* on so they get the reference and their thread link. The
person page (`/admin/students/<id>`) links here prefilled.

## Confidential concerns

"Report a concern" is confidential from the moment it's filed: only staff with
`support.sensitive` (alongside view/manage) can see it. For everyone else it
is absent — from the queue, the counts, the bells and the team email — rather
than locked. Its team alert carries the reference and a link only.

## Automation (`/api/cron/support-housekeeping`, daily)

- **Auto-resolve**: waiting on the requester for 7 days → resolved, outcome
  "no response", with a note on the thread and an email saying a reply
  reopens it.
- **Auto-close**: resolved for 14 days → closed (silently). A closed request
  takes no replies; the requester opens a new one.
- **Overdue digest**: one email to the team inbox listing requests past their
  reply target (concerns by reference only). Nothing is sent when nothing is
  overdue.
- **Orphaned files**: uploads more than a day old that no message references
  are deleted from the bucket.

## Notifications

| Event | Who hears | How |
|---|---|---|
| New request | the team (concerns: `support.sensitive` holders only) | bell + team inbox email |
| Requester follow-up | the assignee, else the team | bell |
| Team reply | the requester | email (with the thread link) + bell |
| Resolved (by the team or automatically) | the requester | email + bell |
| Assigned | the new owner (unless they took it themselves) | bell |

Bells never carry the token link; requester bells point at
`/dashboard/support/<reference>`.

## Permissions

Grant at `/admin/roles`: `support.view` (read the queue), `support.manage`
(answer, assign, log requests, attach files), `support.sensitive` (see and
handle confidential concerns — keep it to a few senior staff). Admins hold all
three through `*`.
