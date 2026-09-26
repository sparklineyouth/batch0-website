# September 2026 Search campaign release

The release keeps Fall admissions available through September 30 at 11:59:59.999 p.m. Eastern. At October 1 midnight Eastern, new unqualified admissions select the next eligible intake, currently Winter (December 14, 2026–February 12, 2027). Existing Fall students retain their cohort and course access. Explicit cohort links and saved drafts require an intentional choice before changing intake.

The application flow retains its one-question screens, Auth outage retries, draft-only verified-token fallback, and device backups. A current explicit cohort link wins over an older device choice. If a recovered device-only draft names a closed intake, its answers stay on the device until the student chooses an open intake, including when Winter is the only option; refreshes and background saves cannot silently move it. Sign-in recovery and the parent-guide link preserve the selected cohort.

The integration with main through `b6ce20bc` passed 593 unit/database tests and the production build, including TypeScript checks and the static-rendering guard (137 blog posts and 8 marketing routes). The unchanged Winter preparation tool previously passed its 7 tests. Nine new integration/recovery tests cover deadline and Auth interactions, attribution after saves, referral-only drafts, and explicit cohort choice during device recovery. A second read-only code review found no remaining integration blocker. The updated preview and final production smoke remain separate release gates below.

The Search destination is `/parents` with final URL suffix `utm_source=google&utm_medium=cpc&utm_campaign=batch0_search_2026`. Apply the same suffix to the campaign's Parents, Program, Sample lesson, and Apply sitelinks. The private campaign-payment report follows the application through a parent paying on another device and uses actual charges after discounts and refunds. It does not upload conversions to Google Ads. See [campaign attribution](campaign-attribution.md) for the accounting rules and device limitations.

## Release order

1. Finish combined tests and the production build. Preserve the integration owner's final results.
2. Apply and read back migrations 0085 and 0086, including `/sample-lesson` in the attribution path constraint, before enabling the ad campaign.
3. Release the reviewed commit through the existing Vercel Git integration for project `batch0` (`prj_WQlXgHHsb3dEfCzBjAZRb0E7jNyq`, team `team_gveqsMUNuF4dysmodVer7FQ2`). Confirm the production deployment corresponds to that commit and serves `batch0.org`.
4. Run the short production smoke below. Enable the campaign only after the landing page, budget, and conversion-reporting path are verified.

## Smallest production smoke

- Open `/`, `/program`, and `/parents` anonymously. Dates, available intake, current tuition, and application deadline must agree. Compare `/parents?cohort=e3db019a-e723-4614-a5a1-1c2868883f42` with `/parents?cohort=6350c6ac-70f0-4f53-93d5-c99e397185a9`: each stays tied to its own cohort. Before the Fall cutoff, the explicit Winter page's header, footer, and main Apply links must all retain the Winter UUID; an authenticated header still links to the dashboard.
- Send an anonymous **GET** to each tagged sitelink destination. Each should set the `batch0_search_source` cookie with HttpOnly, Secure, SameSite=Lax, Path=/, and Max-Age=2592000. A HEAD request intentionally does not set it. Retrying an untagged page with the cookie must not replace or extend it.
- Follow `/apply?cohort=e3db019a-e723-4614-a5a1-1c2868883f42` while signed out. Its signup/login redirect must retain the selected cohort in `next`.
- `/admin/payments/acquisition` must redirect an anonymous visitor to authentication. An authorized payment-viewing staff member should see the real report or a truthful empty state, not a migration/database error.
- Check the Winter welcome page with staff preview. It must show the December 14–February 12 program dates, the new Winter lesson link, the confirmed timetable below, and a link to the actual first event. Do not create an application, payment, email, or event merely to perform this read-only production smoke.

The isolated database and checkout suites test paid-event/refund behavior. A real parent purchase is credited when the payment webhook writes its application-linked ledger entry; that observed production result must not be inferred from a successful build or a page view.

## Winter welcome and confirmed timetable

Winter kickoff was published and read back on September 26, 2026 through the validated Batch0 content operation. It links the Winter welcome lesson `bcf89114-9539-5251-bb3c-0431e52f611e`, the course, pre-cohort resources, and the public Winter calendar. After founder confirmation, the release owner published and verified 19 Winter events and updated the kickoff to link to the actual first event. All 15 existing Fall events were unchanged.

The confirmed schedule is nine Monday workshops, 8–9 p.m. Eastern; nine office-hour sessions, ordinarily Thursday 8–8:30 p.m. Eastern; and Demo Day on February 12, 2027, 8–9 p.m. Eastern. Holiday office hours move from December 24 and 31 to Wednesday, December 23 and 30, at the same time. These are published live events, separate from the nine weekly workbook windows.

For the first $120 campaign, judge continuation using settled tuition after refunds alongside actual ad spend. At the present $117 Fall promotional charge, one payment does not recover $120; two payments recover gross cash but still have fees and delivery costs. A single $150.99 Winter payment exceeds ad spend before those costs, but one sale alone is not evidence of a repeatable acquisition rate.
