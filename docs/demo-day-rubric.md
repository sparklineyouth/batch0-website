# The Demo Day rubric, and releasing it back to founders

Two halves of one feature: a rubric judges can score consistently against, and
an explicit decision to hand each team's card back.

## The rubric

Five criteria, weighted as shares of 100, each scored 0–5:

| Criterion | Share | What it asks |
| --- | --- | --- |
| Problem & insight | 20% | Is the problem real and specific, and do they know something non-obvious about it? |
| Product & demo | 25% | Does it exist and visibly work? Does the demo show the core loop? |
| Traction & evidence | 20% | What happened in the real world — honest numbers with denominators? |
| Market & business model | 15% | Who pays, how much, how many, and what's the wedge? |
| Pitch craft, Q&A & team | 20% | Clear, in time, direct under questioning, believable team. |

The copy lives in `DEFAULT_PITCH_RUBRIC` in
[`lib/demo-day-rubric.ts`](../lib/demo-day-rubric.ts) and reaches the database
through **Install standard rubric** at `/admin/demo-day/rubric` — not through a
seed in a migration. One source of truth in the repo, and an admin who rewords
an anchor can get the shipped wording back. Install refuses to run over an
existing rubric at the same scope: overwriting would leave scores attached to
criteria that no longer say what they said when the score was given.

### Scoring bands are the load-bearing part

Each criterion carries `anchors` — a jsonb array of `{level, label}`, highest
first — written as one line per band in the editor (`5 = …`). "4/5 on traction"
means nothing across eight judges who have never met; *"early real usage, a
signed pilot or a first paying customer — small numbers, honestly stated"*
means roughly the same thing to all of them.

The same sentence does two jobs: a judge reads the band under the number they
are hovering (`/investor/teams/[id]`), and a founder reads the band they landed
on when feedback comes back. The pitch coach is given the bands too, so its
practice scores are graded against the real thing.

### How a card is computed

`buildScorecard` in `lib/demo-day-rubric.ts`, unit-tested in
[`lib/demo-day-rubric.test.ts`](../lib/demo-day-rubric.test.ts):

- Average per criterion **across judges**, then weight. Judges score different
  subsets (someone joins late, someone skips the market question), and a flat
  mean would let the most-scored criterion dominate.
- Normalize each average by its own `max_score` **before** applying the weight,
  so an admin can set one criterion to 0–10 without silently doubling its pull.
- Divide by the weight of the criteria *actually* scored, so a team judged on
  four of five isn't docked for the fifth.
- An entirely unscored team is `null`, never `0`. "Nobody judged this team" and
  "the judges hated it" must not look the same.

## Releasing feedback

Scores are invisible to founders until a human decides a card is finished and
fair to hand over. The gate is one row per team in
`demo_day_feedback_releases` (migration
[0075](../supabase/migrations/0075_demo_day_rubric_feedback.sql)), written from
`/admin/demo-day/feedback`.

Per team, an admin chooses:

- **Show on their dashboard** — the card appears on the team's Demo Day tab and
  every member gets a notification (`demo_day_feedback`, deduped per team so a
  re-release doesn't ping them again).
- **Email it to every member** — a complete copy of the card, not a link,
  because this is the email a founder forwards to a parent. Opt-in on every
  release, including a re-release: a sent email can't be recalled.
- **Include the judges' written notes** — shared as written, never with a
  judge's name. The admin's preview follows this checkbox, so the decision about
  the notes is made while looking at them.

Either channel works alone. Releasing is re-runnable (an edited note, a
rescore); `email_count` and `emailed_at` record what already left the building
and survive a **Take it down**, which only clears `released_at`.

### Two gates, not one

Migration 0075 narrows the `demo_day_scores` read policy: a team member can
select their team's score rows only once a release exists with
`show_on_dashboard`. Before this, any founder could have read their raw scores
through the API the moment a judge saved one, whatever the dashboard chose to
render. The dashboard page is the second gate — it fetches the scores only
after checking the release, so an unreleased card never reaches the page's
props. Admins and the judge who wrote a row are unaffected.

## Running it

1. `/admin/demo-day/rubric` → **Install standard rubric** (once), edit wording
   or weights to taste.
2. Judges score at `/investor/teams/[id]`.
3. `/admin/demo-day` → the **Fed back** column shows which teams have seen
   their scores.
4. `/admin/demo-day/feedback` → review each card, pick the channels, release.
