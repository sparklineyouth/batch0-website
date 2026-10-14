# SMS: what we can send today, and what marketing texts would require

**Status:** we send program texts only. Marketing texts are **not** shippable
on the current data. This doc says why, and what it would take.

Not legal advice — written by the team, for the team. Before the first
promotional text goes out, a lawyer should read this page and the opt-in copy.

---

## Where the number comes from

| | |
|---|---|
| Collected at | `/apply`, field `phone` in `lib/application-fields.ts` |
| Required? | **Yes** — `required: true`, enforced server-side in `app/apply/actions.ts` |
| Backfill for earlier applicants | `/dashboard/phone` |
| What we promise | Program use only, no marketing, never sold — `app/(legal)/privacy/page.tsx`, `app/dashboard/phone/page.tsx` |

## Why marketing texts are blocked

Two independent blockers. Fixing one does not fix the other.

**1. The field is required.** The TCPA's standard for marketing texts is
*prior express written consent*, and one of its required elements is a
statement that consent is **not a condition of purchase**. A phone number you
cannot submit the application without is, by construction, a condition of
participation. A required field can never carry marketing consent — no wording
in the privacy policy changes that.

What we *do* have is *prior express consent*: the lower bar that covers
messages directly related to the context the number was given in. Application
status, kickoff logistics, deadline reminders, session changes. That is what
we send, and it is fine.

The line is blurrier than it looks. A message containing a link, a CTA, or
anything promotional is treated as marketing even if it also carries program
information. "Your kickoff is Tuesday" is transactional. "Your kickoff is
Tuesday — and applications for batch1 are open, tell a friend" is a marketing
text with a logistics sentence stapled to the front. When in doubt, it's
marketing.

**2. We already promised not to.** Every student who submitted an application
read some version of "we don't use it for marketing, and we never sell it."
Collecting data under one promise and then broadening the policy to permit a
different use is a deception problem (FTC Act §5, state UDAP) layered on top
of the TCPA one. A privacy-policy edit does not reach backward: the promise
that was live when they typed the number is the one that binds.

So: **numbers already on file can never be marketed to.** Not after a policy
update, not after a banner, not after an email saying "we've updated our
terms." The only route is a fresh, affirmative opt-in from that person.

## Cost of getting it wrong

$500 per text, trebled to $1,500 if willful, per recipient — not per lawsuit.
A single 60-person cohort and a dozen messages is a six-figure exposure.
State mini-TCPAs stack on top (Oklahoma adds a three-message daily cap even
*with* valid consent; Connecticut penalties reach $20,000 per violation).

Separately, carriers enforce their own rules. 10DLC campaign registration is
independent of the TCPA, and a campaign with a non-compliant opt-in flow gets
rejected or suspended regardless of what our policy says. The no-sharing
clause in the privacy policy exists for this — don't delete it.

## What shipping marketing texts would actually require

1. **A separate, unchecked opt-in checkbox**, not bundled with the ToS
   checkbox and not pre-ticked. Its own consent string, naming batch0,
   describing the message types, stating frequency varies, stating message and
   data rates may apply, and stating consent is not a condition of applying.
2. **A new column** (`sms_marketing_consent`) plus a consent-event table —
   timestamp, IP, user agent, the exact consent string shown, and the form
   URL. Version the string; in a dispute we must prove what the form said on
   the day they ticked it, not what it says now. Keep opt-out events in the
   same table.
3. **Guardian confirmation for under-18s.** We already collect `parent_email`.
   A checkbox a 16-year-old ticks is not guardian permission — the email has
   to go out and be confirmed before the number is marketable.
4. **A re-consent campaign for existing members.** Over email (CAN-SPAM, far
   lower bar) linking to the opt-in form, or a keyword opt-in they initiate.
   **Do not text the existing list to ask them to opt into texts** — that
   text is itself the violation. Expect to lose a large share of the list.
   That is the correct outcome, not a failure of the campaign.
5. **Revocation handling.** Since 2025-04-11, a person may revoke by any
   reasonable method — a reply, an email, a support ticket, telling us in
   Discord — not just by texting STOP. Honor within 10 business days, at most
   one confirmation message. This has to be a real suppression list the
   sending path checks, not a note in someone's inbox.
6. **10DLC registration** for the sending number, with the opt-in flow
   screenshotted for the carrier review.

`lib/sms-consent-policy.test.ts` locks the promises in items (1)–(5) so a copy
edit can't quietly undo them.

---

## Open issue: `age` accepts 10

`app/apply/actions.ts` validates `age: z.coerce.number().int().min(10)`, so a
10-, 11-, or 12-year-old can submit the form — and `phone` is required, so
they submit a phone number with it.

Under 13, a phone number is personal information under COPPA and collecting it
needs **verifiable** parental consent. We require `parent_email` for anyone
under 18, which is good, but an unconfirmed email address typed by the child
is not verification.

Two ways out, and this is a product call, not a legal one:

- **Raise the floor to 13** in the Zod schema (and say so on the form). batch0
  is a high-school program; this likely matches intent and is a one-line fix.
- **Keep under-13 eligibility** and build a real verifiable-consent flow
  before an under-13 applicant can submit a phone number.

Until one of those lands, this is the sharpest edge on the page.
