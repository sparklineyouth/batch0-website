# Scholarships

Three kinds of scholarship, applied for after acceptance **or** after
enrolment. Each one carries **money off tuition, a set of perks, or both** —
ticked per scholarship on the form.

| Kind | What it's for | Typically carries |
|---|---|---|
| **Need-based** | Money, decided on financial circumstances | Tuition discount or refund |
| **Merit** | Money, decided on extra questions you write | Tuition discount or refund, often with perks |
| **Learner's** | Students who'll use mentor time and tools | Perks only |

`kind` is a label. **The terms decide the payout** — the money half and the
perks half are independent, so a merit scholarship that grants mentor calls
instead of (or as well as) money is creatable without a deploy. `award_type`
on the row is a derived summary (`discount` / `perks` / `both`) the code
writes on every save; never set it by hand.

## Before you start

Migrations `0071_scholarships.sql`, `0072_scholarship_award_percent.sql` and
`0074_scholarship_perks.sql` must be applied, in that order. Paste each into
the Supabase SQL editor or `supabase db push` from the repo root. They're
idempotent — a double-paste is harmless.

Then click **Restore built-in templates** at `/admin/email/templates` to make
the scholarship emails editable. Until you do, they still send: every one
falls back to a compiled version in `lib/email/templates.ts`. If you restored
them before 0074, restore again: the money award gained `{{perks_line}}`, the
old "mentor calls" award now covers every perks-only award, and there is a new
`demo_day.guest_ticket`.

## Setting one up

1. `/admin/scholarships` → **New scholarship**. Name it, then under **What
   it's worth** tick what it carries: **Money off tuition** (a flat amount or
   a percentage) and any of the perks below, each with a "how many". Pick who
   can apply (accepted, enrolled, or both) and optionally cap the seats — a
   cap is **per cohort**. There are no dates to set: see below.
2. Save, then add its questions on the same page — or from the
   **Scholarship questions** section of `/admin/application-questions`, which
   has a dropdown for every scholarship plus the shared block.
3. It appears on the dashboard of every student it's open to.

A scholarship with no questions is fine and common: applying becomes a single
button, which is right for a learner's grant.

## When a scholarship is open: the student's cohort

A scholarship has **no window of its own**. Each student's window is derived
from the cohort they're in and the stage they're at
(`lib/scholarship-window.ts`):

| Stage | Open until | Why |
|---|---|---|
| **Accepted** (not yet paid) | The cohort's **enrollment deadline** — `applications_close_at` before the start, `late_entry_until` once it's underway; the same instant `cohortEligibility()` gives checkout | A discount only exists at checkout, and checkout refuses payment after that deadline |
| **Enrolled** | The **end of the cohort's last day** (`ends_on`, 11:59:59 PM Eastern) | A paid student's money award is a refund, and perks are used during the cohort |

Closed once the cohort has ended or been cancelled, and closed with a reason
for a student who isn't in a cohort yet. The student's cohort is resolved the
way `lib/access.ts` resolves "current cohort": from every enrollment plus an
accepted application, the soonest one not yet started, else the most recently
started one.

The same window is re-checked when you **award** (for the stage the student is
at by then) and when you **invite** someone to apply. The admin list shows each
live cohort's windows — e.g. "Fall 2026 — accepted students until Sep 30 ·
enrolled students until Nov 13".

`scholarships.opens_at` / `closes_at` still exist as columns but nothing reads
them; every save writes them as null.

## The two fulfilment paths

This is the part worth understanding before you award anything.

```
Award decision
  ├─ student hasn't paid yet
  │    → the discount comes off their Stripe checkout automatically
  │    → nothing for you to do
  │
  └─ student has already paid
       → fulfillment = 'refund_due'
       → an admin presses "Issue $X refund" on the review screen
       → real Stripe partial refund against their tuition charge
       → their enrollment is UNAFFECTED
```

Awarding never moves money. It's a separate, deliberate button behind its own
confirmation, because awarding is a judgement call that can be revoked and a
refund is not.

**Why a partial refund is safe here.** `handleChargeRefunded`
(`lib/stripe-fulfillment.ts`) only tears down `payments`, `applications.status`
and the `enrollments` row when `charge.refunded` is true — which Stripe sets
only once the *whole* amount is back. A scholarship refund is always strictly
less than the charge, so the webhook records it and announces it without
touching the student's place in the cohort.

That is also why `issueScholarshipRefund` **refuses a refund equal to what they
paid**: it would flip `charge.refunded`, and the webhook would silently
un-enrol the student you just gave a full scholarship to. Route a genuine full
refund through `/admin/payments`, where that consequence is the point.

## One scholarship per student

Enforced in three places, on purpose:

1. `scholarship_applications_one_award_idx` — a partial unique index on
   `(user_id, cohort_id) where status = 'awarded'`. The backstop that survives
   a bug in either layer above it.
2. `checkEligibility()` — hides the apply button and says why.
3. `canAward()` — re-checked at decision time, because the student's situation
   can change between applying and being reviewed.

It's per *cohort*, not per user, so a returning student isn't blocked forever by
an award from a past cohort — the two application-side checks count only rows
in the student's cohort (`liveStatusesInCohort`), plus any row with no cohort,
which the index can't see. One gap remains: `unique (scholarship_id, user_id)`
still allows one row per scholarship per student ever, so a returning student
can apply to a *different* scholarship in a later cohort but not the same one
again. Lifting that needs a migration. A pending application elsewhere also blocks — else
someone could queue up five and take whichever landed first, and the seat counts
would stop meaning anything.

## Perks

Four perks, each a checkbox on the scholarship form (migration 0074). A perk
is **snapshotted onto the award** at decision time, like the money, so editing
the catalog later can't change what a student was told they'd won. The
roster lives in `AWARD_PERK_DEFS` (`lib/scholarship-award.ts`); every entry is
a number some code actually reads. Where each one bites:

| Perk | Granted as | Redeemed | Counted from |
|---|---|---|---|
| **Extra 1:1 mentor calls** (1–20) | `mentor_calls_awarded` | `/dashboard/calls`, as before | `mentor_calls_used`, spent when the team schedules |
| **Feedback credits** (1–10) | `feedback_credits_awarded` | The feedback form on `/dashboard/scholarships` | `founder_pass_feedback_requests` — one pool with any founder-pass credits |
| **Demo Day guest tickets** (1–10) | `demo_day_tickets_awarded` | A "send a ticket" form on `/dashboard/scholarships` | `demo_day_tickets` rows tagged `scholarship_application_id` |
| **AI co-founder boost** | `ai_boost_awarded` | Nothing to do — the free band widens | Read by `lib/ai/usage.ts` on every billed message |

**Feedback credits** share the founder-pass pool. `feedbackCreditBalance` and
the ceiling in `createFeedbackRequest` (`lib/founder-pass-perks.ts`) sum the
pass tier's credits and the scholarship's, and count every non-declined
request once against that total — a student holding both simply has more.

**Guest tickets** are real `demo_day_tickets` rows inserted already `paid` at
`$0` with no Stripe ids (0074 relaxes the amount check for exactly this). The
guest gets `demo_day.guest_ticket` naming the founder who sent it; the events
policy admits them if the address is on a batch0 account; the admin list at
`/admin/demo-day/tickets` shows a **Guest** badge and offers **Revoke** in
place of Refund. Revoking hands the slot back to the student. A duplicate
address on the same award is refused, and the sender re-counts after
inserting so two clicks can't overshoot the grant.

**The AI boost** doubles `MONTHLY_FREE_*_TOKENS` for the holder
(`AI_BOOST_MULTIPLIER`). `aiAllowanceMultiplier` is read by both the overage
math and the usage meter, so the bar the student watches and the point they
start being billed are the same number.

**Revoking an award** is refused once any perk has been used — a scheduled
call, a sent guest ticket — for the same reason it's refused after a refund:
the record of what happened would be wrong.

## Mentor-call credits

A scholarship-funded call is an ordinary `interview_requests` row with
`scholarship_application_id` set, so it lands in the team's existing queue at
`/admin/calls` and rides the existing `call_invites` / Daily plumbing.

**The credit is spent when the team schedules the call**, not when the student
asks. A request nobody picks up costs them nothing. Cancelling a scheduled call
hands the credit back.

**The calls belong to the cohort the award was made in.** A request is refused
once that cohort has ended, a proposed time after its last day (Eastern) is
refused, and the request row is stamped with the award's cohort. The calls
card on `/dashboard/calls` names the last bookable day and, once the cohort is
over, says so instead of offering a booking.

One open request at a time (`interview_requests_one_open_per_student`, from
0061). A student with three credits books them one at a time — three open asks
on the team would just be three calls nobody has scheduled.

## Where the questions live

| | Asked of | Asked when | Stored in |
|---|---|---|---|
| Built-in application fields (17) | Everyone | `/apply` | Their own columns on `applications` |
| Your added questions | Everyone | `/apply` | `applications.custom_answers` |
| Shared scholarship block | Everyone | `/apply` | `applications.scholarship_answers` |
| One scholarship's questions | Applicants to it | After acceptance | `scholarship_applications.answers` |

The shared block runs before anyone is accepted, so it can only usefully flag
interest — there's no specific scholarship to ask about yet. Questions that
decide an award belong on a scholarship.

### Editing the application form

`/admin/application-questions` now does full add / edit / remove.

- The **17 built-ins** map 1:1 to columns, so their type and what they store
  can't change — but you can rewrite any of them and **remove** the ones you
  don't want. Removing takes a field off the form and stops collecting it;
  answers already given stay in the column and stay readable in review. It is
  never a `DROP COLUMN`.
- Five fields are locked: `full_name`, `age`, `phone`, `why_join`, `team_size`.
  `SubmitSchema` enforces them server-side, so hiding one would only produce
  submissions the server then rejects with nothing on screen explaining why.
- **Your own questions** can be added, reordered and genuinely deleted. They
  render as their own section at the end of the form — not interleaved with the
  built-ins, whose layout is hand-built with conditional fields (parent email
  appears only under 18) rather than a generic list.

A question's **field id is frozen once it exists**. It's the key every answer is
filed under, so renaming the label of a live question never orphans its answers.
The id is shown in the editor for exactly that reason.

## Discount ordering

A scholarship is the **last** discount in the stack:

```
cohorts.price_cents
  → listPriceCents()        repair a stale sale price
  → getRegionalPrice()      country override (IN: $115)
  → promoPriceCents()       site-wide sale from /admin/pricing
  → grantDiscountCents()    founder pass tier
  → scholarshipDiscountCentsForUser()   ← last
```

Ordering it last is what makes "50% off" mean half of what the student would
*actually* have been billed, and what stops a full-ride pass plus a scholarship
from producing a negative balance. `/dashboard/accepted` mirrors the same math
so the quoted price is the charged price.

## Emails

Six keys, all editable at `/admin/email/templates`:

| Key | When |
|---|---|
| `scholarship.received` | They submit |
| `scholarship.awarded` | Any award with money — says discount *or* refund, and lists perks in `{{perks_line}}` |
| `scholarship.awarded_calls` | Any perks-only award (the key predates 0074; the copy covers every perk) |
| `scholarship.declined` | Every decline, always |
| `scholarship.refunded` | Only once the Stripe refund actually succeeds |
| `scholarship.invite` | An admin nudges one student toward one scholarship |
| `demo_day.guest_ticket` | A guest, when a scholarship holder sends them a ticket |

Three automation events fire alongside them: `scholarship.submitted`,
`scholarship.awarded`, `scholarship.declined`.

Two pieces of copy are load-bearing and shouldn't be edited away:

- **`{{fulfillment_line}}`** in `scholarship.awarded` is the sentence that says
  either "your tuition is lower at checkout" or "this is coming back to your
  card". Without it the email can't tell them what happens next.
- **"This doesn't change your place at batch0"** in `scholarship.declined`.
  Students often read a scholarship no as a programme no.

`scholarship.declined` always sends. Silence here is uniquely bad: the student
is usually waiting on this answer to decide whether they can enrol at all.

## Permissions

- **`scholarships.view`** — opens `/admin/scholarships` and the queue, read-only.
- **`scholarships.manage`** — create, edit, award, decline, revoke, refund.

Both are **admin-area** keys: either one on its own opens `/admin`. Migration
0071 therefore grants **neither** to any role. Do not "just give mentors
`scholarships.view`" — that hands every mentor the payments page and the audit
log. `lib/permissions.test.ts` pins this; the mentor's real need is served by
the scholarship tag on the call request itself, no permission required.

## Tests

```bash
npm test                        # includes question-schema, scholarship-award, scholarship-window
npm run test:scholarships-db    # executes migration 0071 in PGlite
```

`test:scholarships-db` runs the **real** migration files (0071 and 0074)
against an in-process Postgres and asserts the constraints do what their
comments claim — the one-award index, the award-shape check, the cascade, the
`set null` on interview requests and guest tickets, and that 0074 rewrites a
legacy learner's grant without tripping the constraint it replaces. Worth
running before pasting a migration anywhere, since that step is done by hand.

## Files

| | |
|---|---|
| `supabase/migrations/0071_scholarships.sql` | Schema |
| `supabase/migrations/0074_scholarship_perks.sql` | Perks: catalog columns, award snapshots, $0 guest tickets |
| `lib/scholarship-award.ts` | Arithmetic + eligibility. Pure, tested, import-free apart from the window module |
| `lib/scholarship-window.ts` | Cohort-derived windows, cohort resolution, the scholarship-call bound. Pure, tested |
| `lib/scholarships.ts` | Everything that touches the database |
| `lib/question-schema.ts` | The admin-authored question type system. Pure, tested |
| `lib/application-questions.ts` | The 17 built-ins + the v2 config shape |
| `app/admin/scholarships/**` | Catalog, queue, review screen, refund button |
| `app/dashboard/scholarships/**` | Student list + application form |
| `components/admin/question-list-editor.tsx` | The question editor, shared by all three sections |
| `components/forms/custom-question-fields.tsx` | The public renderer for scholarship applications (`/apply` renders the same questions one per screen, in `app/apply/apply-flow.tsx`) |
