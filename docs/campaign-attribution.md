# First Search campaign: source → application → tuition

Use this final URL (cohort routing follows the current program availability):

`https://batch0.org/parents?utm_source=google&utm_medium=cpc&utm_campaign=batch0_search_2026`

Deploy migration `0086_campaign_attribution.sql` **before** this application code and before enabling the campaign. No new environment variables, Google conversion ID, pixel, or third-party API is required. This feature does **not** report conversions into Google Ads; configure that separately only after the real account settings and privacy requirements are reviewed. Never upload student identity to an advertising platform.

## What is measured

- Middleware sets a first-party, HttpOnly, SameSite=Lax cookie only for `google` + `cpc` + a `batch0_…` campaign label on `/`, `/parents`, `/program`, `/sample-lesson`, `/apply`, or `/start`. This includes all four first-campaign sitelink destinations. HTTPS uses Secure. Prefetches and non-GET requests do not capture visits.
- The cookie holds only source, medium, campaign label, approved landing path, and timestamp. It expires 30 days after capture; repeat/direct visits do not extend it. Search terms, click identifiers, full URLs, contact details, and payment tokens are not stored in it.
- A successful authenticated draft save or application submission attaches that source to the application. The first assignment wins. The database rejects attribution if the application predates the visit, preventing a later ad from claiming an existing lead.
- The private report at **Admin → Payments → Campaign payments** joins the payment ledger by application ID. The parent's browser need not have any campaign cookie. It uses the real discounted amount charged, deducts refunds, ignores pending/failed attempts, counts an application once across multiple payments, and excludes zero/free or fully refunded places from paid applications. Non-USD captures are flagged separately.
- Compare retained tuition with actual spend from Google Ads. Retained tuition is before Stripe fees and delivery costs; it is not profit. For a $120 test, one $117 charge does not recover spend. Applications and checkout starts are not purchases.

## Honest limits

This is **first tagged visit before application creation**, not causal lift or Google's attribution model. Untagged visits, disabled cookies, and applications more than 30 days later remain unattributed. An ad visit on a parent's device cannot be linked to an application independently started on a student's device; sharing the original tagged link carries the campaign label to the student's device. A later parent payment using the application-specific payer link **is** joined reliably. No historical source assignments are inferred or backfilled.

Measurement errors are logged under `[campaign-attribution]` and never prevent an application from saving. Treat such errors as a campaign-launch blocker until fixed, rather than interpreting missing rows as zero interest. The report throws a clear error if its migration is missing instead of displaying false zeroes. Source labels are not proof against deliberate cookie/URL tampering and do not grant discounts, admission, credit, or influence financial records.

## Verification before spend

1. Apply migration 0086 and load `/admin/payments/acquisition` with an authorized payment-viewing staff account.
2. In a clean browser, open the tagged `/parents` URL. Confirm the HttpOnly 30-day cookie, complete signup, and save/submit a test application. Verify one source row.
3. Complete that application's test-mode parent checkout from a separate clean browser/device. Confirm one paid application and the actual discounted charge in the report. Never manufacture production payments for this check.
4. Confirm a partial refund reduces retained tuition and a full refund removes that application's paid count. Existing parent-checkout/webhook tests cover payment settlement; attribution tests exercise the ledger join without relying on payer cookies.
5. Confirm untagged and pre-existing applications are not newly assigned to Search, and a second campaign cannot replace the first source.

Automated verification: `node --test lib/campaign-attribution.test.ts lib/campaign-attribution-db.test.ts`, then project type checking/build. The database tests execute migration 0086 in PostgreSQL-compatible PGlite and cover permissions, first-touch persistence, signup/application-to-payer linkage, actual charge/refund math, repeated migration, and deletion cleanup. They do not claim a live Google Ads conversion or a production Stripe purchase.
