# Fall → Winter admissions rollover

Fall 2026 remains open for new applications and new checkouts through September 30, 2026, 11:59:59.999 p.m. America/New_York. The next instant is October 1 at midnight Eastern (04:00 UTC). Migration `0085_fall_admissions_rollover.sql` aligns both Fall admission deadlines and updates its catch-up instructions. It preserves the September 14–November 13 program calendar, active status, prices, Winter's deadline, existing applications, enrollments and course content.

`cohortEligibility` is shared by public admissions, application submissions and checkout. `selectAdmissionCohort` ignores a closed or full pinned cohort and selects the earliest available intake. The public config caches the cohort/settings facts for five minutes but selects the default against the current clock on each render. Home and Program explicitly wait for a request; their visible dates, metadata and course structured data therefore switch together without waiting for ISR. Parents already renders per request. Secondary static marketing pages retain their existing revalidation windows; their application links lead to the live admissions gate.

A new visitor's unqualified application defaults to Winter after the cutoff. An explicit Fall application URL or a saved Fall draft instead shows that the intake is unavailable and asks the student to choose an open cohort. Selecting Winter deliberately can continue a draft with its existing answers. Submitted, accepted, paid and enrolled applications remain locked to their existing lifecycle and are not reassigned. A Fall parent guide URL continues to show Fall information with closed admissions; an open parent's Apply button carries the displayed cohort explicitly.

Enrolled access is based on the enrollment and its cohort, not the marketing default. Closing admissions must never mark the still-running Fall cohort completed or update existing students to Winter.

New Fall checkout and invitation requests stop at the cutoff. A valid checkout reservation made beforehand retains its existing 35-minute payment window; its eventual payment and delayed webhook remain attached to Fall. This existing grace prevents taking a payment for an already reserved seat and then denying access. No checkout is canceled by this change.

## Verification and rollout

Run the admission, reapplication, public-config rollover, checkout-service and parent-checkout database tests. They use isolated data, simulated clocks and provider doubles; none contacts production or charges a card. The public-config integration test warms the cache immediately before midnight and confirms Winter is selected afterward without another database read. It also verifies that an explicit Fall parent URL remains Fall and cannot advertise open admissions.

Review/apply migration 0085 and deploy together. Verify that an eligible Winter row exists, applications are enabled, and Fall's catch-up plan is present. Keep Fall active while teaching continues. At rollout check `/`, `/program`, `/parents`, and `/apply` plus an explicit Fall parent/application link. The post-build static guard intentionally allows request-time Home/Program while preserving static rendering for the blog and other marketing routes.
