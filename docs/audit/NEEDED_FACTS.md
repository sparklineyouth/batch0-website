# NEEDED_FACTS.md — questions only Rish can answer

Everything the overhaul needed but refused to invent. Each item lists where
the honest fallback currently lives. Answer these and the copy gets sharper;
none of them block the site as shipped.

> **Status update — 2026-07-14 (app-surface audit).** The 2026-07-10 pass
> covered the marketing surface only; the authenticated app was re-audited on
> 2026-07-14 (see [REPORT_APP_SURFACE.md](REPORT_APP_SURFACE.md)). Resolved
> since this file was written:
>
> - **#1 duration — ANSWERED.** Cohort 1 now runs **Aug 17 → Oct 18, 2026
>   (~9 weeks)**, not the Jul 30 → Sep 13 quoted below. Rish confirmed ~9
>   weeks is correct, so every "four weeks" total-duration claim was removed
>   from the app surface. "Four one-week build sprints" (a sprint count, not a
>   duration) stays.
> - **#2 applications close date — RESOLVED.** `applications_close_at` is set
>   to 2026-08-10 23:59 UTC.
> - **#6 contact email — RESOLVED.** `contact_email` is `hello@batch0.org`,
>   and batch0.org has a live MX (`smtp.google.com`), so it actually receives
>   mail. impetusai.net is still dead (no A, no MX) but is no longer
>   referenced anywhere in code or data.
>
> Still open below: **#3** (demo day date — `demo_day_date` is still null),
> #4, #5, #7–#11, #13–#16.

## Critical (affects claims already on the page)

1. ~~**The duration.**~~ **ANSWERED 2026-07-14 — see status update above.**
   Historical context: the curriculum is authored as four one-week sprints,
   but the Cohort 1 record ran **Jul 30 → Sep 13 (6.5 weeks)**. Which is
   true? Buffer/orientation/demo-day weeks, or wrong dates in the cohort
   row? The site currently shows the real dates and says "four one-week
   build sprints" without a total-duration claim. Fix the cohort row in
   /admin/cohorts or tell us the real structure and we'll say it plainly.
2. **Applications close date.** `applications_close_at` is unset, so the
   ledger says "open — rolling review" with no deadline. A real deadline is
   the single strongest conversion lever this page could add. Set it in
   /admin/cohorts.
3. **Demo day date.** `demo_day_date` is unset. The program page says "the
   last day of the cohort." Confirm date (Sep 13?) and set it in settings.
4. **Hours per week + live-session schedule.** FAQ currently says "plan
   for it like a serious extracurricular" — it should say "X–Y hrs/week,
   live sessions Tue/Thu 7pm ET" or whatever is true.
5. **Who teaches.** The program page promises "we list every person by
   name before you pay." Right now that list is just you. Confirm the
   final Cohort 1 staffing (you solo is fine — say it) or name the others.
6. **impetusai.net is DEAD — no DNS records at all.** Which means
   `hello@impetusai.net` **cannot receive email**: every "email us" link
   on the old site (legal pages, billing, sponsor form, Resend reply-to
   default) was a black hole. The overhaul replaced every instance with
   `batch0youth@gmail.com` (the DB `contact_email`, and the verified
   Resend account owner) and removed the impetusai.net links. Action:
   restore the domain's DNS (registrar/nameserver lapse?) or confirm
   gmail is the permanent contact. `RESEND_FROM`'s reply-to also now
   defaults to the gmail — if you restore the domain, flip
   `NEXT_PUBLIC_CONTACT_EMAIL` in Vercel rather than editing code.

## High value (unlocks stronger copy)

7. **Founder receipts.** 2–3 public links (shipped products, hardware,
   repos, press) for the "Who runs this" section — the parent-trust
   section is deliberately modest until these exist.
   `<!-- TODO(RISH) -->` markers sit in components/founder.tsx and
   app/program/page.tsx.
8. **Preferred public name/bio.** The site says "Rish Dagli, an
   18-year-old founder." Confirm name form, and whether you want a photo.
9. **Mentors/guests.** If any named mentor, judge, or demo-day guest is
   committed (name + affiliation + permission), the "no anonymous mentor
   networks" line converts from defensive to devastating.
10. **Cohort 1 capacity = 100.** Real DB value, shown in FAQ. For a first
    cohort it reads large — a smaller genuine cap (24? 30?) would be both
    more credible and scarcer. If 100 is intentional, keep; else update
    the cohort row.
11. **Social profiles.** Footer has none (no placeholder links). Send the
    real Instagram/Discord/X handles if they exist.

## Housekeeping

12. **batch0youth.com does not resolve** — this is almost certainly why
    an external test reported the site "blocks crawlers." Register it (or
    confirm you own it) and 301 it to batch0.org.
13. **Competitor prices.** "LaunchX, LeanGap list tuition at $3,000–$8,000+"
    — re-verify each cohort season (marked TODO in components/pricing.tsx
    and faq.tsx).
14. **Old Impetus AI stats** ("10+ AI products shipped", "8 yrs founder
    experience — Quantiphi, Schroders", "12–20 hr weekly time saved
    reported by clients") were removed as unverifiable/self-conflicting
    (8 yrs experience for an 18-year-old founder implies founding at 10).
    If these belong to a real person/track record, say whose and we can
    restore them on /sponsors with attribution.
15. **Refund policy terms.** The redesign links the refund policy from the
    pricing section and FAQ — confirm the page's terms are current since
    they're now load-bearing.
16. **Testimonial pipeline.** During Cohort 1, collect written permission
    (student + parent, since minors) to publish names/projects/quotes.
    The Cohort Ledger is designed to grow into that proof wall.
