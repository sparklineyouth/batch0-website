# Hackathons, challenges & giveaways

Every one is an event page at `/challenges/<slug>`: people **register** in one
click, **draft** a submission that autosaves, and **submit** before the
deadline. "Hackathon", "Challenge" and "Giveaway" are labels — all three work
the same way.

## Before you start

Migration `0087_hackathons.sql` must be applied (`supabase db query --linked -f
supabase/migrations/0087_hackathons.sql`, or paste it into the SQL editor). It is
idempotent. Note the repo's migration numbers skip 0085/0086 on `main` — those
versions were used by another branch on the live database.

## Running one

1. `/admin/challenges` → **New challenge**. It saves as a draft; only staff
   can see a draft's page.
2. Fill in, top to bottom:
   - **Cover** — upload a square image, or pick a colour for the typographic
     cover built from the title and prize.
   - **Dates** — *Submissions open* (blank = as soon as it's published; people
     can register before this), *Submissions due* (the form locks), *Winners
     announced* (display only). Extra milestones (kickoff call, office hours)
     go on the timeline automatically.
   - **Prizes** — cash, a physical item with a photo (the Meta glasses), or a
     perk. The headline ("$750 + Ray-Ban Meta glasses") builds itself unless
     you override it.
   - **Entry rules** — *Required referrals*: entrants can register and draft
     freely, but the Submit button stays locked until N friends have made an
     account through their link **and** either registered for this challenge
     or submitted a cohort application. Only friends who join after the
     challenge was created count, a friend counts once, and nobody can refer
     themselves. *Let entrants edit after submitting* keeps the form open until
     the deadline.
   - **Submission form** — quick-add the usual fields (project name, pitch,
     demo, repo, video, screenshots, team, rules checkbox) or build custom
     ones: short/long text with character limits, links, video (link or
     upload), file uploads (images / PDFs / any), single or multiple choice,
     number, 1–N scale, team members, a yes/agree checkbox, and section
     headings. **Preview form** shows exactly what entrants see.
3. **Publish**. Several can be live at once; the homepage banner shows a
   featured one first, otherwise whichever closes soonest.

Edits to questions never change answers already submitted — each entry keeps
a snapshot of the form it was submitted against.

## Reviewing

- **Registrations** tab: who's in, who referred them, and each person's
  referral count against the requirement (same rule the Submit gate uses).
- **Submissions** tab: filter by New / Shortlisted / Winners / Not selected /
  Drafts, and **Export CSV** (one column per question).
- On a submission: mark it a **Winner**, pick the **prize** they won (a cash
  prize pre-fills the payout), and optionally show them publicly with a
  curated name and one-liner. Turn on **Publish winners** in the editor for the
  winners list to appear on the page and site-wide.

## Previewing without an account

`/dev/challenge` renders the event page, submission form and editor against
fixtures (`?view=event|submit|editor&state=signedout|registered|draft|submitted|winner|closed`).
It 404s on production.
