# Texting

SMS is a second channel next to email, and it is inert until a carrier approves
a number to send from. The code is shipped and switched off; the long pole is
entirely outside the app, and it is a verification form read by a human at a
carrier.

**What it sends: program texts to a student's own number, nothing else.** A
session starting, a schedule change, a deadline. No promotional or marketing
texts — the privacy policy promises that (`lib/sms-consent-policy.test.ts`
locks it), `lib/sms/policy.ts` enforces it at every layer that could produce
one, and `docs/sms-marketing-opt-in.md` lists what would have to be built
before that could change. Parent and guardian numbers aren't collected for the
same reason: in the design this was ported from, they only ever existed to
receive promotional texts.

This document is the whole path from "we have a Google Workspace account and a
Stripe account" to "a real text reached a student". Read the cost section
before you buy anything, and read the Google Voice section before you argue
with the cost section.

**Every price and rule here was checked against primary sources in September
2026. Re-check the prices.** Carrier surcharges on US messaging changed three
times during 2026. The *structure* of the bill is stable — a monthly fee for the
number plus a per-segment fee split between the provider and the carrier — but
the cents move, and they only ever move up. Twilio's pricing page is the
authority, not this file.

---

## Why not Google Voice

This is the first question anybody asks, because the account already exists and
already has a phone number attached. The answer is no, and it is not a
close call.

**There is no API.** Google's public API discovery index lists 535 APIs and not
one of them is a Voice or telephony *send* endpoint. `voice.googleapis.com` is
not a registered public API — nothing to authenticate against, nothing to POST
to. The only official Voice API surface is administrative:

- a Cloud Identity policy boolean, for turning Voice on and off for the org,
- Voice license SKUs in the Enterprise License Manager API (product `101033`),
  for assigning seats,
- read-only audit logs under `applicationName=voice`.

You can license a seat, and you can read what happened afterwards. You cannot
send a message.

**And if you found a way, the terms forbid it.** The Voice Acceptable Use Policy
bans "sending messages via an automated process, such as a script", and
Workspace Service Specific Terms §8.9 reserves Google's right to block "bulk or
automated messages". The account at risk is the one that runs `hello@batch0.org`
and every student's calendar. No Workspace tier changes any of this; there is no
enterprise unlock, because there is no product to unlock.

**The adjacent Google options are also dead.** Google Business Profile messaging
was discontinued in July 2024. RCS for Business is partner-gated — you reach it
through an aggregator, i.e. through exactly the kind of vendor we're deciding
between anyway. Google Cloud has no first-party SMS product at all.

So: reaching a phone with a text means a carrier relationship. That is the only
reason this feature has a credentials screen.

---

## What the Google account IS good for

Two adjacent channels that are genuinely free and genuinely useful. **Neither is
SMS**, and neither is a substitute — they reach a subset of people who already
did something, where a text reaches a number someone gave us.

| Channel | Cost | Reaches | Limit that matters |
|---|---|---|---|
| Firebase Cloud Messaging web push | Free, unlimited | Anyone who installed the PWA at `app.batch0.org` and granted notification permission | Install + permission is a two-step ask; iOS only allows web push from an installed home-screen app |
| Google Wallet pass push (Add Message API) | Free | Anyone who saved a founder pass to Wallet | 3 messages per pass per 24h |

Both are worth building. FCM lands on the lock screen of the students who are
most engaged — they installed the app — for zero marginal cost, and the PWA at
`app/app/**` is already installable. Wallet push fits the existing founder-pass
system: the pass is already in their wallet, and the Add Message API puts a line
on it without asking for anything new.

Use them for the things a text would be wasteful for. Keep SMS for the message
that has to arrive whether or not somebody installed anything.

---

## The number: toll-free, verified

**Buy a toll-free number and submit it for toll-free verification.** Not a local
10DLC number.

At 2,000 messages a month, all-in:

| | Toll-free (chosen) | Local 10DLC |
|---|---|---|
| The number | $2.15/month | $1.15/month |
| Per outbound segment | ~$0.0113 — $0.0083 Twilio base + ~$0.003 blended carrier surcharge | ~$0.0123 |
| Campaign fee | none | $1.50/month |
| **Monthly at 2,000 segments** | **~$24.75** | ~$27.25 |
| **One-time** | **$0** | $19.50 ($4.50 brand registration + $15 campaign vetting) |
| Approval path | Toll-free verification form, reviewed by the carrier | The Campaign Registry: brand registration, then campaign vetting |
| Time to first send | Days | 1–3 weeks |

The money difference is noise. **The reason to choose toll-free is that it skips
The Campaign Registry entirely** — no brand registration, no campaign, no
vetting fee, no monthly campaign fee, and nothing that asks us to reconcile a
legal name with a brand name.

That last one is not hypothetical. The legal entity is **Sparkline Youth LLC**
and every message says **batch0**. 10DLC brand vetting compares the registered
brand against the sending content, and a mismatch is a standard rejection —
surfacing as Twilio error `30918` — which you then appeal by explaining a DBA to
a vetting vendor. Toll-free verification asks for the business name and the
opt-in flow and does not do that comparison.

**Telnyx** is the other credible provider and would save roughly $99 a year at
this volume. `sms_settings.provider` already accepts `'telnyx'` and
`lib/sms/providers/index.ts` throws a readable "not implemented" for it, so
switching later is one new file and a dropdown option — not a migration. It is
not worth doing now: $99/year does not pay for a second verification cycle.

---

## What turns it on

**No environment variable turns texting on.** It is on when, and only when,
migration 0106 has run AND an admin has saved an Account SID, an auth token and
the sending number at `/admin/sms/settings`. Until then `sendSms()` returns
`{ ok: false, reason: "disabled" }` and parks nothing, the drain at
`/api/cron/sms-queue` returns at once without reading a row, the webhook
answers **503** to everything, the dashboard prompt and the opt-in email stay
hidden, and the campaign composer shows "Texting isn't sending yet" instead of a
form. That is the state this ships in.

The environment variables it *relies on* are ones production already has:

| Variable | What texting uses it for |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | The webhook URL Twilio signs (`https://batch0.org/api/webhooks/sms`, exactly) and the status-callback URL sent with every message. Must match the Twilio console byte for byte — see step 2. |
| `CRON_SECRET` | Authenticates Vercel's cron call to `/api/cron/sms-queue`, the same as every other cron. Unset, the route answers 500 and drains nothing. |
| `SUPABASE_SERVICE_ROLE_KEY` | Every texting read and write is service-role (0106 grants the browser roles nothing). |
| `EMAIL_SECRET_KEY` *(optional)* | Encrypts the stored auth token, as it does the SMTP password (`lib/email/secret.ts`). Unset, the key falls back to a hash of the service-role key. Rotating it means re-entering the auth token. |

**Why the credentials live in the database and not in the environment:**

1. The same reason as email: rotating a token is an admin action by someone who
   may not have a Vercel login, and it should not require a redeploy.
2. `vercel env pull` returns this project's environment variables as **empty
   strings**. A live-key check run locally would therefore always fail, and
   "fails locally, works in production" is the worst possible shape for a
   credential test. The settings row is readable from the deployed environment,
   which is the only place a real send can happen anyway.

---

## Turning it on, in order

**The order is not a preference.** Steps 1 and 2 are slow and involve someone
else's queue; step 3 has to precede any opt-in; step 4 is the one that makes the
feature stop being inert. Doing 4 before 1 gives you a settings screen that
saves credentials for a number that cannot legally send.

### 1. Buy the number and submit toll-free verification

Create the Twilio account, buy a toll-free number, and open the toll-free
verification form for it. It asks for, and you should have ready:

- **Business information** — Sparkline Youth LLC, the business address, a
  contact name, email and phone. Use the legal name here; the brand name goes
  in the sample messages.
- **The opt-in URL** — `https://batch0.org/dashboard/phone`. This is the page
  students use to give a number and tick the texting box. It shows the
  checkbox as soon as 0106 has run, before any credentials exist, precisely so
  it can be reviewed — and it says texts haven't started yet.
- **A screenshot of the opt-in** — see the warning below.
- **A description of the opt-in workflow** — in prose: a signed-in student
  enters their own number and ticks an unchecked box specific to texting; the
  exact sentence they agreed to is stored with a timestamp, IP and browser.
  Students under 13 are not offered texts.
- **Sample message bodies** — paste real ones, including the trailing
  "Reply STOP to opt out" disclosure. Take them from `lib/sms/copy.ts` and the
  campaign you actually intend to send first, not from imagination.
- **Expected monthly volume** — estimate honestly. 2,000/month is the costing
  assumption above; actual first-month traffic will be a fraction of it.
  Inflating it invites scrutiny and buys nothing.
- **Privacy policy URL** — `https://batch0.org/privacy`. Its **Text messages
  (SMS)** section covers what we send, no marketing, no sharing, STOP and
  revocation; the terms at `https://batch0.org/terms` and the page at
  `https://batch0.org/messages` cover the rest.

**The number one cause of rejection is the screenshot.** A carrier reviewer is
looking for one specific thing: a checkbox that is (a) **unchecked** by default,
(b) **specifically about SMS** — not a general terms-of-service tick — and (c)
sitting next to **the full disclosure text**, including message frequency,
"Msg & data rates may apply", and how to stop. A screenshot of a pre-ticked box,
or of a box whose label says "I agree to the terms", is a rejection and a
re-submission.

That requirement is the entire reason `/dashboard/phone` is built the way it is:
one checkbox, never pre-ticked, rendering `CONSENT_COPY.studentTransactional`
verbatim. Do not "tidy up" that copy to fit the layout — the sentence in the
screenshot, the sentence in the database, and the sentence on the page have to
be the same sentence.

Before you submit, click every URL on the form yourself. `HELP_REPLY` and the
privacy policy both point people at `batch0.org/messages`; reviewers follow
links, and a 404 on the page your own help text names is an avoidable round trip.

### 2. Configure the Twilio console webhooks

On the number's configuration page, set **both**:

- **"A message comes in"** → `https://batch0.org/api/webhooks/sms`, method
  **POST**
- **Status callback URL** → `https://batch0.org/api/webhooks/sms`, method
  **POST**

One route handles both because Twilio posts them in the same shape and telling
them apart is a one-line check on whether `Body` is present. The send path also
sets `StatusCallback` per message, so the console status-callback field is a
backstop for anything sent outside the app — point it at the same URL rather
than leaving it blank. The route is excluded from the session middleware
(`middleware.ts`): a provider's POST carries no session, and the signature is
its only authentication.

**`NEXT_PUBLIC_SITE_URL` must match what you typed, byte for byte.** Twilio signs
the request over the URL string it was configured with. Behind Vercel's proxy
`req.url` reports an internal host, so the route reconstructs the signed URL from
`env.siteUrl` — `https://batch0.org/api/webhooks/sms`. A scheme difference, a
trailing slash, or `www.` on one side and not the other, and
`verifyWebhook` returns false and the route answers **403 to every request**:
no delivery receipts, and — worse — no STOPs.

Two symptoms worth memorising:

- **403 on every webhook** → the URL doesn't match. Compare the console entry to
  `NEXT_PUBLIC_SITE_URL` character by character.
- **503 "Not configured"** → no auth token in `sms_settings`. The route refuses
  to parse an unverifiable request at all, because an unauthenticated endpoint
  here would let anyone on the internet suppress our messaging to any number
  they chose and mark unsent messages as delivered.

**Check what Twilio itself replies to STOP, START and HELP.** Twilio can answer
those keywords on its own, before this app sees the message (the number's, or
its messaging service's, opt-out settings). If both reply, someone who texts
HELP gets two answers; if Twilio's wording differs from `lib/sms/copy.ts`, the
text and `/messages` disagree. Make them agree, or turn Twilio's off for the
keywords this app answers. Either way the app records the opt-out — the inbound
message still reaches the webhook.

### 3. Apply migration 0106

`npm run db:migrate -- --apply` (SETUP.md §2), or paste
`supabase/migrations/0106_sms_messaging.sql` into the Supabase SQL editor. It is
idempotent and touches nothing that exists: six new tables, all service-role
only, and the `sms_settings` row seeded with **no** credentials. Its verify
query is in `docs/migrations-2026-10.md`.

It changes nothing about the numbers already on file, and creates no consent.
Those numbers were collected for program contact, so they make someone
*callable*, not *textable*: consent is collected fresh, at `/dashboard/phone`,
or it does not exist. The app reads `applications.phone` and normalizes it to
E.164 with `lib/phone.ts` whenever it needs to dial — there is no stored copy to
drift, and nothing on `applications` the student could write.

Code that reads these tables before the SQL exists treats "does not exist" as
"not set up yet" (`lib/schema-ready.ts`): the Texting admin pages say so,
`/dashboard/phone` collects a number without the checkbox, and nothing sends.

### 4. Enter the credentials at `/admin/sms/settings`

Account SID, auth token, and the toll-free number in E.164 (`+18005551234`).
Check quiet hours while you're there (9–20 by default) and leave the help text
alone unless you have a reason. This is the step that turns texting on.

### 5. Grant the permissions at `/admin/roles`

Three keys: `sms.view` (read the outbox and who opted in, and record an opt-out
someone asked for by email or support), `sms.send` (send campaigns and test
texts, cancel queued ones, email the opt-in request — it needs `sms.view`
alongside), `sms.settings` (credentials, number, quiet hours, pause switch).
Wildcard roles already have them; every other role needs them ticked
explicitly. The sidebar has one **Texting** row; its tabs hide what a viewer
cannot reach, so a tab is never a link to a 403.

`sms.send` is deliberately separate from `email.send`. An email send is free and
a text costs money and reaches a phone.

### 6. Collect numbers

`/admin/sms/collect` lists accepted, paid and enrolled students with whether
their number on file can be texted and whether they've turned texts on. Once
texting is live it can email everyone who hasn't — never someone who opted
out, and never an under-13. Before then the button is replaced by a note:
asking people to turn on texts we can't send yet is a promise we can't keep.
The dashboard's "Turn on text updates?" row follows the same rule.

**Face the current reality before planning a campaign.** As of October 17, 2026
there are **13 phone numbers across 71 applications**, and every one of them is
a number given for program contact, not consent to text. So the first SMS
"campaign" is necessarily **an email**. Check the collect page for the live
count before you believe these numbers.

### 7. Test, then send

`/admin/sms/blast` requires a test send before the campaign button exists. Point
it at your own phone and tick **"This is my own mobile number…"**: staff have no
application, so they can't opt in at `/dashboard/phone`, and that box records
your agreement in the consent ledger the same way a student's is recorded
(`CONSENT_COPY.adminTest`, your account, IP and browser). It can't opt in a
number that belongs to a student, and can't undo anyone's opt-out.

It is a **real message**, it costs real money, and it is the only end-to-end
check of the whole chain: credentials → consent gate → quiet hours → provider →
delivery receipt landing back on the webhook. Watch `/admin/sms/outbox` go
`sent`, then check the phone. If the text arrives but nothing in the outbox
says so, step 2 is wrong.

Then write the real campaign. The composer shows the audience, who is
unreachable and why, the segment count, the cost, and which recipients will be
deferred for quiet hours. Audiences are the program segments only — enrolled,
accepted, waitlisted, applied.

---

## Operating notes

**Quiet hours are 9am–8pm recipient-local**, an hour tighter on each side than
federal law requires. The timezone is inferred from the area code; we do not ask
for one and never will. When the area code is unmapped or non-NANP, the send
must be inside the window in **both** Eastern and Pacific — so an unknown number
is not textable until noon Eastern, which is the point. Defaulting to Eastern
would text a California number at 6am.

**Quiet hours defer; they never drop.** A message outside the window is parked
with a `send_after` at the next allowed quarter-hour. Fifteen-minute steps rather
than hourly, so a hundred deferred messages don't all leave at exactly 09:00:00.

**Opt-outs are automatic, and arrive more than one way.**

- **By text.** STOP and the other keywords — and a sentence asking us to stop
  ("please stop texting me", "wrong number"; `expressesRevocation` in
  `lib/sms/keywords.ts`) — are written *before* the reply is composed, return
  500 on a failed write so the provider retries, cancel every pending outbox
  row for the number, and get exactly one confirmation. HELP is always
  answered. Anything else gets an honest "this number isn't monitored, email
  us"; nobody is watching the number.
- **From the dashboard.** "Turn texts off" at `/dashboard/phone`.
- **Any other way.** The privacy policy promises that a reply to an email, a
  support request or `hello@batch0.org` works too, within 10 business days, and
  that a parent or guardian can stop texts to their student's number. Those
  become real suppressions at `/admin/sms/consent` → **Record an opt-out**
  (`sms.view`). Do it the day it arrives.

Only a START from the phone lifts a STOP, a carrier block, or an opt-out an admin
recorded — the dashboard checkbox can't, because anyone can type a number into a
form (`lib/sms/consent-rules.ts`).

**The drain runs every 5 minutes** (`vercel.json` → `/api/cron/sms-queue`), at
most 60 messages per invocation, with retries at 5 and 30 minutes and 3 attempts
before a row is failed for good. The 60 is arithmetic, not taste: the route gets
60 seconds, each message costs 350ms of deliberate spacing (to stay under what a
toll-free number is provisioned for) plus provider and database I/O. The drain
also watches the clock and hands back any claim it did not get to, so an overrun
costs five minutes rather than stranding rows until the reclaim pass. Before
texting is set up it returns at once with an `inert` reason and logs nothing.

**The kill switch is `sms_paused` at `/admin/sms/settings`.** It **queues rather
than drops** — the same semantics as `automations_paused` for email — so the
backlog goes out when you unpause, subject to quiet hours. That means pausing is
**not** cancelling: if you pause to stop a campaign and then forget, you have
scheduled a surprise. Killing a campaign for good is **Stop this campaign** on
the outbox (filtered to it), which moves its pending rows to `canceled` — the
only state the drain will not pick back up.

**One emoji triples the cost of a message.** A single non-GSM-7 character forces
the whole body to UCS-2, and capacity drops from 160 characters to 70 (67 per
part once it's multipart). A 150-character message goes from 1 segment to 3. The
composer shows the encoding, the segment count and which characters caused it,
and `toGsmSafe()` offers the substitutions. `MAX_SEGMENTS = 6` refuses anything
longer outright rather than billing for it.

**The first message to a number gets the help text appended** automatically,
unless the body already contains "STOP". That can push a one-segment message
over the boundary, which is why the segment count is re-measured after the
disclosure is added — the billed number is the one measured last.

---

## The compliance rules the code enforces

These are not preferences and the UI must never offer to override them.

**Program texts only.** `MARKETING_TEXTS_ENABLED` in `lib/sms/policy.ts` is
`false`, and the consent writer, the transport, the queue and the composer all
read it: nothing can record promotional consent, queue a promotional row, or
send one. `lib/sms-policy.test.ts` fails if it is switched on. A program text
with a pitch stapled to it is a marketing text (`docs/sms-marketing-opt-in.md`),
so the composer says so beside the message box.

**A student's number can never carry promotional consent.** Most batch0
students are minors, and whether a minor can give valid written consent to
marketing texts has never been decided. Even with marketing off, the schema
refuses it (`messaging_consent_no_promo_to_students`), so any future marketing
path starts from a database that won't text a minor an offer.

**Under-13s aren't offered texts.** The application accepts an age of 10, and
under 13 a phone number needs verifiable parental consent under COPPA, which a
box the child ticks is not (`docs/sms-marketing-opt-in.md`, "Open issue").
`SMS_MIN_AGE` in `lib/sms/policy.ts`; the opt-in page, its action, the audience
and the prompt all check it.

**The consent ledger is append-only and stores the exact rendered sentence.**
`messaging_consent_log` keeps the string the person actually saw — not a version
pointer into a file that will be edited next month. The evidence has to survive
the code changing. Editing `CONSENT_COPY` changes what future opt-ins agree to
and leaves every existing row exactly as it was, which is the whole design. The
trigger still lets a profile be deleted (the FK nulls `user_id`), and the
consent row outlives the account, as the privacy policy says.

**Revocation is honoured immediately.** The FCC rule that took effect April 11,
2025 gives ten business days to honour an opt-out made by any reasonable means.
Ten business days is the outer bound we are measured against, not a budget to
spend.

**Consent is checked at send time, by the transport.** The admin UI shows
reachability; it does not re-implement the gate. A consent that was valid when a
campaign was queued can be revoked before the row drains, and the drain rechecks
it. Code that decides reachability anywhere other than `canSend()` /
`sendVerdict()` is a second gate that will drift out of agreement with the first.

---

## Where it lives

| Layer | File |
|---|---|
| Schema | `supabase/migrations/0106_sms_messaging.sql` |
| Numbers | `lib/phone.ts` |
| Policy: program texts only, the age floor, the audiences | `lib/sms/policy.ts` |
| Every sentence it shows or sends | `lib/sms/copy.ts` |
| Segments / encoding (client-safe) | `lib/sms/segments.ts` |
| Quiet hours | `lib/sms/quiet-hours.ts` |
| Settings + credentials | `lib/sms/settings.ts` |
| Consent decisions / writes | `lib/sms/consent-rules.ts`, `lib/sms/consent.ts` |
| Inbound keywords and revocation phrases | `lib/sms/keywords.ts` |
| Transport | `lib/sms/send.ts`, `lib/sms/providers/twilio.ts` |
| Audience | `lib/sms/audience.ts` |
| Drain | `lib/sms/queue.ts`, `app/api/cron/sms-queue/route.ts` |
| Receipts + inbound | `app/api/webhooks/sms/route.ts` |
| Admin | `app/admin/sms/**`, `components/admin/sms-tabs.tsx` |
| Opt-in | `app/dashboard/phone/**`, `components/sms-consent-prompt.tsx` |
| Public terms | `app/(legal)/messages/page.tsx`, the SMS sections of `/privacy` and `/terms` |

---

## Not built yet

- **Marketing texts, and parent numbers.** Off by policy. The list of what
  they'd need is `docs/sms-marketing-opt-in.md`; the schema already has the
  `purpose` and `party` columns and the no-promo-to-students check to build on.
- **DB-editable SMS templates.** Email bodies are rows in the database, editable
  at `/admin/email/templates` with a compiled fallback. SMS bodies are written
  in the composer. The pattern to copy is `lib/email/templates.ts` plus the
  restore action.
- **Event-triggered SMS.** The email event bus already fires on payment,
  acceptance, session start and the rest; nothing subscribes a text to it. A
  text is the right channel for exactly one of those events (a session starting
  in ten minutes), which is the case worth wiring first.
- **An inbound inbox.** Inbound texts are logged in `sms_events`, and the ones
  that opt out show on the consent page, but there is no admin view of the
  rest — the auto-reply tells people to email instead.
- **MMS.** Outbound is text-only. Images cost more per message and change the
  carrier's view of the traffic.
- **A better timezone than the area code.** The inference is right for the large
  majority of US numbers and wrong in a bounded, known way for the rest — a
  ported number that moved coasts is invisible to it.
- **A second provider.** `lib/sms/providers/` is shaped for one and
  `providerFor()` throws for `telnyx` rather than pretending. Adding it is a file
  plus a settings option, and worth about $99/year at this volume.

---

## Verifying it

None of these touch the live database or send a message:

```bash
npm test                        # segments, quiet hours, keywords and revocation
                                # phrases, consent rules, the policy locks, phone,
                                # and the webhook route end to end against an
                                # in-memory database
npm run test:sms-messaging-db   # runs migration 0106 against real Postgres (PGlite)
npm run build                   # asserts /messages stays prerendered
```

`test:sms-messaging-db` is the one worth knowing about. It executes the actual
migration file on a throwaway Postgres and asserts the things that only fail in
production: that the consent ledger refuses every edit to the evidence *and*
still lets a profile be deleted, that the database refuses promotional consent
on a student's number, that RLS is on with no policies and `anon` /
`authenticated` hold no grants, that `sms_settings` is a seeded singleton with no
credentials, and that the idempotency keys are really unique.
