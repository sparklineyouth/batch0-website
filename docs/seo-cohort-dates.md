# Cohort dates and search snippets

## The invariant

**No cohort date may ever be hardcoded into page metadata.**

Cohort dates live in a Supabase `cohorts` row that admins move from
`/admin/cohorts` without a deploy. Page metadata that hardcodes those dates is
baked at build time. Those two facts cannot both be true and stay in sync, and
discipline is not a fix — it failed twice.

## What went wrong

On 2026-08-05, `https://batch0.org/` served this to search engines:

```
batch0 is a live, online startup accelerator for U.S. high schoolers.
Cohort 1 runs Jul 30–Sep 13, 2026. $130 tuition, free to apply. No equity taken.
```

The page body, on the same request, said **Sep 14 – Nov 13, applications close
Sep 10**.

So Google's result told every student who searched for us that the cohort had
started a week ago and was half over. The real deadline was five weeks out.
That snippet is the first and often only thing a prospective applicant reads.

Three values were in play, none of which agreed:

| Source | Value |
| --- | --- |
| Deployed `layout.tsx` description | Jul 30 – Sep 13 |
| `origin/main` `layout.tsx` + `FALLBACK_COHORT` | Aug 17 – Oct 18 |
| Live cohort row (rendered in the page body) | Sep 14 – Nov 13 |

The comment above `FALLBACK_COHORT` already documented one earlier occurrence
of the same drift. It recurred anyway, because the design required a human to
remember to update a string in a second file every time a date changed.

## The fix

`app/page.tsx` and `app/program/page.tsx` use `generateMetadata()` and build
their descriptions from the live cohort record via
`metaDescription()` (`lib/site-config.ts`).

This costs **zero** extra database round-trips. `getSiteConfig` is wrapped in
React `cache()`, and Next.js runs `generateMetadata` and the page component in
the same request — so the snippet and the page body read one identical result
and cannot disagree.

One subtlety worth preserving: `cache()` keys on argument identity, so
`getSiteConfig` unwraps its options bag to a primitive `countryCode` before
calling the memoised inner function. Passing `{ countryCode }` straight through
would allocate a fresh object per call and silently make the cache a no-op.

`app/layout.tsx` keeps a static description as the inherited default for every
other route. It is deliberately **date-free**, so it is true regardless of
where the cohort calendar sits.

## Copy rules

`lib/seo-meta.ts` holds the copy logic as pure, import-free functions so they
can be unit-tested with `node --test` and no build step. The rules:

1. **Never advertise a passed deadline.** Once `applicationsCloseAt` is behind
   us, the "apply by" clause is dropped. A snippet reading "apply by Sep 10" on
   Sep 11 costs the click and the credibility. A *missing* close date is
   treated as closed, not as open-forever.
2. **Stay under 155 characters.** Google truncates around 155–160. The
   degradation ladder drops the year before it drops the deadline: "apply by
   Sep 10" makes a student act today, while "2026" is inferable from a result
   Google is already showing as current. Ranges that cross a year boundary
   always keep both years — ambiguity there is worse than truncation.
3. **Say "high schoolers", not "U.S. high schoolers".** The FAQ tells students
   they can join from anywhere and `lib/pricing.ts` ships regional tuition. The
   old wording disqualified international applicants in the one sentence where
   they decide whether the program is for them.

## Guardrails

```bash
npm test          # unit tests for the copy rules (19 assertions)
npm run seo-doctor   # checks the deployed site against the current cohort
```

`seo-doctor` runs three groups of checks and exits non-zero on failure:

1. **`FALLBACK_COHORT` vs the live row.** The fallback only matters during a
   Supabase outage — precisely when nobody is looking — so drift here is
   invisible until it's expensive. Needs real credentials in `.env.local`;
   skips cleanly without them.
2. **Live meta descriptions.** Fetches `/` and `/program`, extracts the
   descriptions, and fails if either exceeds the character budget or mentions a
   date that isn't in the current cohort. A stale date here means production is
   serving an older build than the repo believes.
3. **Crawler entry points.** `robots.txt` references the sitemap; the sitemap
   is non-empty and lists no robots-disallowed routes.

Point it at a local dev server with `npm run seo-doctor -- --url=http://localhost:3000`.

## When the cohort row changes

1. Update the row in `/admin/cohorts`.
2. Update `FALLBACK_COHORT` in `lib/site-config.ts` to match, and bump the
   "Last verified" date in the comment above it.
3. Run `npm run seo-doctor`.

Step 2 is the only manual sync left, and it now only affects outage behaviour —
never the live snippet.
