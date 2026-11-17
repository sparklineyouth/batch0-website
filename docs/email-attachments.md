# Email attachments

Attaching a file to a one-off email from `/admin/email/compose`.

## Why it is built this way

The obvious implementation — put the file in the form, post it with the draft
— cannot work. A Next.js server action body caps at 1 MB, and the whole point
of this feature is a 4 MB PDF. So the bytes never travel through a server
action. They go straight from the browser into a private bucket, and the draft
carries a path.

That is not a workaround invented here; it is the flow every upload in this
repo uses (support attachments, chat files, challenge uploads, webinar decks).
The shape is always the same three steps:

1. **mint** — `app/admin/email/compose/attachment-actions.ts` checks
   `email.send`, builds the storage path itself, and returns a one-shot signed
   upload URL per file.
2. **upload** — the browser PUTs the bytes to that URL
   (`app/admin/email/compose/attachment-picker.tsx`).
3. **resolve** — at send time, `lib/email/attachments.ts` re-reads each object,
   measures what actually landed, and only then base64s it into a MIME part.

Everything the browser says about a file in steps 1 and 2 is advisory. It
exists so an honest person gets an instant, specific error instead of a failed
send thirty seconds later. **Step 3 is the enforcement**, and it is the only
place the real size and type of a file are knowable.

## The limits, and where they come from

| Limit | Value | Set by |
|---|---|---|
| Per file | 10 MB | `EMAIL_ATTACHMENT_MAX_BYTES`, and the bucket's own `file_size_limit` |
| Per email, all files | 10 MB | `EMAIL_ATTACHMENT_TOTAL_MAX_BYTES` |
| Files per email | 5 | `EMAIL_ATTACHMENT_MAX_FILES` |
| Recipients, when something is attached | 100 | `EMAIL_ATTACHMENT_MAX_RECIPIENTS` |

**The total is set by base64, not by us.** Mail carries attachments
base64-encoded, which costs 4 bytes for every 3, so 10 MB of file reaches the
wire as about 13.7 MB. Gmail and Outlook both bounce a message over 25 MB. A
10 MB total fits everywhere with room for the body; a 20 MB total would pass
our own checks and then bounce at the far end, which is the worst possible
place to fail. `lib/email-attachment-rules.test.ts` asserts the encoded size
stays under 25 MB, so raising the cap fails the suite rather than production.

**The bucket is the only hard stop.** A signed upload URL cannot carry a size
or type constraint, so a tampered client is stopped by storage or not at all.
That is why `file_size_limit` in migration 0112 and
`EMAIL_ATTACHMENT_MAX_BYTES` must agree, and why a test fails if they drift.

**The recipient cap is about egress, not security.** The same bytes are
uploaded to the mail provider once per recipient. 10 MB to 2,000 people is
20 GB, far past any serverless time limit, and a near-certain spam
classification for a list that size. Those sends want a link; the refusal says
so in as many words.

## What may be attached

By extension, never by MIME type — browsers disagree about what a `.csv` or a
`.docx` is, and a bucket that refuses on MIME surfaces as an opaque 400 with
nothing an admin can act on. (Same reasoning as migration 0087.)

Allowed: `pdf png jpg jpeg gif webp txt csv docx xlsx pptx ics`

Refused, each for its own reason, each with its own error message telling the
person what to do instead:

- **`svg`, `html`, `xml`** — active content a mail client would execute.
- **`doc`, `xls`, `ppt`, `docm`, `xlsm`, `pptm`** — legacy and macro-enabled
  Office. The OOXML forms above cannot carry a macro; these can, and a macro
  arriving from the accelerator's own domain is the most convincing phish a
  student will ever receive.
- **`zip`, `rar`, `7z`** — corporate mail gateways quarantine archives
  unopened, so the attachment silently never arrives.
- **`heic`, `heif`** — an iPhone photo most Windows recipients cannot open.
  The error says "export it as JPG".

The Content-Type that ships is derived from the **extension**, not echoed from
the browser or from storage. The recipient's mail client acts on it: a `.docx`
delivered as `application/octet-stream` downloads as an unknown blob, and one
delivered with its real type opens in Word.

## Scheduled sends

A scheduled email stores attachment **paths** on `email_outbox.attachments`
(jsonb, migration 0112), not bytes. Three reasons: a jsonb column is a poor
home for 10 MB of base64 and every query selecting the row would drag it
along; the file may legitimately be replaced in storage before the send time,
and the send should carry what is there then; and one stored copy is what lets
the orphan sweeper know the row still needs it.

Attachments are still **resolved at compose time** as well, even for a
scheduled send — `sendCompose` refuses immediately if a file is missing or
oversized. Discovering that at 6 a.m. on the send date, in a cron log, is how
an email goes out without the file it was written around.

At send time `sendQueuedRow` resolves the paths again. **A row whose file has
gone missing fails rather than sending without it.** An email written around
an attachment that arrives without one is worse than one that visibly did not
go: the outbox shows the failure and the reason, and somebody can fix it.
Nobody ever notices the other case.

One asymmetry worth knowing: a queued row's `user_id` is the *recipient*, not
the sender, so the drainer has no sender identity to re-check path ownership
against. `resolveAttachments(staged, null)` is how that is expressed. It is
safe because the path only reached the outbox after `sendCompose` resolved it
*with* the sender's id. The `null` narrows the call to "already authorized",
not "unchecked" — every storage-side check still runs.

## Cleanup

Uploads that are never sent would otherwise accumulate forever. The orphan
sweeper runs at the end of every `/api/cron/email-queue` drain (every five
minutes) and deletes objects that are **both** older than 24 hours **and** not
referenced by any unsent outbox row. The partial GIN index in migration 0112
is what keeps that reference lookup off a full scan of the outbox.

It is deliberately conservative: a storage or database error aborts the sweep
rather than falling back to "nothing is referenced" (which would delete
everything), objects whose age cannot be read are left alone, and it is capped
at 200 deletions per run. The cost of deleting a file someone is about to send
is an email missing its attachment; the cost of keeping one an extra day is
nothing.

Removing a file in the picker does **not** delete the object — it drops it
from the draft and lets the sweeper reclaim it. Deleting on removal would mean
a server round trip on every misclick, plus a delete-by-path endpoint.

## Files

| File | What it holds |
|---|---|
| `lib/file-name-rules.ts` | Shared file-name and content-type hygiene. Zero imports. Extracted from the support rules when email became a second caller. |
| `lib/email-attachment-rules.ts` | Limits, allow-list, path grammar, validation. Zero runtime deps, so the client picker can import it. |
| `lib/email-attachment-rules.test.ts` | Pins all of the above, including the base64 arithmetic and agreement with migration 0112. |
| `lib/email/attachments.ts` | Server side: mint, resolve-to-bytes, orphan sweep. |
| `app/admin/email/compose/attachment-actions.ts` | The mint server action. Permission + rate limit. |
| `app/admin/email/compose/attachment-picker.tsx` | The field. Uploads on pick. |
| `supabase/migrations/0112_email_attachments.sql` | Private bucket, `email_outbox.attachments`, the partial index. |

## Known gaps

- **Blasts and automations cannot attach.** Only the one-off composer can.
  That is the recipient cap's logical conclusion, not an oversight — but if
  per-cohort attachments are ever wanted, the enqueue path already carries
  them and only the UI is missing.
- **Templates cannot carry a default attachment.** Attachments live on the
  draft, so "the handbook, every time" means attaching it every time.
- **No virus scanning.** Same as every other upload surface in this repo. The
  extension allow-list is the whole of the defence, which is why it excludes
  archives and anything executable or macro-capable.
- **No per-recipient attachments.** One email, one set of files, for everyone
  on it. Mailing each graduate their own certificate is a different feature.
