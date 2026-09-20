# Enrollment recovery operations

`/admin/recovery` requires `applications.review`. It shows accepted applications scoped to one cohort, matched against that student's payments and enrollments. Paid/enrolled/refunded/paused applications and closed/full cohorts are held for review. Staff/test accounts are excluded from ready counts. An expired checkout attempt is not a lost customer.

Notes and contact timestamps live in `recovery_followups`, a service-role-only table. They are not stored on the student-readable application row. Each update rechecks staff permissions and records an audit event. The application pause flag cannot be changed through authenticated student table writes. Creating a parent invitation does not send it.

Payment reminders retain the student's application/cohort identity even when addressed to a parent. The dispatcher rechecks the automation, its current step and condition, the latest payment and enrollment state, pause status, capacity and admissions deadline immediately before sending. Ambiguous identity or an unavailable payment check holds the message. Scheduled fan-outs honor the configured rolling repeat window and a shared unique bucket prevents concurrent repeats. Receipts retain captured amounts; only forward-looking acceptance/reminder messages refresh a scoped quote.

Migrations 0080–0083 were applied atomically on September 20, 2026 after a rollback rehearsal. 0082 preserves the prior template version, removes expired promotion/held-seat claims, pauses the old reminder campaign, scopes it to Fall and changes it to manual review. No emails were sent. 0083 restores 18 Fall events within September 14–November 13 and authorizes late entry through September 22, 23:59:59 Eastern with catch-up support. The intro room was recreated privately and its event URL verified; all 18 rooms were checked to survive their corrected session end.

For a new recovery campaign, review each family and record its actual blocker. Never treat all accepted applicants as reserved seats. Use the parent guide and sample lesson, then a private payer invitation for interested families. Existing regional applicants should generate the invitation themselves when their application lacks stored pricing geography. The refund policy is unchanged.

Validation: `npm test`, `npx tsc --noEmit`, `npm run build`, the actual SQL migration tests, and desktop/mobile browser checks. Run the admin Payments → Sync Stripe action after release to silently reconcile real captures, success timestamps and refund state. It reads Stripe and updates internal records; it creates no new charge or refund.

Revenue periods use America/New_York calendar boundaries. A Sunday evening payment stays in the prior week even when its UTC timestamp is Monday. DST changes are covered; check-in week keys retain their original convention.
