# Scholarships

Three kinds of scholarship, two ways of paying one out, applied for after
acceptance **or** after enrolment.

| Kind | What it's for | Pays out as |
|---|---|---|
| **Need-based** | Money, decided on financial circumstances | Tuition discount or refund |
| **Merit** | Money, decided on extra questions you write | Tuition discount or refund |
| **Learner's** | Students who'll use mentor time | N extra 1:1 mentor calls |

`kind` is a label. **`award_type` is what decides the payout**, so a merit
scholarship that grants mentor calls is creatable without a deploy.

## Before you start

Migration `0071_scholarships.sql` must be applied. Paste it into the Supabase
SQL editor or `supabase db push` from the repo root. It's idempotent — a
double-paste is harmless.

Then click **Restore built-in templates** at `/admin/email/templates` to make
the six scholarship emails editable. Until you do, they still send: every one
falls back to a compiled version in `lib/email/templates.ts`.

## Setting one up

1. `/admin/scholarships` → **New scholarship**. Name it, pick what it pays out,
   pick who can apply (accepted, enrolled, or both), optionally cap the seats
   and set an open/close window.
2. Save, then add its questions on the same page — or from the
   **Scholarship questions** section of `/admin/application-questions`, which
   has a dropdown for every scholarship plus the shared block.
3. It appears on the dashboard of every student it's open to.

A scholarship with no questions is fine and common: applying becomes a single
button, which is right for a learner's grant.

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
an award from a past cohort. A pending application elsewhere also blocks — else
someone could queue up five and take whichever landed first, and the seat counts
would stop meaning anything.

## Mentor-call credits

A learner's-scholarship call is an ordinary `interview_requests` row with
`scholarship_application_id` set, so it lands in the team's existing queue at
`/admin/calls` and rides the existing `call_invites` / Daily plumbing.

**The credit is spent when the team schedules the call**, not when the student
asks. A request nobody picks up costs them nothing. Cancelling a scheduled call
hands the credit back.

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
| `scholarship.awarded` | Money award — says discount *or* refund |
| `scholarship.awarded_calls` | Learner's grant |
| `scholarship.declined` | Every decline, always |
| `scholarship.refunded` | Only once the Stripe refund actually succeeds |
| `scholarship.invite` | An admin nudges one student toward one scholarship |

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
npm test                        # includes question-schema + scholarship-award
npm run test:scholarships-db    # executes migration 0071 in PGlite
```

`test:scholarships-db` runs the **real** migration file against an in-process
Postgres and asserts the constraints do what their comments claim — the
one-award index, the award-shape check, the cascade, the `set null` on
interview requests. Worth running before pasting the migration anywhere, since
that step is done by hand.

## Files

| | |
|---|---|
| `supabase/migrations/0071_scholarships.sql` | Schema |
| `lib/scholarship-award.ts` | Arithmetic + eligibility. Pure, tested, import-free |
| `lib/scholarships.ts` | Everything that touches the database |
| `lib/question-schema.ts` | The admin-authored question type system. Pure, tested |
| `lib/application-questions.ts` | The 17 built-ins + the v2 config shape |
| `app/admin/scholarships/**` | Catalog, queue, review screen, refund button |
| `app/dashboard/scholarships/**` | Student list + application form |
| `components/admin/question-list-editor.tsx` | The question editor, shared by all three sections |
| `components/forms/custom-question-fields.tsx` | The public renderer, shared by `/apply` and scholarships |
