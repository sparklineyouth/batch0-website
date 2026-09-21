-- ============================================================================
-- 0073 — Week 1 field guide: a second Week 1 module of hands-on lessons, and
-- the Week 1 reading list.
--
-- Week 1 already has its core module (0064; the private curriculum import
-- rewrote those five lessons in place and preserved their ids). This adds a
-- SECOND Week 1 module — "Week 1 — Field Guide: From Problem to Proof" — with
-- 13 worksheet-style lessons that walk a team from a blank Problem Bank to a
-- tagged Lean Canvas: the week map, the Problem Bank, scoring, picking a first
-- customer, the interview script, cold outreach, running the interview,
-- reading the signal, designing a demand test, the Lean Canvas box by box, the
-- one-liner + first check-in, the ten common mistakes, and the wrap-up. Every
-- lesson follows the same shape the imported lessons use (## Goal, teaching
-- sections, ### Do it now as a numbered list, ### Check yourself), and about
-- half of them end by pointing students at the private "Ask the team" thread,
-- office hours, or hello@batch0.org.
--
-- WHY A SECOND MODULE rather than more rows in the first: the core module's
-- lessons and order are authored content we shouldn't reshuffle from a
-- migration, and the field guide reads as its own arc. The course pages order
-- modules by (week, position), so this sits directly under the core module as
-- a second "Week 1" card and the Next-lesson chain flows core → field guide →
-- Week 2.
--
-- Also adds 18 Week 1 readings under the "week 1 · validate" category:
-- global rows (cohort_id null), NOT pre_cohort, so they appear once the cohort
-- has started and group under their own heading on /dashboard/resources. All
-- point at batch0's own blog; each description says how the piece fits this
-- week. Ordered for display by staggering created_at (the page sorts newest
-- first within a category).
--
-- Lesson bodies are dollar-quoted ($md$ … $md$) — markdown has too many
-- apostrophes for '' escaping to stay readable. Generated from the lesson
-- markdown by a build script; edit the rows in /admin/course afterwards as
-- with any lesson.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run — the module is
-- keyed on (cohort, week, title), each lesson on (module, title), and each
-- resource on title OR url (so a reading the private import already added
-- under another title is skipped, not duplicated). Assumes 0001..0072 applied.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) The field-guide module.
-- ----------------------------------------------------------------------------
with target as (
  -- The cohort that owns the original Week 1 module (docs/course-launch.md),
  -- falling back to 0064's rule (soonest upcoming cohort, else most recent)
  -- if that module has been deleted.
  select coalesce(
    (select cohort_id from public.modules where id = '8f59cc82-e318-4165-90a0-5901b3d1c036'),
    (select id from public.cohorts
       where starts_on >= current_date
       order by starts_on asc
       limit 1),
    (select id from public.cohorts
       order by starts_on desc nulls last
       limit 1)
  ) as id
)
insert into public.modules (cohort_id, week, title, summary, position)
select t.id, 1,
  $md$Week 1 — Field Guide: From Problem to Proof$md$,
  $md$The core lessons tell you what Week 1 is for. This field guide is how you actually do it: worksheets, scripts, and templates you work through in order, ending with ten real conversations, one demand test you designed, and a first Lean Canvas backed by evidence. Budget five to eight focused hours across the week, and ask the team the moment you get stuck.$md$,
  2
from target t
where t.id is not null
  and not exists (
    select 1 from public.modules m
    where m.cohort_id = t.id
      and m.week = 1
      and m.title = $md$Week 1 — Field Guide: From Problem to Proof$md$
  );

-- ----------------------------------------------------------------------------
-- 2) The 13 lessons, inside that module.
-- ----------------------------------------------------------------------------
with target as (
  -- The cohort that owns the original Week 1 module (docs/course-launch.md),
  -- falling back to 0064's rule (soonest upcoming cohort, else most recent)
  -- if that module has been deleted.
  select coalesce(
    (select cohort_id from public.modules where id = '8f59cc82-e318-4165-90a0-5901b3d1c036'),
    (select id from public.cohorts
       where starts_on >= current_date
       order by starts_on asc
       limit 1),
    (select id from public.cohorts
       order by starts_on desc nulls last
       limit 1)
  ) as id
),
fg as (
  select m.id
  from public.modules m
  join target t on t.id = m.cohort_id
  where m.week = 1
    and m.title = $md$Week 1 — Field Guide: From Problem to Proof$md$
  limit 1
)
insert into public.lessons (module_id, title, description, position)
select fg.id, seed.title, seed.description, seed.position
from fg,
  (values
    (
      $md$How Week 1 Works: Your Map for the Week$md$,
      $md$Week 1 has one job: end it knowing whether the problem you picked is real, with evidence a stranger would believe. This lesson lays out what you ship, when, and where everything lives, so you never lose a day figuring out the program instead of doing the work.

## Goal

By the end of this lesson you can say what "done" means for Week 1 in one sentence, you have a day-by-day plan adjusted to your actual schedule, and you know exactly where to go the moment something blocks you.

## What you ship by the end of the week

Everything below is a working document, not a polished deliverable. Rough and real beats pretty and empty.

| Artifact | What it is | Where it lives |
| --- | --- | --- |
| Problem Bank | Ten problems you have personally seen, scored, with your top three picked | Your team's folder in [Files](/dashboard/files) |
| Interview log | Ten conversations with real people, with notes and exact quotes | Same folder |
| Signal verdict | Pursue, pivot, or kill, with three reasons from the log | Same folder |
| Demand-test plan | One experiment for the weekend, with a pass/fail number decided in advance | Same folder |
| Lean Canvas v1 | All nine boxes, each marked observed, estimated, or planned | Same folder |
| Weekly check-in | What you did, what's next, what's blocking you | [Check-in](/dashboard/checkin) |

If you are on a team, you produce one set of these together. If you are solo, you produce them alone and the interview target stays at ten.

## A week that works

This is one shape for the week. Move blocks around to fit school, sports, and sleep, but keep the order: you cannot read the signal before the interviews, and you cannot fill a Lean Canvas honestly before the signal.

| Day | Work | Time |
| --- | --- | --- |
| Mon | Core lessons 1 and 2. Start your Problem Bank. | 1.5 h |
| Tue | Finish the bank, score it, pick your top three. Write three problem statements. | 1 h |
| Wed | Adapt the interview script. Send at least fifteen outreach messages. | 1 h |
| Thu | Interviews 1 to 4. Office hours if something is off. | 1.5 h |
| Fri | Interviews 5 to 8. Debrief after each. | 1.5 h |
| Sat | Interviews 9 and 10. Read the signal. Choose your demand test. | 1.5 h |
| Sun | Lean Canvas v1, your one-liner, your check-in. | 1 h |

That is about nine hours. If you only have five, cut the interviews to seven and skip nothing else. Check [Events](/dashboard/events) for this week's live session and office-hour times and put them in your calendar today; the Events page is the source of truth for anything live.

## Where everything lives

- [Course](/dashboard/course): the lessons. Mark each one complete when you finish the exercises, not when you finish reading.
- [Resources](/dashboard/resources): the Week 1 readings sit under "Week 1 · Validate". Every one is optional and every one is short.
- [Team](/dashboard/team) and [Files](/dashboard/files): your people and your shared folder.
- [Check-in](/dashboard/checkin): once a week. The team reads every one.
- [Office hours](/dashboard/office-hours): book an open slot with a mentor when you want a second brain on something specific.
- [Discussions](/dashboard/discussions): threads with your cohort, and a private line to the batch0 team.
- [Community](/dashboard/community): the casual channel. Post what you're working on.
- [AI co-founder](/dashboard/ai): good for pressure-testing a problem statement or drafting an outreach message. It never replaces a real conversation with a real person.

## Working with a team, or alone

Teams: pick one person to own the interview log this week so nothing gets lost across three phones. Split the ten interviews, but debrief together, because the patterns only show up when the notes are side by side. Disagree about the verdict in the open; a team that agrees on everything in Week 1 usually hasn't looked hard enough.

Solo: you still talk to ten people. Use the cohort in Discussions as your debrief partner; post two quotes and what you think they mean, and ask what others see.

### Do it now

1. Open [Events](/dashboard/events), find this week's live session and office-hour slots, and put them in your calendar.
2. Copy the day-by-day table into your notes. Move blocks to fit your real week and total the hours. Under five means something has to give this week, and it should not be the interviews.
3. Agree with your team where Week 1 work lives and create that folder in [Files](/dashboard/files) now, before there is anything to put in it.
4. Post one line in [Community](/dashboard/community): the problem area you're leaning toward. One line, no pitch.

### Check yourself

- Can you say what "done" looks like for Week 1 in one sentence without looking?
- Do you have at least five hours blocked on a calendar, not "sometime this week"?
- Does everyone on your team know the one place this week's work lives?

### When you get stuck

Two rules for the whole cohort. First: stuck for more than twenty minutes means ask. Second: no question is too small. Ask the batch0 team privately in [Discussions](/dashboard/discussions/new?to=team); only you and the team see it, and we reply in the thread. Program or logistics questions can also go to hello@batch0.org.
$md$,
      1
    ),
    (
      $md$The Problem Bank: Collect Ten Problems Before You Pick One$md$,
      $md$Most first-time founders pick the first idea that excites them and spend the week defending it. You are going to do the opposite: collect ten problems fast, without judging them, and only then pick. Ten options make the good one obvious. One option makes every flaw invisible.

## Goal

By the end of this lesson you have a Problem Bank with ten rows, every one of them a problem you have personally seen a specific person have, written in plain words, with no product attached.

## Problems, not products

A product is a guess about a solution. A problem is something that already exists in the world whether you build anything or not. Compare:

- Product: "An app that helps robotics teams manage parts."
- Problem: "Our robotics team tracks parts in a group chat, and before every competition someone spends an hour finding a motor that was 'definitely returned.'"

The second one is testable. You can ask other teams whether it happens to them. You can ask how long they lose. You can ask what they've tried. The first one only lets you ask "would you use this?", and the next lesson explains why that question is worthless.

## Five hunting grounds

You do not need to invent anything. You need to notice. Spend ten minutes in each of these and write down what's broken, slow, annoying, or done with a workaround.

1. **Your own week.** What did you do twice in the last seven days that felt like it should take half the time? What do you avoid because it's a pain?
2. **Your school.** Scheduling, clubs, group projects, lunch lines, lost-and-found, tutoring, college apps. Anything with a spreadsheet, a group chat, or a paper form is a candidate.
3. **Your activities.** Sports teams, robotics, theater, band, debate, a job. Every activity has a coach or a captain drowning in logistics.
4. **Your family's work.** Ask a parent or an older sibling: "What's the most annoying part of your job that nobody has fixed?" Write down their exact words.
5. **Your online communities.** Discord servers, subreddits, group chats. Search for the words "does anyone know how to" and "is there a way to". Every one of those messages is a problem someone typed out for you.

## The Problem Bank template

One row per problem. Keep each cell to one line; you are scanning this later, not reading it.

| # | The problem, in plain words | Who has it (specific) | How often | What they do about it now | How I know |
| --- | --- | --- | --- | --- | --- |
| 1 | Robotics team loses parts between meetings | FTC team captains at my school | Weekly in season | Group-chat messages, one shared spreadsheet nobody updates | I'm on the team; I've lost two hours to it |
| 2 | ... | ... | ... | ... | ... |

Running example (hypothetical): Maya, a junior on her school's robotics team, fills her bank with problems from practice, from her part-time tutoring job, and from her mom's work as a dental office manager. Three of the ten come from one twenty-minute conversation with her mom. The problems from her own life are the sharpest; the ones from her mom's job are the ones with money attached.

## Rules for a good row

- **Specific beats big.** "Students are stressed" is not a row. "Juniors in AP Chem redo their lab writeups because the rubric changes between sections" is a row.
- **You must be able to reach the people.** If the "who" is "small business owners in America", you cannot interview ten of them this week. If it's "the four hair salons within a mile of my school", you can.
- **A workaround is good news.** If people already spend time or money on a bad fix, the problem is real. If nobody does anything about it, it might not hurt enough.
- **No solutions in the problem column.** If you catch yourself writing "an app that", delete it and describe what happens today instead.

### Do it now

1. Set a timer for fifty minutes. Spend ten in each hunting ground and write everything down, even the dumb ones. Do not filter yet.
2. Move the ten strongest into the Problem Bank template in your team's [Files](/dashboard/files) folder. Fill every column, especially "how I know".
3. For any row where "how I know" is "I assume", either go ask one person today or cross the row out.
4. Read your ten rows aloud to a teammate or a friend. Any row that needs an explanation gets rewritten in plainer words.

### Check yourself

- Do all ten rows describe something that happens today, with no product in the sentence?
- Could you name a real, reachable person for each "who" column?
- Is at least one row something someone already spends money or more than an hour a week working around?
- Did you write down at least one problem you personally find boring? Boring problems with paying customers beat exciting problems with none.
$md$,
      2
    ),
    (
      $md$Score Your Problems: Frequency, Pain, Reach, Access$md$,
      $md$You have ten problems. You can seriously investigate three this week. This lesson gives you a scoring rubric so the choice is made by evidence instead of by whichever one you happened to think of in the shower.

## Goal

By the end of this lesson every row in your Problem Bank has a score out of twelve, you have picked your top three, and each of the three has a one-sentence problem statement you could say to a stranger.

## The four questions

Score each problem 1, 2, or 3 on each question. Be stingy. A 3 means you have seen it, not that you believe it.

| Question | 1 | 2 | 3 |
| --- | --- | --- | --- |
| **Frequency.** How often does it happen to one person? | A few times a year | Monthly | Weekly or more |
| **Pain.** What does it cost them when it happens? | Mild annoyance, forgotten in an hour | Real time or money lost, complained about | They have rearranged their life or budget around it |
| **Reach.** How many people like this can you actually name? | Fewer than five | Five to twenty | More than twenty, or a clear path to them |
| **Access.** Can you get ten of them to talk to you this week? | I'd need an introduction I don't have | With some effort | I could message ten today |

Add the four numbers. Twelve is the ceiling. Anything at nine or above is a serious candidate. Anything at six or below is either not a real problem yet or not one you can reach; park it, don't delete it.

## Vitamin or painkiller

A painkiller is something people go looking for because it hurts right now. A vitamin is something people agree is good for them and never get around to. Painkillers get bought. Vitamins get bookmarked.

The tell is in the "what they do about it now" column. Painkillers have ugly, expensive workarounds: the spreadsheet with eleven tabs, the weekly two-hour fix, the person hired just to deal with it. Vitamins have no workaround because nobody is in enough pain to build one. If your Pain score is a 3, you probably have a painkiller. If your highest Pain score across all ten rows is a 1, your bank needs more time in the hunting grounds before you score it.

## Two traps

**Too small.** A problem that only affects your one team, once a year, is real but cannot become a company. Reach is what separates a project from a startup. If you can only name three people with the problem, ask: is there a bigger group with the same problem under a different name? Your robotics team losing parts might be every school club that shares physical equipment.

**For everyone.** The opposite trap. "Students" is not a customer. "Teenagers" is not a customer. If the "who" column would take a national ad campaign to reach, shrink it until it's a group you can list by name. You can always widen later; you cannot interview a demographic.

## Write the problem statement

For each of your top three, one sentence, this shape:

> [Specific who] struggles to [do a specific thing] because [the cause], so today they [the workaround].

Running example (hypothetical): "FTC robotics captains struggle to know which parts are on hand before a build session because parts get borrowed and returned through group chat, so today they re-buy parts they already own or lose the first hour of practice searching."

Read your three statements aloud. If any of them has a product hidden in it, or needs more than one breath, rewrite it.

### Do it now

1. Score all ten rows on the four questions. Do it alone first, then compare with your team; where you disagree by two or more points, someone has evidence the other doesn't. Talk about it.
2. Rank by total. Pick your top three. If two are tied, take the one with the higher Access score, because access is what you can't fix this week.
3. Write the one-sentence problem statement for each of the three, using the template.
4. Paste your top three statements into a thread in [Discussions](/dashboard/discussions) with your scores. Another team's questions will show you what you can't see.

### Check yourself

- Did every problem you scored 3 on Pain come with an ugly workaround you can describe?
- Could you list ten real people for each of your top three right now, without opening a browser?
- Does each problem statement describe what happens today, with no product in it?
- Is at least one of your three a problem you find slightly boring? That is not a strike against it.
$md$,
      3
    ),
    (
      $md$Who Exactly? Narrowing to Your First Customer$md$,
      $md$"Who is this for?" is the question that sinks more Week 1 conversations than any other. The honest answer is usually "well, anyone who…", and "anyone" is nobody. This lesson gets you to a first customer so specific you could text them.

## Goal

By the end of this lesson each of your top three problems has a named first customer segment, you can list ten real people in it, and you have written a one-paragraph portrait of one actual person who has the problem.

## Why narrow is faster

A narrow segment is not a smaller ambition. It's a shorter path. When your first ten customers all look alike, they hang out in the same places, use the same words for the problem, and refer each other. When they're all different, you learn one thing from each conversation and nothing adds up.

Every company you have heard of started narrow. The one that "was for everyone" from day one is the one you haven't heard of.

## The ten-names test

For each of your top three problems, open a blank note and try to write down ten real people who have it. First names or descriptions are fine: "Priya, captain of the FTC team at Westfield", "the guy who runs the Discord for our regional league". Three outcomes:

- **Ten names in under five minutes.** You have a segment and access. Proceed.
- **Four names, then a wall.** Your segment is real but your access is thin. The fix is usually one step out: who do those four people know? Ask each for two introductions and you're at twelve.
- **Nobody, or only "people like me".** Either the segment doesn't exist yet or you are not the one who can reach it. Neither is fatal, but both are signals. Take it to the team; see below.

## Signs of an early adopter

Inside any segment, some people feel the problem harder than others. Those are the ones to interview first, because they'll tell you the truth and they'll try a rough first version. Look for people who:

- Have already tried to fix it: a spreadsheet, a paid tool, a system they invented.
- Complain about it without being asked.
- Have spent money or more than an hour a week on the workaround.
- Are responsible for the outcome, not just affected by it. The team captain, not the newest member. The office manager, not the receptionist.

## The one-paragraph portrait

Pick one real person from your ten. Not a made-up "persona" with a stock photo; a human you could message tonight. Write one paragraph:

> Name or role, where they are, what their week looks like, when the problem shows up, what it costs them, what they do about it now, and the exact words they used the last time they complained about it.

Running example (hypothetical): "Priya is captain of a 14-person FTC team that meets Tuesday and Thursday after school. Parts live in three bins and two teammates' backpacks. The Thursday before a scrimmage she spent forty minutes looking for a servo the team already owned, then ordered another one with her own money. Their 'system' is a pinned message in the team chat that nobody reads. Her words: 'I'm the captain, not the parts department.'"

If you can't write this paragraph for any of your three problems, you don't know your customer yet. That's fine. It's what the interviews are for.

### Do it now

1. Run the ten-names test for each of your top three. Time yourself. Write the count next to each problem in your bank.
2. For any problem where you stalled under six names, write down who your first four could introduce you to. Ask them for two names each today.
3. Circle the early adopters in each list: anyone with a workaround, anyone who has spent money, anyone who is responsible for the outcome.
4. Write the one-paragraph portrait for one real person per problem. Put all three in your team folder.

### Check yourself

- Can you say your first customer in five words or fewer, with no "anyone" in it? ("FTC team captains in New Jersey." "Owners of single-location hair salons.")
- Did at least six of your ten names come from outside your friend group?
- Does your portrait include the person's actual words, not words you imagined for them?

### If you can't name ten people

That is a real finding, not a failure. Post it privately to the team in [Discussions](/dashboard/discussions/new?to=team) with the problem statement and how many names you got to; helping founders find a way into a segment is a normal Week 1 conversation for us, and sometimes we know someone. If the answer is "there's no way in this week", it's better to know on Tuesday than on Sunday.
$md$,
      4
    ),
    (
      $md$The Interview Script: Seven Questions and a Notes Template$md$,
      $md$A customer interview is not a survey and it's not a pitch. It's fifteen minutes of getting a real person to tell you a true story about the last time the problem happened to them. This is the script. Adapt the words; keep the shape.

## Goal

By the end of this lesson you have a fifteen-minute interview script adapted to your problem, a notes template your whole team uses, and you've run the script once on a teammate as a dress rehearsal.

## The one rule

Ask about the past, never the future. "When did this last happen?" gets you a fact. "Would you use something that…" gets you a polite lie. People are terrible at predicting what they'll do and excellent at remembering what they did. Every question below is built on that.

## The script

**Opening (30 seconds).** Say who you are and why you're asking. Don't describe a product.

> "Thanks for making time. I'm a student in a program where we're researching how [robotics teams keep track of shared parts]. I'm not selling anything and there's nothing to sign up for. I just want to understand how it works for you. Is it okay if I take notes?"

**The seven questions (12 minutes).** Ask them in order. Let silence do the work; if they stop talking, count to five before you speak.

1. "Tell me about the last time [the problem] happened. Walk me through it." (The story. Everything else hangs off this.)
2. "What did that cost you? Time, money, stress, something else?" (Pain.)
3. "What did you do about it?" (The workaround. If the answer is "nothing", ask "how come?")
4. "Have you tried anything else? What happened?" (Past attempts. Paid tools are gold here.)
5. "How often does this come up?" (Frequency. Ask for the last three times, not an average.)
6. "Who else deals with this? Who's affected when it goes wrong?" (Reach, and referrals.)
7. "If this just disappeared tomorrow, what would change for you?" (Whether it actually matters. A shrug is an answer.)

**Follow-ups you can use anywhere:** "Tell me more about that." "Why?" "What happened next?" "Can you give me an example?" Those four sentences are most of the skill.

**Closing (2 minutes).**

> "This was really useful. Two last things: is there anyone else you think I should talk to about this? And would it be okay if I came back to you in a couple of weeks if we build something rough to try?"

Write down the names they give you. Those are interviews eleven and twelve.

## What not to say

- Do not describe your idea. Not even "we're thinking about an app." The moment they know what you want to build, they start being nice to you about it.
- Do not ask "would you pay for" or "how much would you pay." Not this week. You'll test price with a real ask later, not a hypothetical.
- Do not explain, defend, or correct. If they say something you think is wrong, write it down. Their wrong is your data.
- Do not fill silence. Their next sentence after a pause is usually the most honest one.

## The notes template

One page per interview. Fill it during, finish it in the five minutes after.

| Field | What goes here |
| --- | --- |
| Who | Name or role, segment, how you reached them |
| The story | The last time it happened, in their words, three to five lines |
| Cost | Time, money, stress. Numbers if they gave any |
| Workaround | What they do now. What they've tried. What they've paid for |
| Frequency | The last three times, with rough dates |
| Exact quotes | Two or three sentences, word for word, in quotation marks |
| Signal | Your read: strong, medium, or weak. One line on why |
| Referrals | Names they gave you |

Exact quotes matter more than anything else on the page. "It's annoying" tells you nothing. "I ordered a second servo with my own money because I couldn't find ours" tells you everything.

### Do it now

1. Copy the script into your team folder. Replace every bracket with your problem. Read it aloud once; anything that sounds like a robot, rewrite in your voice.
2. Build the notes template as a doc or a spreadsheet with one tab per interview. Everyone on the team uses the same one.
3. Run the full script on a teammate playing a customer, with a timer. Notice where you rushed and where you pitched. Fix both.
4. Use the [AI co-founder](/dashboard/ai) to stress-test one question: paste it in and ask "how could this question lead someone to a polite answer instead of a true one?" Then make it yours.

### Check yourself

- Is every question in your script about something that already happened?
- Is your idea completely absent from the script, including the opening?
- Could a teammate run an interview from your notes template without you in the room?
- Did the dress rehearsal fit in fifteen minutes?
$md$,
      5
    ),
    (
      $md$Finding Ten Strangers: Where to Look and What to Send$md$,
      $md$Your friends will say yes to an interview and tell you your idea is great. Neither helps. You need people who don't care about your feelings, which means people who don't know you. This lesson is where to find them and exactly what to send.

## Goal

By the end of this lesson you have a list of at least thirty people to reach, three outreach messages written in your own words, and at least fifteen of them sent today.

## The math first

Cold outreach has a response rate, and it isn't 100%. Plan on one in three replying and one in two of those actually showing up. To land ten interviews you send roughly thirty messages. That sounds like a lot until you realize each one takes ninety seconds. Thirty messages is forty-five minutes. Send them in one sitting so you don't lose momentum after the first three go quiet.

## Where to look, in order

Start warm-ish and work outward. The first ring gets you moving; the outer rings get you truth.

1. **Two steps out.** Friends of friends, a teammate's cousin, a teacher's former student. Ask the people you know for introductions to the people you don't. "Do you know anyone who [runs a club that shares equipment]? Could you intro us?"
2. **Adjacent groups at your school and nearby schools.** Other clubs, other teams, other grades. If your customer is "team captains", every other team at your school has one, and so does every school in your league.
3. **Where your customer already gathers online.** Discord servers for the activity, subreddits, Facebook groups your parents' generation actually uses, forums, the comments under the videos your customer watches. Read for a day before you post; match the tone.
4. **Adults, if your customer is an adult.** Local business owners will talk to a polite student far more readily than to a salesperson. Walk in at a quiet hour, or email the address on their website. LinkedIn works for office jobs; a short, specific message from a high schooler gets read.
5. **Your own public post.** One message in your own feed: "Doing research on [problem] for a program. If this is you or you know someone, I'd love fifteen minutes." Low yield, zero cost.

## Three messages you can send today

Every message does four things: says who you are in one line, names the problem specifically, asks for a small fixed amount of time, and makes it easy to say yes. No pitch, no product.

**Direct message (Discord, Instagram, text):**

> Hi [name], I'm [your name], a junior at [school]. I'm doing research on how [robotics teams keep track of shared parts] for a startup program I'm in. Not selling anything. Would you have 15 minutes this week for a quick call or voice chat? Happy to work around your schedule.

**Email to an adult or a business:**

> Subject: 15-minute student research call about [problem]
>
> Hi [name], I'm a high school student in a startup program, and I'm researching how [small dental offices handle appointment reminders]. I'm not selling anything; I'm trying to understand how it actually works day to day. Would you have 15 minutes this week or next for a call? I can send a few questions ahead of time if that helps. Thank you either way.

**In person (a club meeting, a shop at a quiet hour):**

> "Hi, I'm [name], a student at [school]. I'm researching [problem] for a program I'm in, not selling anything. Could I ask you a few questions for ten minutes, or set up a time that works better?"

Send each message once. If you hear nothing in three days, send one short follow-up: "Just bumping this in case it got buried. Totally fine if not." Then stop.

## Manners and safety

You are a teenager reaching out to strangers, sometimes adults. Keep it clean and keep it safe.

- Meet in public places or on video calls. A parent or guardian knows who you're talking to and when.
- Never share your home address, your schedule, or payment details, and never send or accept money as part of an interview.
- Keep your account names professional enough that an adult would take you seriously.
- If someone is rude, unresponsive, or strange, drop them and move on. There are thirty more on your list.

## If you're shy

Almost everyone in this cohort is, about this. Three things help. Send messages in a batch so you only have to be brave once. Do the first interview with a teammate on the call, one asking and one taking notes. And remember that you are asking a person to talk about themselves for fifteen minutes, which most people enjoy more than they'll admit.

### Do it now

1. Build your list of thirty. Name, where you found them, which message you'll send. Aim for at least twenty who don't know you.
2. Rewrite the three templates in your own voice. Read each aloud; if it sounds like a form letter, it is one.
3. Send fifteen today. Note the time. Set a reminder for the three-day follow-up.
4. Post one interview slot per teammate in your shared calendar so you can book people the moment they say yes.

### Check yourself

- Is your product or idea completely absent from every message?
- Does every message ask for a specific, small amount of time?
- Are at least two-thirds of your thirty people outside your friend group?
- Has a parent or guardian seen your list?

### If replies are under 30% after twenty messages

Something in the message is off, and it's usually fixable in one edit. Paste the message you're sending into a thread in [Discussions](/dashboard/discussions) and ask the cohort and the team to tear it apart. If you'd rather not post it publicly, send it to the team privately and we'll reply in the thread.
$md$,
      6
    ),
    (
      $md$Running the Interview: Listen, Dig, Don't Pitch$md$,
      $md$You've got the script and someone said yes. The next fifteen minutes will either teach you something you couldn't have guessed or confirm what you already believed. Which one happens depends almost entirely on how much you talk. This lesson is how to run the conversation so it produces evidence.

## Goal

By the end of this lesson you've run at least three real interviews, each with a completed notes page, exact quotes, and a five-minute debrief written while it was still fresh.

## Before: five minutes

- Reread their message or profile. Know one specific thing about them so your opening isn't generic.
- Open your notes template with their name already filled in.
- Decide who asks and who writes, if two of you are on the call. One voice; the second person stays quiet except for a follow-up at the end.
- Say your opening line out loud once. It should sound like you, not like a form.

## During: the 70/30 rule

They talk 70% of the time. You talk 30%, and most of your 30% is "tell me more." If you hear yourself explaining, describing, or clarifying anything about what you might build, stop mid-sentence and ask a question instead. Nobody has ever been offended by "sorry, I'm talking too much. What happened next?"

Things to do while they're talking:

- **Chase the story, not the opinion.** "It's frustrating" is an opinion. "Last Thursday I spent forty minutes looking for a servo" is a story. When you hear an opinion, ask for the last time it happened.
- **Notice emotion.** A sigh, a laugh, a change in pace. Those are where the pain is. Ask about the moment right before the sigh.
- **Write down exact words.** Not your summary of their words. When they say something sharp, type it in quotation marks immediately, even if it means you miss the next sentence.
- **Let silence work.** When they stop, count to five in your head. The sentence after the pause is the one they weren't going to say.
- **Ask "why" one more time than feels polite.** The first answer is the one they've said before. The second is the real one.

## The "so basically" moment

At some point you'll want to say "so basically what you need is…" and describe your solution. Don't. Say instead: "So if I've got it right, the last time this happened you [their story], and it cost you [their cost]. Is that fair?" Let them correct you. You've just confirmed the problem without leaking the product.

## Common ways interviews go wrong

| What happened | What to do instead |
| --- | --- |
| They asked what you're building, and you told them | "Honestly, we don't know yet, that's why I'm asking. What would you have done last time if…" |
| They gave you generic answers ("it's fine, I manage") | Get concrete: "Walk me through the last time. What day was it? What did you do first?" |
| They talked about what they'd do "in the future" | Bring them back to the past: "Has that ever actually happened? When?" |
| You ran out of time on question three | Good. Question one is the important one. Ask for a follow-up call and take the story. |
| They complimented the idea you hadn't described | Note it as noise, not signal. Compliments aren't evidence. |
| They said "you should build X" | Write it down, say "interesting, why that?", and don't build X. Customers know their problem, not your solution. |

## Recording

Ask before you record, every time, in plain words: "Is it okay if I record this so I don't miss anything? It stays with our team." If they hesitate at all, don't record; take better notes. Never record without asking.

## After: five minutes, immediately

Before you check your phone, before the next interview, fill in the debrief at the bottom of the notes page:

1. Three things you learned that you didn't know before the call.
2. One thing that surprised you.
3. The single best quote.
4. Your signal read: strong, medium, or weak, in one line.
5. Any names they gave you, and a message to those people sent within the hour.

If you skip this, by tomorrow you'll remember the vibe and none of the facts.

### Do it now

1. Run interviews one through three. If you're on a team, be on at least one call as the note-taker and one as the asker.
2. Complete a notes page for each, with at least two exact quotes per interview.
3. Write the five-line debrief within five minutes of hanging up, every time.
4. After your third interview, compare notes as a team. Is the same story showing up, or three different problems? Write one line about it in your interview log.

### Check yourself

- Did the other person talk for at least two-thirds of the call?
- Is your idea still completely undisclosed to all three people?
- Does each notes page have at least two sentences in quotation marks that you could read aloud in the person's voice?
- Did you send messages to every referral within an hour?
$md$,
      7
    ),
    (
      $md$Reading the Signal: Ten Conversations Into One Decision$md$,
      $md$Ten interviews produce a pile of notes and a strong temptation to hear what you hoped to hear. This lesson is a method for turning the pile into a decision you can defend: pursue, pivot, or kill. All three are good Week 1 outcomes. Only one of them is a bad Week 5 outcome.

## Goal

By the end of this lesson your team has a one-page signal summary: the pattern count across all interviews, the strongest and weakest evidence, and a verdict with three reasons pulled directly from your notes.

## Step one: lay the notes side by side

Put all ten notes pages in one place: a table, a wall of sticky notes, a spreadsheet with one row per interview. Do this with your team, in one sitting. Reading the notes one at a time over three days is how patterns get missed.

## Step two: count the pattern

For each of these, count how many of your ten interviews it showed up in. Write the number, not "most" or "a lot."

| Signal | Count out of 10 |
| --- | --- |
| Told a specific story about the last time the problem happened | |
| Described a real cost (time, money, stress) with a number or a concrete example | |
| Has an active workaround they use today | |
| Has spent money or more than an hour a week on the problem | |
| Brought up the problem before you asked about it directly | |
| Gave you at least one referral without being pushed | |
| Said it happens weekly or more | |

The rule of thumb: a signal that shows up in three or fewer of ten is noise. Four to six is a maybe worth one more round of interviews. Seven or more is a pattern. If your top row is at seven and your "spent money" row is at two, you've found a problem people notice but don't pay to fix, which is a vitamin.

## Step three: sort the evidence

Split everything you heard into three columns.

**Strong evidence** is a past behavior with a cost attached. "I bought a second servo with my own money." "I built a spreadsheet and update it every Sunday." "We lost the first thirty minutes of every practice in March." Strong evidence is what you build on.

**Medium evidence** is a specific story without a cost, or a cost without a story. "It happens a lot." "It's a hassle." Medium evidence tells you where to ask better questions next time.

**Weak evidence** is anything about the future or anything nice. "I'd definitely use that." "Cool idea." "You should totally build it." Weak evidence goes in the log and nowhere else. It is not a reason to do anything.

## Step four: red flags

Any of these is a reason to slow down, not necessarily to stop.

- Everyone described a different problem when you asked about the last time it happened.
- Nobody has a workaround. Not because it's impossible, but because nobody cared enough to try.
- The people with the most pain are the people with the least ability to pay or decide.
- Your best quotes all came from people who know you.
- You had to explain the problem to more than three of your ten before they recognized it.

## Step five: the verdict

**Pursue.** Seven or more on the story row, four or more on the money-or-time row, and at least three strong-evidence quotes from strangers. Move to the demand test with this problem.

**Pivot.** The problem is real but it's not the one you wrote down. Maybe it's the same people with a different pain, or a different group with the same pain. Rewrite the problem statement using their words, then run three more interviews on the new version before Sunday.

**Kill.** Three or fewer on the story row, no workarounds, no money. Go back to your Problem Bank and take number four. You have lost two days and gained a week you'd otherwise spend building the wrong thing.

Killing a problem in Week 1 is a win. Post it as a build receipt in [Build receipts](/dashboard/resources/receipts) with what you learned; the cohort should see that it's normal.

## The one-page summary

Title, verdict in one word, then: the pattern table with counts, your three strongest quotes with who said them, the biggest red flag and how you'll handle it, and three reasons for the verdict that each point at a specific interview. One page. If it runs longer, you're arguing with yourself.

### Do it now

1. Get every notes page into one table and read them all in one sitting, as a team.
2. Fill in the pattern table with real counts. No adjectives.
3. Sort your quotes into strong, medium, and weak. Count the strong ones from strangers.
4. Write the verdict and the three reasons. If the team disagrees, each person writes their verdict alone first, then compare. Disagreement is information.
5. Save the one-page summary to your team folder and post the verdict and one quote in [Community](/dashboard/community).

### Check yourself

- Is every number in your pattern table an actual count, not a feeling?
- Did at least three strong-evidence quotes come from people who didn't know you before this week?
- Could a stranger read your one-page summary and reach the same verdict without talking to you?
- If your verdict is "pursue", did you resist the urge to round a five up to a seven?

### Not sure what you're looking at?

This is the most common thing founders bring to [office hours](/dashboard/office-hours) in Week 1, and it's a good use of a slot. Book an open one, bring your one-page summary and your three strongest quotes, and let the mentor read them cold. If no slot is open, post the summary privately to the team in [Discussions](/dashboard/discussions/new?to=team) and we'll give you a read in the thread.
$md$,
      8
    ),
    (
      $md$Design Your First Demand Test$md$,
      $md$Interviews tell you the problem is real. They don't tell you anyone will act. The gap between "yes, that's a problem" and "yes, here's my email" is where most ideas die, and you want to find out which side of it you're on this weekend, not in Week 5. This lesson is how to design one small test with a number attached.

## Goal

By the end of this lesson you have chosen one demand test, written a one-sentence hypothesis with a pass/fail number decided in advance, and listed exactly what you need to run it this weekend.

## What counts as demand

Demand is a person giving up something to get closer to your solution before it exists: their email, ten minutes to book a call, a spot on a waitlist, a deposit, a signed-up teammate. Compliments cost nothing and count for nothing. The test you design has to ask for something that costs the person a little.

## Five tests you can run in a weekend

| Test | What it is | Best when | What it costs you |
| --- | --- | --- | --- |
| **Landing page + waitlist** | A one-page site describing the problem and your fix, with an email box | You can reach 50+ people online | An evening, a free page builder |
| **Fake door** | A button or link for a feature that doesn't exist yet; you count clicks and show "coming soon" | You already have a place people visit, or a community post that gets traffic | An hour |
| **Concierge** | You do the job by hand for two or three real customers, no product at all | The problem is a task someone needs done (organizing, matching, tracking) | Your time, this weekend |
| **Pre-sale or deposit** | You ask for money, or a small deposit, for something you'll deliver later | Interviews showed people already spend money on this | Nerve, and a way to refund |
| **Sign-up sheet in the real world** | A paper or form sign-up at the place your customer already is: a club meeting, a shop counter, a league event | Your customer is local and physical | One trip, one printout |

Pick one. Not two. The point is a clean answer to a single question.

## Pick a number before you start

A demand test without a pass line is a demand test you'll declare a success no matter what. Before you run it, write down the number that would make you keep going and the number that would make you stop.

The shape of the hypothesis:

> If we [put the test in front of] [how many] [specific people] by [date], at least [number] will [the costly action].

Running example (hypothetical): "If we post a landing page in three FTC Discord servers and DM it to the twenty captains we've talked to by Saturday night, at least 12 of the roughly 100 people who see it will join the waitlist by Sunday at 6 p.m." Twelve of a hundred is the pass line. Four would be a fail. Eight is the awkward middle, and you decide now what eight means: one more round with a rewritten page, not a green light.

Reasonable pass lines for a first test: 10 to 15% of visitors joining a waitlist, 3 of 5 interviewees agreeing to a concierge trial, 2 people putting down any amount of money. Numbers below those are not failures; they're information about the message, the segment, or the problem, in that order.

## Build it with free tools

You do not need to code anything this week. A one-page site builder, a form tool, and a design tool with free tiers will cover all five tests. Spend no money. Spend no more than three hours building. If your build is taking longer than that, you've started building the product; stop and shrink the test.

Whatever you build, it says three things in this order: the problem in the customer's words (use a real quote from your interviews), what changes for them, and one clear ask. No feature list. No pricing table. One button.

## Keep the labels honest

When you write up results, mark every number as one of three things: **observed** (you counted it), **estimated** (you inferred it, say how), or **planned** (it hasn't happened yet). "100 people saw the page" is observed if you have analytics and estimated if you're guessing from the server's member count. Mixing these up is how teams talk themselves into a pass.

### Do it now

1. Choose your test using the table. Write one line on why this one fits your problem and your reach.
2. Write the hypothesis sentence with a real date and a real number. Write the fail number too.
3. List exactly what you need: the page, the form, the message, the three Discord servers, the printout. Assign each item to a teammate with a time.
4. Draft the three sentences your test will say, using one exact quote from your interviews as the first line.
5. Put the hypothesis in your team folder. You'll report against it in Week 2.

### Check yourself

- Does your test ask for something that costs the person a little: an email, a booking, time, or money?
- Did you write the pass and fail numbers down before building anything?
- Can you build the whole test in under three hours without writing code?
- Does the first line of your test use a customer's words, not yours?
$md$,
      9
    ),
    (
      $md$The Lean Canvas, Box by Box$md$,
      $md$The Lean Canvas is a one-page replacement for the forty-page business plan nobody reads. Nine boxes, one sheet, twenty minutes to fill if you've done the interviews and two hours of guessing if you haven't. It's your Week 1 deliverable, and the point isn't the document; it's that filling it in honestly shows you exactly what you know and what you're still assuming.

## Goal

By the end of this lesson you have a Lean Canvas v1 with all nine boxes filled, every entry tagged observed, estimated, or planned, and the two or three boxes you're least sure about marked as the questions Week 2 has to answer.

## The three tags

Before you write a word, agree on this with your team. Every line in every box gets one tag:

- **Observed.** You saw it or heard it from a customer this week. You can point to the interview.
- **Estimated.** You worked it out from something you observed. Say how.
- **Planned.** You intend to do it. It hasn't happened.

A canvas that's all "planned" is a wish. A canvas that's honest about being 60% planned in Week 1 is exactly what a Week 1 canvas should look like. The tags are what make it useful instead of decorative.

## Fill the boxes in this order

Not left to right. The order below follows what you actually learned this week, so the evidence flows into the boxes that depend on it.

### 1. Problem

The top three problems your segment has, in their words. Your problem statement from earlier this week goes first. Under it, list the existing alternatives: what they do today, including "nothing" and "a spreadsheet". This box should be almost entirely **observed** by now. If it isn't, go back to your interview log.

### 2. Customer segments

Who has the problem, narrowly. Then, inside that, your early adopters: the people with the ugliest workaround and the most responsibility for the outcome. "FTC team captains" is the segment; "captains of teams with 12+ members who share a physical parts bin" is the early adopter. **Observed** for the segment, **estimated** for how many of them there are.

### 3. Unique value proposition

One sentence a customer would understand in a breath: what changes for them, and why you and not the alternative. Use a phrase from your best quote if you can. Not "a platform for team inventory" but "know what parts you have before practice starts". Mostly **planned**; you'll test it in the demand test.

### 4. Solution

The smallest thing that addresses each of the three problems. One line per problem. If a line describes more than one feature, cut it. Entirely **planned** this week, and that's fine.

### 5. Channels

How you'll reach the segment. Only write down channels you have actually used to reach people this week: the Discord servers where you got replies, the club meetings you walked into, the intros that worked. Those are **observed**. Anything else is **planned** and goes below a line.

### 6. Revenue streams

How money arrives. If interviews showed people already spending on a workaround, write down what and how much: that's **observed**, and it's the strongest thing on the page. Your own pricing idea is **planned**. It's okay for this box to be thin; Week 2 spends real time here.

### 7. Cost structure

What it costs to run the test and the first version: tools, time, any fees. Free tiers count as a cost of zero for now, with a note about what happens when you outgrow them. **Estimated**.

### 8. Key metrics

The one or two numbers that tell you it's working. For Week 1 it's usually the demand-test number you already set: waitlist signups per hundred visitors, concierge trials accepted, deposits taken. **Planned**, with the pass line written in.

### 9. Unfair advantage

Something a competitor can't easily copy. For most Week 1 teams the honest answer is "we don't have one yet, but we have access to [this specific community] and [these ten relationships]." Write that. An honest blank beats a made-up moat.

## A note on the example

Running example (hypothetical): Maya's team ends Week 1 with Problem and Customer segments fully observed, Channels half observed (two Discord servers worked, cold email to coaches didn't), Revenue with one observed line ("three of ten captains have bought duplicate parts with their own money this season") and one planned line, and everything else planned. Their canvas has more planned than observed. That's a good Week 1 canvas: it tells them precisely what to test next.

### Do it now

1. Draw the nine boxes on one page: a whiteboard, a doc with a table, a sheet of paper you photograph. Keep it to one page.
2. Fill the boxes in the order above, as a team, with your interview log open. Tag every line.
3. Count your tags. Write the totals at the bottom of the page: observed, estimated, planned.
4. Circle the two or three boxes where you're most unsure. Write one sentence under each: what would you need to see in Week 2 to fill it honestly?
5. Save it to your team folder as "Lean Canvas v1" with the date. You'll make a v2 in two weeks and you'll want to see what changed.

### Check yourself

- Is the Problem box entirely in your customers' words, with a real existing alternative listed?
- Does every line on the page carry one of the three tags?
- Is the Revenue box built on something you observed, even if it's small?
- Could a mentor read your canvas and tell in thirty seconds what you know versus what you're guessing?

### Want a second pair of eyes on it?

Post a photo or a link to your canvas privately to the team in [Discussions](/dashboard/discussions/new?to=team), or bring it to an open [office hours](/dashboard/office-hours) slot. Tell us which boxes you circled. We're not grading it; we're looking for the place where a planned line is pretending to be an observed one, because everyone has one.
$md$,
      10
    ),
    (
      $md$The One-Sentence Startup and Your First Check-in$md$,
      $md$Two short things that close the week. First, a single sentence that says what you're doing, so that when someone asks, you don't reach for "it's kind of like…". Second, your first weekly check-in, which is how the team knows where you are and where to step in.

## Goal

By the end of this lesson you have a one-liner that three people who don't know your idea repeated back to you correctly, and you've submitted a check-in that tells the truth about the week.

## The one-liner

The formula is dull on purpose. Dull formulas produce sentences people repeat. Clever ones produce sentences people forget.

> We help [specific who] [do a specific thing] so they can [the outcome they care about], without [the pain they have today].

Running example (hypothetical): "We help FTC team captains know what parts they have before practice starts, so build sessions start on time, without the group-chat scavenger hunt."

Rules:

- **The who is your early adopter, not your eventual market.** You will widen it later. Right now, precision is what makes people say "oh, I know someone like that."
- **The verb is something they'd say.** "Know what parts we have" is theirs. "Optimize inventory workflows" is nobody's.
- **The pain is the one you heard most.** Pull it from your pattern table, not your imagination.
- **One breath.** Say it aloud. If you need to inhale halfway through, cut a clause.

## Words that mean you're not done

If any of these appear in your sentence, you've hidden a vague idea inside a confident tone. Rewrite.

| Word | Why it's a problem | Ask instead |
| --- | --- | --- |
| for everyone, anyone, all | No customer can hear themselves in it | Who, specifically, this week? |
| platform, ecosystem, solution | Describes a shape, not a job | What does a person actually do with it? |
| revolutionary, disrupt, reimagine | Claims a result you haven't seen | What changes on Thursday afternoon? |
| all-in-one, seamless, easy | Every product says this | What's the one thing it does? |
| AI-powered, using AI | How you'd build it, not why they'd want it | What does the customer get? |

## The three-person test

Say your one-liner once to three people who don't know your idea. Don't explain. Then ask each to say it back in their own words. If all three get the who and the job right, you're done. If two of them add "so it's like an app for…", your sentence is leaning on them to fill in a gap. Find the gap and fill it yourself.

## Your first check-in

The [weekly check-in](/dashboard/checkin) asks three things: what you accomplished, what's next, and any blockers. It takes ten minutes. Every one is read by the batch0 team, and the blockers box is the one we read first.

**What you accomplished.** Numbers, not adjectives. "Ten interviews (seven strangers), verdict: pursue, Lean Canvas v1 done, demand test drafted for Saturday." Not "made great progress on validation."

**What's next.** The demand test with its pass line, and the two or three canvas boxes you circled.

**Blockers.** This is the part people leave blank because it feels like admitting something. Fill it in. "Can't get replies from adult customers." "Team disagrees on the verdict." "Not sure the problem is big enough." Every one of those is something we can actually help with, and none of them can be helped if you don't say it. A blank blockers box on a week with real blockers is the only bad check-in.

If something is a milestone (first stranger interview, first kill, first signup), mark it. The cohort should see that those happen.

### Do it now

1. Write your one-liner with the formula. Check it against the table of words. Say it aloud once with a timer; under six seconds.
2. Run the three-person test today. Write down what each person said back, word for word. Fix the gap if there is one.
3. Add the final one-liner to the top of your Lean Canvas, above the Problem box.
4. Submit your [check-in](/dashboard/checkin). Numbers in the first box, the demand test in the second, and at least one honest line in blockers, even if it's small.

### Check yourself

- Did three people who didn't know the idea repeat the who and the job back to you correctly?
- Is every word in your one-liner a word your customer would use?
- Does your check-in have at least three numbers in it?
- Did you write something real in the blockers box?

### About the blockers box

If your blocker is urgent, don't wait for the check-in to be read. Post it privately to the team in [Discussions](/dashboard/discussions/new?to=team) and we'll pick it up in the thread. The check-in is the weekly record; Discussions is the fast lane.
$md$,
      11
    ),
    (
      $md$Ten Week 1 Mistakes and the Fix for Each$md$,
      $md$The same ten things go wrong in almost every first week, for almost every team. None of them is a sign you're bad at this. All of them are cheaper to fix on Wednesday than on Sunday. Read this once now and once more mid-week.

## Goal

By the end of this lesson you've checked your team's actual Week 1 work against all ten, found the one or two you're closest to making, and written down the fix you're applying this week.

## The ten

### 1. You picked the idea before you collected the problems

The tell: your Problem Bank has one row you care about and nine you wrote to fill the table. The fix: go back to the hunting grounds for thirty minutes and find two problems you'd be slightly embarrassed to work on. Score them honestly. If your favorite still wins, good; now it won for a reason.

### 2. You interviewed people who like you

The tell: eight of your ten interviews are friends, teammates, or family. The fix: the ten-interview target is ten strangers or near-strangers. Friends are a warm-up, not a data point. Send fifteen cold messages today.

### 3. You described the product in the interview

The tell: your notes contain the words "they liked it" or "they said they'd use it." The fix: strike those lines from the log. They're noise. In your next interview, if you hear yourself starting a sentence with "so we're thinking of…", stop and ask "what did you do last time?" instead.

### 4. You asked about the future

The tell: notes full of "would", "could", "might". The fix: rerun the question as a past-tense one. "Would you pay for this" becomes "what have you paid for to deal with this". Every future-tense answer in your log gets a follow-up message asking for the last real example.

### 5. Your customer is "students" or "small businesses"

The tell: you can't list ten real people, and your outreach has no obvious place to go. The fix: shrink the who until you can name them. "Captains of FTC teams in our league." "The six nail salons on Main Street." Widen later, after you have ten.

### 6. You counted compliments as evidence

The tell: your signal summary has quotes like "this is so needed" and "great idea." The fix: sort every quote into strong, medium, weak. Strong is past behavior with a cost. Everything nice goes in weak. If your strong column has fewer than three quotes from strangers, you have more interviewing to do, not a verdict.

### 7. You have no pass line for your demand test

The tell: "we'll see how it goes." The fix: write the hypothesis sentence with a real number and a real date before you build a thing. If the team can't agree on a number, take the higher one. It's easier to be honest about missing a hard target than about scraping past a soft one.

### 8. You built the product instead of the test

The tell: it's Saturday and you're on your fourth hour of a landing page, or your first hour of code. The fix: a demand test takes under three hours and zero code. Cut everything except the customer's problem in their words, what changes, and one button.

### 9. Your Lean Canvas is all "planned" and tagged nothing

The tell: nine boxes of confident sentences with no way to tell which came from an interview. The fix: tag every line observed, estimated, or planned. Count the tags. If Problem and Customer segments aren't mostly observed, the canvas is a wish; go back to the log and fill them from real quotes.

### 10. You didn't ask for help until Sunday

The tell: a blank blockers box, and a Discussions page you've never opened. The fix: the twenty-minute rule. Stuck for twenty minutes means post it, privately to the team or openly to the cohort. Book an office-hours slot when one is open. The team reads every check-in and every private thread; nothing you're stuck on is too small or too early.

## Two that aren't mistakes

**Killing your idea.** If your interviews said no, and you listened, and you went back to your Problem Bank for number four, you did Week 1 correctly. Post it as a build receipt.

**A canvas that's mostly planned.** In Week 1 that's the honest state of almost every team. What matters is that it's tagged, so you know exactly what to test.

### Do it now

1. Go through all ten with your team's actual work open: the bank, the log, the summary, the canvas. For each, write "clear", "close", or "doing it".
2. For every "close" or "doing it", write the fix from this page as a task with a name and a day.
3. Pick the one mistake you personally are most likely to make and tell a teammate to watch for it. Then do the same for them.
4. If any fix needs a second opinion, post it in [Discussions](/dashboard/discussions) today rather than after the check-in.

### Check yourself

- Did you check against all ten with the actual documents open, not from memory?
- Do you have at least one "close" or "doing it"? Everyone does. Finding zero means you weren't looking.
- Does every fix have a day attached?
$md$,
      12
    ),
    (
      $md$Week 1 Wrap: Ship List, Self-Review, and What Week 2 Needs$md$,
      $md$This is the last lesson of the week. It's short on teaching and long on checking, because the point of Week 1 wasn't to learn about validation; it was to do it. Go through the ship list, grade yourselves honestly, and set up Week 2 so Monday starts with work instead of with figuring out where you left off.

## Goal

By the end of this lesson every item on the ship list is either done and in your team folder or marked with what's missing and when it'll be done, your team has completed the self-review, and you know what Week 2 will ask of you.

## The ship list

Go down this with the folder open. "Done" means it's in the folder and a teammate could find it.

| # | Artifact | Done when |
| --- | --- | --- |
| 1 | Problem Bank | Ten rows, all columns filled, scores on every row |
| 2 | Top three problem statements | One sentence each, no products, in the template shape |
| 3 | First-customer portraits | One real person per problem, with their actual words |
| 4 | Interview script and notes template | Adapted to your problem, used by the whole team |
| 5 | Interview log | Ten completed notes pages, at least seven from strangers, exact quotes on every page |
| 6 | Signal summary | One page: pattern counts, three strongest quotes, red flags, verdict with three reasons |
| 7 | Demand-test plan | One test chosen, hypothesis with pass and fail numbers, build list with owners |
| 8 | Lean Canvas v1 | Nine boxes, every line tagged, tag counts at the bottom, two or three boxes circled |
| 9 | One-liner | Passed the three-person test, sits at the top of the canvas |
| 10 | Weekly check-in | Submitted, with numbers and at least one real blocker |

If you're at eight of ten, you had a good week. If you're at five, look at which five: missing interviews is a real gap; a missing portrait isn't.

## The self-review

Each person on the team scores these alone, 1 to 3, then you compare. Where you differ by two, talk about why. The scores are for you; nobody else grades them.

| Question | 1 | 2 | 3 |
| --- | --- | --- | --- |
| **Evidence.** How much of what we believe came from strangers this week? | Mostly from us and our friends | Mixed | Mostly from people we didn't know on Monday |
| **Honesty.** When the evidence was weak, did we say so? | We rounded up | We noticed and mostly held the line | We wrote down the weak parts in the summary |
| **Speed.** Did we do the work in the order it needed, without stalling? | We lost days to a decision we could have made in an hour | A slow start, then steady | Every day's work happened that day |
| **Asking.** When we were stuck, did we say something? | We sat on it | We asked late | We asked within the day, and it helped |

Anything you scored a 1 becomes your first fix for Week 2. Write it down now while it's specific.

## Peer review, if you want it

Swap signal summaries with another team in [Discussions](/dashboard/discussions). Read theirs cold and answer two questions: "What's the strongest quote here?" and "Which verdict would I give from this page alone?" Then compare with what they wrote. If you'd rather not swap, do the same two questions on your own summary a day after you wrote it. Both work; the swap is faster at finding blind spots.

## What Week 2 will ask of you

Week 2 is Build. You'll take the problem you validated and ship the smallest thing that lets a real person do the one job: a landing page that converts, a no-code first version, a concierge service you run by hand. You'll also put real numbers on the business: what it costs to deliver, what someone might pay, whether the arithmetic works.

Every one of those depends on Week 1 being real. A landing page for a problem nobody described in an interview converts at zero. Pricing for a customer you can't name is a guess about a guess. So before Monday:

- Your demand test has run, or is scheduled with a date and an owner. Report against the pass line, with observed, estimated, and planned labels.
- Your interview log is in one place and everyone on the team has read all ten pages.
- The two or three circled boxes on your canvas are written as questions Week 2 has to answer.

## Common Week 1 regrets

Founders who have done a first week like this one tend to say the same few things: they wish they'd sent the cold messages on Tuesday instead of Thursday; they wish they'd written down exact quotes from the first interview instead of the fourth; they wish they'd asked for help on the thing that stalled them for two days. Notice that none of these are "I wish I'd built more." Nobody says that.

### Do it now

1. Go through the ship list with the folder open. Mark each item done or write what's missing and the day it'll be done.
2. Complete the self-review alone, then as a team. Write the Week 2 fix for anything scored a 1.
3. Confirm your demand test has a date and an owner, or has already run. Put the result, or the plan, in the folder.
4. Read [Announcements](/dashboard/announcements) and [Events](/dashboard/events) for Week 2's schedule, and put the live session in your calendar.
5. Mark this lesson complete, then take the evening off. You earned it.

### Check yourself

- Could a mentor open your team folder and find all ten artifacts without asking you where anything is?
- Is at least one thing on your list marked honestly as "not done" with a date, rather than quietly skipped?
- Do you know the three questions Week 2 has to answer for your canvas?

### One last thing from the team

Every check-in gets read. Every private thread gets a reply. If something about this week didn't work for you, whether it was the pace, a lesson that didn't land, or a schedule conflict, tell us directly in [Discussions](/dashboard/discussions/new?to=team) or at hello@batch0.org. Week 2 gets better when you do.
$md$,
      13
    )
  ) as seed(title, description, position)
where fg.id is not null
  and not exists (
    select 1 from public.lessons l
    where l.module_id = fg.id
      and l.title = seed.title
  );

-- ----------------------------------------------------------------------------
-- 3) The Week 1 reading list.
-- ----------------------------------------------------------------------------
insert into public.resources
  (cohort_id, category, title, description, external_url, pre_cohort, created_at)
select null::uuid, 'week 1 · validate', seed.title, seed.description, seed.url, false,
       -- newest-first on the page ⇒ ord 1 shows first
       now() - (seed.ord * interval '1 minute')
from (
  values
    (1, 'Vitamin or Painkiller? Why It Decides If People Buy', 'Read while scoring your Problem Bank. The Pain column is really asking this question: do people go looking for a fix, or just agree it would be nice?', 'https://batch0.org/blog/vitamin-vs-painkiller-startup'),
    (2, 'How to Tell If Your Startup Idea Is Too Small', 'The Reach column, explained. How to tell a project from a company before you spend a week on it, and how to widen a narrow problem without losing the customer.', 'https://batch0.org/blog/how-to-know-if-idea-is-too-small'),
    (3, '23 Real Business Ideas for High School Students', 'Not a menu to pick from. Read it for the problem behind each business and who the first customer was; use it to sharpen your own Problem Bank rows.', 'https://batch0.org/blog/business-ideas-high-school-students'),
    (4, '7 Early Signs Your Startup Idea Won''t Work', 'Seven red flags you can check against your top three before you interview anyone. Most show up in the ''what they do about it now'' column.', 'https://batch0.org/blog/signs-your-idea-wont-work'),
    (5, 'Why ''My Friends Love It'' Is Not Validation', 'Why the ten-interview target is ten strangers. Read this before you count a single friendly conversation toward your log.', 'https://batch0.org/blog/friends-family-said-they-loved-my-idea'),
    (6, 'Where to Find People to Interview for Your Startup Idea', 'No network, no company email, just a high schooler with a list of thirty to reach. Pairs with the Finding Ten Strangers lesson.', 'https://batch0.org/blog/where-to-find-people-to-interview'),
    (7, 'How to Cold DM Strangers About Your Startup Without Being Annoying', 'The difference between a message that gets a reply and one that gets ignored. Read it before you rewrite the three outreach templates in your voice.', 'https://batch0.org/blog/how-to-cold-dm-people-without-being-annoying'),
    (8, 'How to Talk to Customers When You''re Shy or Nervous', 'Scripts and small steps for the first interview when talking to strangers is the hard part. Most of the cohort needs this one; nobody admits it.', 'https://batch0.org/blog/talk-to-customers-when-shy'),
    (9, 'How Many Customer Interviews Do You Actually Need?', 'Why the target is ten, when seven is fine, and how to tell you''ve heard enough. Read alongside the pattern table in Reading the Signal.', 'https://batch0.org/blog/how-many-customer-interviews-are-enough'),
    (10, 'How to Run a Survey That Actually Tells You Something', 'Optional this week. If you''re tempted to send a Google Form instead of doing interviews, read this first; it explains what surveys can and can''t tell you.', 'https://batch0.org/blog/how-to-run-a-survey-that-isnt-useless'),
    (11, 'Problem-Solution Fit: Are You Building the Right Thing?', 'What Week 1 is actually trying to prove, in one article. Read it when you write your signal verdict so ''pursue'' means something specific.', 'https://batch0.org/blog/problem-solution-fit-explained'),
    (12, 'How to Test a Business Idea Before You Build It', 'Landing pages, fake doors, pre-sales, and concierge tests side by side. The long version of the demand-test table, with how each one works.', 'https://batch0.org/blog/how-to-test-business-idea-before-building'),
    (13, 'What Is a Fake Door Test and How to Run One', 'The cheapest demand test on the list, in detail. Good if you already have a place people visit or a community post that gets traffic.', 'https://batch0.org/blog/fake-door-test-explained'),
    (14, 'Do Waitlist Signups Mean Your Idea Is Validated?', 'What a hundred emails proves and what it doesn''t. Read before you set your pass line so you know what the number will and won''t tell you.', 'https://batch0.org/blog/waitlist-signups-as-validation'),
    (15, 'How to Validate a Startup Idea With No Money', 'Every test in this week''s field guide costs zero dollars. Here''s the full list of free ways to run them, and the free tiers that cover a weekend.', 'https://batch0.org/blog/validate-idea-with-no-money'),
    (16, 'The Lean Canvas, Explained for Teen Founders', 'All nine boxes with examples a high schooler can follow. The companion to the Lean Canvas lesson; keep it open while you fill in v1.', 'https://batch0.org/blog/lean-canvas-guide-teen-founders'),
    (17, 'How to Write a One-Liner for Your Startup', 'The formula behind the one-sentence startup, and why boring formulas produce sentences people repeat. Read before the three-person test.', 'https://batch0.org/blog/write-a-startup-one-liner'),
    (18, 'Why Good Ideas Are Killing Your Startup', 'For the end of the week, when you''ve heard ten interesting problems and want to chase three. How to say no to good ideas so you can finish one.', 'https://batch0.org/blog/how-to-say-no-to-good-startup-ideas')
) as seed(ord, title, description, url)
where not exists (
  select 1 from public.resources r
  where r.title = seed.title or r.external_url = seed.url
);

notify pgrst, 'reload schema';
