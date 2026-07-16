/**
 * Seed the "Before One" pre-cohort flows — the standard interactive layer
 * that ships with every cohort (global, published). Idempotent: a flow whose
 * slug already exists is SKIPPED so admin curation is never clobbered; pass
 * --force to overwrite seeded flows with this file's version.
 *
 * Every flow is validated before anything is written: unique step keys,
 * every branch target exists, every {{placeholder}} in an outcome block
 * points at a real step (and a real field key for {{step.field}}).
 *
 * Usage:
 *   npm run seed-flows
 *   npm run seed-flows -- --force
 *
 * .env.local points at PRODUCTION Supabase — this writes to prod.
 */
import { createClient } from "@supabase/supabase-js";
import type { FlowStage, StepKind, StepConfig } from "../lib/flows.ts";

type SeedStep = {
  key: string;
  title?: string;
  kind: StepKind;
  body?: string;
  config?: StepConfig;
};

type SeedFlow = {
  slug: string;
  title: string;
  tagline: string;
  stage: FlowStage;
  est: number;
  sort: number;
  steps: SeedStep[];
};

// ---------------------------------------------------------------------------
// EXPLORE
// ---------------------------------------------------------------------------

const startingLine: SeedFlow = {
  slug: "starting-line",
  title: "The Starting Line",
  tagline:
    "A 10-minute founder diagnostic. Tells you where you stand and exactly what to do before kickoff.",
  stage: "explore",
  est: 10,
  sort: 10,
  steps: [
    {
      key: "intro",
      title: "Where are you, really?",
      kind: "content",
      body: `This is a diagnostic, not a quiz. There are no wrong answers — only wrong self-assessments.

Answer honestly and in ten minutes you'll get:

- your current **founder stage**
- your **biggest weakness** right now
- **three actions** to complete before kickoff
- a downloadable **Batch0 Readiness Score**

Nobody grades this. Lying to it only wastes your own head start.`,
    },
    {
      key: "route",
      title: "Which one is you?",
      kind: "choice",
      config: {
        options: [
          {
            value: "no_idea",
            label: "I don't have an idea yet",
            description: "I want to build something, but nothing has grabbed me.",
            next: "a-problems",
          },
          {
            value: "has_idea",
            label: "I have an idea",
            description: "There's a thing I keep thinking about building.",
            next: "b-idea",
          },
          {
            value: "building",
            label: "I'm already building",
            description: "Code, prototype, or a running project — something exists.",
            next: "c-what",
          },
        ],
      },
    },
    // ---- Branch A: no idea ----
    {
      key: "a-problems",
      title: "Forget ideas. What annoys you?",
      kind: "input",
      body: `Good startups start with problems, not inventions. Don't brainstorm "startup ideas" — inventory friction you've personally witnessed.`,
      config: {
        fields: [
          {
            key: "problems",
            label: "Three problems you've personally run into this month",
            placeholder:
              "e.g. our robotics team tracks parts in a group chat and loses them constantly…",
            multiline: true,
          },
          {
            key: "access",
            label: "Which groups can you reach that a random adult founder can't?",
            placeholder:
              "e.g. my school's 4 AP study groups, two FTC Discord servers, the club fair…",
            multiline: true,
          },
        ],
      },
    },
    {
      key: "a-time",
      title: "How many hours a week can you actually give this before kickoff?",
      kind: "choice",
      config: {
        options: [
          { value: "lt5", label: "Under 5 hours", next: "outcome" },
          { value: "5to10", label: "5–10 hours", next: "outcome" },
          { value: "10plus", label: "10+ hours", next: "outcome" },
        ],
      },
    },
    // ---- Branch B: has an idea ----
    {
      key: "b-idea",
      title: "Pin the idea down",
      kind: "input",
      body: `One sentence each. If you can't say it in a sentence, you don't have an idea yet — you have a vibe.`,
      config: {
        fields: [
          {
            key: "sentence",
            label: "The idea, in one sentence",
            placeholder: "We help [specific person] do [specific thing] without [frustration].",
            flags: [
              "for everyone",
              "all-in-one",
              "revolutionary",
              "AI-powered platform",
              "makes life easier",
              "connects users",
            ],
          },
          {
            key: "person",
            label: "Who exactly has this problem?",
            placeholder: "Not 'students'. Which students? Doing what? Where?",
          },
        ],
      },
    },
    {
      key: "b-evidence",
      title: "What evidence do you have that the problem is real?",
      kind: "choice",
      body: `Evidence means **behavior** — things people already do or pay for. Friends saying "cool idea" is not evidence; they're being nice.`,
      config: {
        options: [
          {
            value: "none",
            label: "Honestly, none yet",
            description: "It just feels like a real problem.",
          },
          {
            value: "friends",
            label: "Friends and family said they'd use it",
            description: "Encouraging words, no behavior.",
          },
          {
            value: "interviews",
            label: "I've interviewed people who have the problem",
            description: "Real conversations about what they currently do.",
          },
          {
            value: "workaround",
            label: "I've seen people hacking together workarounds",
            description: "Spreadsheets, group chats, manual effort — costly behavior.",
          },
        ],
      },
    },
    {
      key: "b-talked",
      title: "How many potential users have you actually talked to?",
      kind: "choice",
      config: {
        options: [
          { value: "zero", label: "0", next: "outcome" },
          { value: "few", label: "1–4", next: "outcome" },
          { value: "five-plus", label: "5 or more", next: "outcome" },
        ],
      },
    },
    // ---- Branch C: already building ----
    {
      key: "c-what",
      title: "What exists today?",
      kind: "input",
      config: {
        fields: [
          {
            key: "thing",
            label: "What you're building, in one sentence",
            multiline: false,
          },
          {
            key: "state",
            label: "What actually works right now, and who's using it?",
            placeholder: "Be honest. 'My friends tried it once' counts as zero users.",
            multiline: true,
          },
        ],
      },
    },
    {
      key: "c-users",
      title: "How many real users do you have?",
      kind: "choice",
      body: `A real user is someone who used it more than once **without you standing next to them**.`,
      config: {
        options: [
          { value: "zero", label: "0 real users" },
          { value: "some", label: "1–9 real users" },
          { value: "traction", label: "10 or more real users" },
        ],
      },
    },
    {
      key: "c-risk",
      title: "What would kill this project fastest?",
      kind: "choice",
      body: `This is your **riskiest assumption** — the thing you should be testing before anything else.`,
      config: {
        options: [
          {
            value: "nobody-wants",
            label: "Nobody actually wants it",
            description: "The problem might not be painful enough.",
            next: "outcome",
          },
          {
            value: "cant-reach",
            label: "I can't reach the people who'd use it",
            description: "The users exist but I have no channel to them.",
            next: "outcome",
          },
          {
            value: "cant-build",
            label: "I can't build the full version",
            description: "The tech is beyond what I can ship alone.",
            next: "outcome",
          },
          {
            value: "competitors",
            label: "Something better already exists",
            description: "Why would anyone switch?",
            next: "outcome",
          },
        ],
      },
    },
    // ---- Outcome ----
    {
      key: "outcome",
      title: "Your Batch0 Readiness Score",
      kind: "outcome",
      config: {
        blocks: [
          {
            when: { step: "route", in: ["no_idea"] },
            title: "Stage: Explorer — Readiness 3/10",
            body: `No idea yet is a fine place to start — most bad startups come from forcing an idea too early. Your **biggest weakness** right now: no chosen problem, so you can't practice anything real yet.

Your problems so far:

> {{a-problems.problems}}

Your unfair access:

> {{a-problems.access}}

**Three actions before kickoff:**

1. Run **The Idea Gym** (it's in Explore) and finish the Annoyance Inventory — 25 entries, no cheating.
2. Pick ONE problem from your list and have five conversations with people who have it. The **Talk to Strangers Pack** gives you the scripts.
3. Post your first interview to **Build Receipts**. One real conversation beats a week of brainstorming.`,
          },
          {
            when: { step: "b-evidence", in: ["none", "friends"] },
            title: "Stage: Idea-stage, unvalidated — Readiness 4/10",
            body: `You have an idea — "{{b-idea.sentence}}" — but zero behavioral evidence. That's your **biggest weakness**: right now the idea lives entirely in your head, and friends saying it sounds cool doesn't count. People lie to be kind.

**Three actions before kickoff:**

1. Read the first three chapters of **The Mom Test** (in the library below) — learn to ask about what people already do.
2. Interview three people who actually have the problem, using the **Talk to Strangers Pack**. No pitching — just questions.
3. Run **The Zero Week Challenge**. Seven days, one hour a day, and you'll arrive at kickoff with actual evidence instead of a hunch.`,
          },
          {
            when: { step: "b-evidence", in: ["interviews", "workaround"] },
            title: "Stage: Idea-stage, validating — Readiness 6/10",
            body: `You have an idea — "{{b-idea.sentence}}" — and real evidence behind it. You're ahead of most applicants. Your **biggest weakness**: the evidence hasn't been stress-tested against a real ask yet (a click, a signup, a commitment).

**Three actions before kickoff:**

1. Write your riskiest assumption on a **Riskiest Assumption Card** (it's in the Founder Field Kit) and design the cheapest test for it.
2. Put a fake landing page in front of 20 people from your **First 20 Users Directory** and count real actions, not compliments.
3. Post the results — good or bad — to **Build Receipts**. Failed experiments earn respect here.`,
          },
          {
            when: { step: "c-users", in: ["zero"] },
            title: "Stage: Builder without users — Readiness 4/10",
            body: `You're building "{{c-what.thing}}" — and that's exactly the trap. Building feels like progress while quietly avoiding the scary part: finding out if anyone wants it. Zero users after real building time is the **riskiest place a founder can be**.

**Three actions before kickoff:**

1. **Stop adding features.** Freeze the build this week.
2. Interview five people who should want this ({{c-risk}} is your riskiest assumption — test THAT, not your code). Use the **Talk to Strangers Pack**.
3. Get the smallest version in front of three strangers and watch them use it. Post what happens to **Build Receipts**.`,
          },
          {
            when: { step: "c-users", in: ["some", "traction"] },
            title: "Stage: Early traction — Readiness 7/10",
            body: `You're building "{{c-what.thing}}" and real people use it. Strong position. Your **biggest weakness**: at this stage most founders stop talking to users and start polishing — momentum quietly dies in the editor.

**Three actions before kickoff:**

1. Talk to your existing users this week. What do they actually use it for? What would they miss if it vanished?
2. Start a **Traction Tracker** (Field Kit) — one number, updated weekly, that tells you the truth.
3. Your riskiest assumption is "{{c-risk}}" — design one cheap experiment against it and post the result to **Build Receipts**.`,
          },
          {
            title: "Whatever your stage",
            body: `Download this summary and keep it. When the cohort starts, your mentor will ask what you did with your head start — this page is the assignment.

Next stop: **The Zero Week Challenge** if you have a problem to test, or **The Idea Gym** if you still need one.`,
          },
        ],
      },
    },
  ],
};

const ideaGym: SeedFlow = {
  slug: "idea-gym",
  title: "The Idea Gym",
  tagline:
    "For founders with no idea yet. Four exercises that turn everyday annoyances into testable problems.",
  stage: "explore",
  est: 40,
  sort: 20,
  steps: [
    {
      key: "intro",
      title: "Ideas are found, not invented",
      kind: "content",
      body: `A cool technology is not automatically a company. Brutal but necessary.

The founders who "always have ideas" aren't more creative — they're better at **noticing friction**. This gym trains exactly that, in four sets:

1. The Annoyance Inventory
2. The Workaround Hunt
3. The Access Advantage
4. Problem Ranking

Do them honestly. You'll leave with one ranked, testable problem — not a shower-thought.`,
    },
    {
      key: "annoyance",
      title: "Set 1 — The Annoyance Inventory",
      kind: "input",
      body: `Write down things that waste **time, money, or energy** in each area below. Aim for 25 total. Specific beats clever: "my coach re-types the roster into three apps every week" is gold; "school is inefficient" is nothing.`,
      config: {
        fields: [
          {
            key: "school",
            label: "School & studying (aim for 5)",
            multiline: true,
          },
          {
            key: "activities",
            label: "Sports, clubs & teams (aim for 5)",
            multiline: true,
          },
          {
            key: "family",
            label: "Family life & money (aim for 5)",
            multiline: true,
          },
          {
            key: "local",
            label: "Local businesses you interact with (aim for 5)",
            multiline: true,
          },
          {
            key: "online",
            label: "Online communities & creators (aim for 5)",
            multiline: true,
          },
        ],
      },
    },
    {
      key: "workarounds",
      title: "Set 2 — The Workaround Hunt",
      kind: "input",
      body: `A workaround is proof someone cares enough to suffer. Find people using:

- **spreadsheets** doing a job software should do
- **group chats** as a database, calendar, or filing system
- **repetitive manual work** nobody questions
- **weird combinations of tools** duct-taped together

Workarounds are pre-validated demand — the person is already "paying" in effort.`,
      config: {
        fields: [
          {
            key: "seen",
            label: "Three workarounds you've personally seen (who, doing what, with what tools)",
            multiline: true,
          },
          {
            key: "cost",
            label: "For the most painful one: what does it cost them (hours, money, mistakes)?",
            multiline: true,
          },
        ],
      },
    },
    {
      key: "access",
      title: "Set 3 — The Access Advantage",
      kind: "input",
      body: `Ask yourself:

> "Which groups can I reach that a random adult founder cannot?"

Robotics teams, AP students, school clubs, teen creators, your part-time job's customers, a local tutoring center. Your age is a distribution advantage in the right rooms — name the rooms.`,
      config: {
        fields: [
          {
            key: "groups",
            label: "Groups you can reach this week (be specific — names, not categories)",
            multiline: true,
          },
        ],
      },
    },
    {
      key: "ranking",
      title: "Set 4 — Problem Ranking",
      kind: "content",
      body: `Now score your best 3–5 problems, 1–5 on each axis:

| Axis | 1 | 5 |
| --- | --- | --- |
| **Frequency** | happens yearly | happens daily |
| **Severity** | mild annoyance | genuinely costly |
| **Existing spending** | nobody pays anything | money already changes hands |
| **Reach** | you know nobody affected | you can talk to 10 this week |
| **Testability** | needs months to test | testable in seven days |

A 20+ total is worth pursuing. A 15 with high **Reach** and **Testability** beats an 18 you can't test — pre-cohort, speed of learning wins.`,
    },
    {
      key: "pick",
      title: "Pick your problem",
      kind: "input",
      config: {
        fields: [
          {
            key: "problem",
            label: "The winning problem, in one sentence",
          },
          {
            key: "score",
            label: "Its score (out of 25) and the axis where it's weakest",
          },
          {
            key: "why",
            label: "Why this one — what evidence have you already seen?",
            multiline: true,
          },
        ],
      },
    },
    {
      key: "outcome",
      title: "You have a problem. Good.",
      kind: "outcome",
      config: {
        blocks: [
          {
            title: "Your pick",
            body: `> {{pick.problem}}

Score: {{pick.score}}

That sentence is now your job. Not an app, not a name, not a logo — a problem to investigate.

**Next moves:**

1. Take it into **The Zero Week Challenge** — seven days to evidence.
2. Use the **Talk to Strangers Pack** to line up your first three conversations from: {{access.groups}}
3. If the evidence kills it — great. Come back, pick the runner-up, and post "Killed a Bad Idea" to **Build Receipts**. That badge is earned, not given.`,
          },
        ],
      },
    },
  ],
};

const autopsyLibrary: SeedFlow = {
  slug: "startup-autopsies",
  title: "Startup Autopsy Library",
  tagline:
    "Brutally honest breakdowns of real startup attempts — what was assumed, what the evidence said, what died, and why.",
  stage: "explore",
  est: 15,
  sort: 30,
  steps: [
    {
      key: "intro",
      title: "Why autopsies, not highlight reels",
      kind: "content",
      body: `Most youth entrepreneurship programs only publish victory propaganda. It makes students think every mediocre idea becomes a company after adding a logo.

It doesn't. Most ideas die — and the deaths are more instructive than the wins. Each autopsy below follows the same format: the assumption, the evidence, the failure, the pivot (if any), and what got built that never should have been.

Read all three. Then steal the pattern, not the ideas.`,
    },
    {
      key: "autopsy-planner",
      title: "Autopsy #1 — The AI homework planner",
      kind: "content",
      body: `**Initial idea:** AI homework planner that auto-schedules study time.

**Fatal assumption:** students wanted another planner.

**Evidence collected:** 12 interviews. Not one student said scheduling was the problem. The real pain: teachers post assignments across Google Classroom, email, a portal, and paper handouts — students miss work they *did* because they never saw it.

**What failed:** three weeks were spent building calendar-sync AI before the first interview happened. All of it was thrown away.

**Pivot:** one dashboard showing assignments across platforms. No AI at all.

**Smallest useful MVP:** a manual weekly summary — the founder logged into each platform and emailed five students a combined list every Sunday night.

**First ten users:** the founder's own class group chat, then two study groups found through a friend.

**Result:** three of five used the manual summary repeatedly and asked for it unprompted on week 3. THAT was the signal worth building on.

**Time wasted building:** the entire AI scheduling engine. Nobody ever saw it.`,
    },
    {
      key: "autopsy-marketplace",
      title: "Autopsy #2 — The tutoring marketplace",
      kind: "content",
      body: `**Initial idea:** a marketplace connecting student tutors with younger kids' parents.

**Fatal assumption:** "if we build the platform, both sides will show up." Marketplaces need both sides at once — the hardest possible first startup.

**Evidence collected:** almost none before building. A survey (worthless — 40 people clicked "yes, I'd use this," zero ever did). Two months building profiles, reviews, booking, payments.

**What failed:** launch day: 9 tutor signups, 0 parents. The tutors were friends. The parents had never heard of it and trusted a Facebook group instead.

**Pivot:** none — the project died. The honest post-mortem: the founder wanted to build a *platform*, not solve a *problem*.

**What the smallest MVP should have been:** personally matching THREE parents with THREE tutors over text messages, taking a $5 coordination fee. Zero code. Would have surfaced the trust problem in one week instead of month three.

**Lesson:** if you can't make the transaction happen manually, software won't save it.`,
    },
    {
      key: "autopsy-recaps",
      title: "Autopsy #3 — The one that worked (by starting embarrassingly small)",
      kind: "content",
      body: `**Initial idea:** "a CRM for youth sports teams" — rosters, schedules, payments, chat.

**Fatal assumption (caught early):** that coaches wanted software. Interviews with six coaches said otherwise: they didn't want another login. They wanted parents to *stop asking the same questions*.

**Evidence collected:** the founder sat at practices and counted — coaches answered the same four questions ("what time Saturday?", "which field?", "who's bringing snacks?", "did you get my payment?") dozens of times a week, in three different group chats.

**MVP:** a single weekly text-message recap the founder wrote BY HAND for one team. No app. No login. It took 20 minutes a week.

**First ten users:** one team's parents, then the coach told two other coaches at a tournament. Coaches recruited coaches — the channel was the coaches themselves, not ads.

**Result:** by week six, eight teams. Parents replied "this is the only useful message I get." Only THEN did any code get written — automating what was already proven manually.

**What was never built:** the CRM. Nobody wanted a CRM.`,
    },
    {
      key: "patterns",
      title: "The pattern across every autopsy",
      kind: "content",
      body: `Same three mistakes, every time:

1. **Building before evidence.** Code written before interview #1 is usually deleted after interview #5.
2. **Trusting words over behavior.** Surveys and "I'd totally use that" predict nothing. Repeated use, workarounds, and money predict everything.
3. **Skipping the manual version.** If the service can be delivered by hand to five people, do that first. It's faster than software, and it can't hide the truth from you.

And the one habit that saved the survivor: **counting things in the real world** (questions per week, hours wasted) before deciding what to build.`,
    },
    {
      key: "outcome",
      title: "Autopsy complete",
      kind: "outcome",
      config: {
        blocks: [
          {
            body: `You've seen how ideas actually die: assumption unexamined, words trusted, manual version skipped.

**Apply it:** take your current idea (or the one you pick in **The Idea Gym**) and write down its fatal-assumption candidate — the belief that, if wrong, kills everything. That's the first thing you'll test in **The Zero Week Challenge**.`,
          },
        ],
      },
    },
  ],
};

const problemBank: SeedFlow = {
  slug: "problem-bank",
  title: "The 50-Problem Bank",
  tagline:
    "50 observable problems — not ideas. Who has each one, the current workaround, and what to investigate. No solutions included, on purpose.",
  stage: "explore",
  est: 20,
  sort: 40,
  steps: [
    {
      key: "intro",
      title: "Problems, not ideas",
      kind: "content",
      body: `This is deliberately **not** a list of 50 startup ideas. Finished ideas encourage copying; problems force interpretation — and interpretation is the actual founder skill.

Each entry is: **the problem** · who has it · the current workaround · what to investigate. No proposed solutions anywhere.

How to use it: skim all 50, shortlist three that you have unusual access to, then rank them with the Idea Gym rubric (frequency, severity, spending, reach, 7-day testability).`,
    },
    {
      key: "school",
      title: "School & studying (1–10)",
      kind: "content",
      body: `1. **Students miss assignments they actually completed** because work is posted across 4+ platforms. Workaround: screenshots and begging emails. Investigate: how many points lost per semester?
2. **Study groups die after two sessions** — no one owns scheduling. Workaround: a group chat that goes silent. Investigate: what kills session #3?
3. **Class notes are useless before exams** — messy, scattered, unsearchable. Workaround: borrowing "the smart kid's" notes. Investigate: what do top students do differently the night before?
4. **Teachers re-explain the same concepts** in office hours all week. Workaround: none — they just repeat. Investigate: which questions repeat most?
5. **College application tracking is a spreadsheet nightmare** — deadlines, essays, recommenders per school. Workaround: a parent-managed spreadsheet. Investigate: what gets missed, and what did it cost?
6. **Textbook resale is trust-broken** — DMs, no-shows, condition disputes. Workaround: Facebook groups and lost money. Investigate: how many transactions fail?
7. **Group projects punish the responsible kid** — no visibility into who did what. Workaround: one student does everything at 2am. Investigate: how do teachers actually grade contribution?
8. **Substitute teachers get no usable context** on where the class is. Workaround: a hand-scribbled note. Investigate: how much class time is lost per sub day?
9. **Students can't tell which scholarship deadlines apply to them** — hundreds of lists, mostly irrelevant. Workaround: seniors just skip applying. Investigate: how much money goes unclaimed locally?
10. **Language-class speaking practice barely exists** — 30 kids, 45 minutes. Workaround: nothing, or awkward partner drills. Investigate: what do the kids who get fluent actually do?`,
    },
    {
      key: "teams",
      title: "Sports, clubs & teams (11–20)",
      kind: "content",
      body: `11. **Coaches answer the same four logistics questions all week** across three group chats. Workaround: repeating themselves. Investigate: count the messages for one real team.
12. **Club treasuries run on a shoebox** — dues in cash, reimbursements on trust. Workaround: a treasurer's notebook. Investigate: how much money goes unaccounted per year?
13. **Robotics teams lose track of parts and tools** — shared bins, no inventory. Workaround: group chat "who has the crimper?". Investigate: hours lost per build season.
14. **Tryout/audition feedback is a black box** — kids never learn why they were cut. Workaround: rumors. Investigate: would coaches give structured feedback if it took 60 seconds?
15. **Team fundraisers rely on the same three parents** — sign-up sheets die. Workaround: mass emails nobody reads. Investigate: what made the last successful fundraiser work?
16. **Practice attendance is untracked until it's a crisis** — playoff eligibility surprises. Workaround: a coach's memory. Investigate: how attendance actually gets recorded across teams.
17. **New club members quit in week 2** — no onboarding, cliques by default. Workaround: none. Investigate: interview five people who quit a club — why?
18. **Volunteer hours are logged on paper** and lost before college apps. Workaround: guessing and unsigned forms. Investigate: what verification do schools actually accept?
19. **Small tournaments are organized in email chains** — brackets, schedules, results all manual. Workaround: one exhausted parent with Excel. Investigate: shadow an organizer for one event.
20. **Equipment handoffs between seasons lose gear** — jerseys and kits vanish. Workaround: deposit checks nobody cashes. Investigate: replacement cost per season at one school.`,
    },
    {
      key: "family",
      title: "Family & money (21–30)",
      kind: "content",
      body: `21. **Teens can't build any payment history** — first job, no bank trust. Workaround: cash and parents' cards. Investigate: what do teens actually get denied for?
22. **Family calendars fail at handoffs** — who's driving whom, which practice moved. Workaround: a whiteboard plus four apps. Investigate: count one family's scheduling messages for a week.
23. **Grandparents lose the tech-support lottery weekly** — scam texts, frozen tablets. Workaround: calling a grandkid. Investigate: what actually goes wrong most often?
24. **Allowance/chore systems collapse in two weeks** — tracking is more work than the chores. Workaround: parents just give up. Investigate: five families — what killed their system?
25. **First-job paychecks confuse teens** — withholding, W-4s, "where did $40 go?". Workaround: asking parents who also aren't sure. Investigate: what do teen workers wish they'd known?
26. **Hand-me-down markets are informal and wasteful** — sports gear, instruments, uniforms. Workaround: garage bins and buy-nothing groups. Investigate: what does a family with 3 kids re-buy anyway?
27. **Splitting costs among teen friend groups is awkward** — gas, food, gifts. Workaround: "I'll get you back" (they don't). Investigate: how much friction kills group plans?
28. **Parents can't evaluate tutors** beyond word-of-mouth. Workaround: expensive trial-and-error. Investigate: what signal would parents actually trust?
29. **College cost comparison is deliberately opaque** — sticker vs net price. Workaround: guessing from brochures. Investigate: how families actually chose, after the fact.
30. **Elder care coordination between siblings runs on group texts** — meds, appointments, who visited. Workaround: one sibling absorbs everything. Investigate: what information gets dropped?`,
    },
    {
      key: "local",
      title: "Local businesses (31–40)",
      kind: "content",
      body: `31. **Small restaurants ignore their online reviews** — no time to respond or learn from them. Workaround: nothing. Investigate: does responding measurably matter to owners?
32. **Barbers/nail techs juggle DM bookings** across Instagram, texts, walk-ins. Workaround: a paper book and double-bookings. Investigate: revenue lost to no-shows per week.
33. **Local shops can't compete with delivery speed** and don't know their inventory precisely. Workaround: phone calls — "do you have X?". Investigate: how many calls a day, how often wrong?
34. **Tutoring centers schedule with phone tag** — makeup sessions are chaos. Workaround: a whiteboard. Investigate: hours the front desk spends rescheduling.
35. **Youth sports photographers can't reach the parents** who'd buy — photos die on a hard drive. Workaround: a link in a team chat once. Investigate: what percent of parents even see the gallery?
36. **Food trucks broadcast location on Instagram** and regulars still miss them. Workaround: story posts. Investigate: how do the top trucks announce, and does it work?
37. **Small landlords track maintenance requests in texts** — things get forgotten, tenants get angry. Workaround: nothing. Investigate: a landlord's actual message history.
38. **Local service businesses (lawn, cleaning) lose track of quotes** — who was quoted what, when to follow up. Workaround: memory and sticky notes. Investigate: how many quotes never get followed up?
39. **Community theaters/dance studios sell tickets like it's 1998** — cash at the door, paper lists. Workaround: a generic form. Investigate: what does ticketing chaos cost per show?
40. **Neighborhood job boards are trust-broken** — babysitting, snow shoveling, pet care. Workaround: Nextdoor posts and hope. Investigate: how do both sides currently vet each other?`,
    },
    {
      key: "online",
      title: "Online life & creators (41–50)",
      kind: "content",
      body: `41. **Small Discord communities die silently** — mods can't see engagement dropping until it's gone. Workaround: vibes. Investigate: what signals preceded death in three dead servers?
42. **Student creators can't invoice brands** — they're under 18 with no business entity. Workaround: parents' PayPal and awkwardness. Investigate: how do brand deals with minors actually settle?
43. **Group-chat plans never converge** — 60 messages, no decision. Workaround: someone gives up and decides. Investigate: what fraction of plans die in the chat?
44. **Niche-community knowledge is trapped in chat scrollback** — the same questions asked weekly. Workaround: "search the channel" (nobody does). Investigate: top 10 repeated questions in one server.
45. **Study-content creators don't know what students actually struggle with** — they guess topics. Workaround: comment mining. Investigate: match creator topics against real exam pain points.
46. **Online tutoring sessions have no artifact** — the explanation evaporates when the call ends. Workaround: blurry screenshots. Investigate: what do students re-ask after sessions?
47. **Small newsletters can't find local sponsors** — and local businesses can't find them. Workaround: cold emails both directions. Investigate: what would a first sponsorship actually cost/pay?
48. **Game-server admins handle disputes with no tooling** — he-said-she-said in DMs. Workaround: trusted-mod judgment calls. Investigate: what evidence do good mods wish they had?
49. **Fan-art and commission work gets stolen/reposted** — teens have no recourse. Workaround: watermarks and callout posts. Investigate: what do working commission artists actually do about it?
50. **People collect recipes/resources across five apps** and can never find them again. Workaround: screenshots folder of doom. Investigate: watch three people try to re-find something they saved.`,
    },
    {
      key: "outcome",
      title: "Now interpret",
      kind: "outcome",
      config: {
        blocks: [
          {
            body: `You've seen 50. Remember: giving you finished ideas would encourage copying — these force you to interpret, and the interpretation is where the company hides.

**Do this now:**

1. Shortlist the **three** problems where you have unusual access (you know the coach, you're in the Discord, your parent runs the shop).
2. Score them with the **Idea Gym** rubric.
3. Take the winner into **The Zero Week Challenge** and start investigating — the "Investigate:" prompt on each entry is your first interview question.`,
          },
        ],
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// PROVE
// ---------------------------------------------------------------------------

const zeroWeek: SeedFlow = {
  slug: "zero-week",
  title: "The Zero Week Challenge",
  tagline:
    "Seven days, one problem, real evidence. Everything happens outside this platform — this page just keeps score.",
  stage: "prove",
  est: 45,
  sort: 10,
  steps: [
    {
      key: "intro",
      title: "The rules",
      kind: "content",
      body: `Seven days. About an hour a day. At the end you'll **know** — continue, change, or kill — instead of wondering.

| Day | Mission | Output |
| --- | --- | --- |
| 0 | Choose one problem | Problem statement |
| 1 | Find five people with it | Customer list |
| 2 | Interview three people | Evidence notes |
| 3 | Find existing alternatives | Competitor map |
| 4 | Write a one-sentence offer | Value proposition |
| 5 | Make a fake landing page | Shareable link |
| 6 | Put it in front of 20 people | Results |
| 7 | Decide: continue, change, or kill | Evidence report |

Three rules:

1. **Behavior over opinions.** Interviews, clicks, and sign-ups count. Friends saying it sounds cool does not.
2. **Every mission happens off this platform** — in DMs, calls, and real rooms. This is not "watch seven videos."
3. **Post receipts.** Each day's output belongs on **Build Receipts**. Evidence in public.`,
    },
    {
      key: "day0",
      title: "Day 0 — Choose one problem",
      kind: "input",
      body: `One problem. Not two. If you're torn, pick the one you can reach people for THIS week. (No problem yet? Do **The Idea Gym** first.)`,
      config: {
        fields: [
          {
            key: "statement",
            label: "Problem statement",
            placeholder:
              "[Specific person] struggles to [specific task] because [reason]. Today they cope by [workaround].",
            multiline: true,
            flags: ["everyone", "all people", "the world"],
          },
        ],
      },
    },
    {
      key: "day1",
      title: "Day 1 — Find five people who have it",
      kind: "input",
      body: `Real, named, reachable people. "Teenagers on Instagram" is not a person. Use your access: teammates, club members, the Discords you're already in, your part-time job.`,
      config: {
        fields: [
          {
            key: "people",
            label: "Your five (name/handle + where you'll reach them)",
            placeholder: "1. Maya — robotics team, sees her Tuesday…",
            multiline: true,
          },
        ],
      },
    },
    {
      key: "day2",
      title: "Day 2 — Interview three of them",
      kind: "input",
      body: `Use the **Talk to Strangers Pack** scripts. Core rule: ask about what they **already do**, not whether they'd use your imaginary product. Get stories, not predictions.`,
      config: {
        fields: [
          {
            key: "notes",
            label: "Evidence notes — the strongest quote from each interview",
            multiline: true,
          },
          {
            key: "surprise",
            label: "What surprised you most?",
            multiline: true,
          },
        ],
      },
    },
    {
      key: "day3",
      title: "Day 3 — Map the alternatives",
      kind: "input",
      body: `Your competitor is whatever people do TODAY — usually a spreadsheet, a group chat, or nothing. "No competitors" almost always means "no problem."`,
      config: {
        fields: [
          {
            key: "map",
            label: "What your five people currently use, and what it costs them",
            multiline: true,
          },
          {
            key: "gap",
            label: "The gap: what does the current way fail at?",
            multiline: true,
          },
        ],
      },
    },
    {
      key: "day4",
      title: "Day 4 — Write the one-sentence offer",
      kind: "input",
      body: `We help **[specific person]** accomplish **[specific outcome]** without **[current frustration]**.

(The **One-Sentence Startup Builder** flow drills this — the garbage-phrase detector below is watching.)`,
      config: {
        fields: [
          {
            key: "offer",
            label: "Your offer sentence",
            flags: [
              "for everyone",
              "all-in-one",
              "revolutionary",
              "AI-powered",
              "connects users",
              "makes life easier",
              "platform",
            ],
          },
        ],
      },
    },
    {
      key: "day5",
      title: "Day 5 — Fake landing page",
      kind: "input",
      body: `One page: the offer sentence, three bullets, one clear call-to-action (a signup form, a "join waitlist" button, a "DM me" link). Carrd, Framer, or plain HTML on Vercel — under two hours, ugly is fine.

The page's only job is to measure whether strangers take a **costly action**.`,
      config: {
        fields: [
          {
            key: "link",
            label: "The live link",
            placeholder: "https://…",
          },
          {
            key: "cta",
            label: "What action are you counting?",
            placeholder: "e.g. waitlist signups with a real email",
          },
        ],
      },
    },
    {
      key: "day6",
      title: "Day 6 — Twenty real people see it",
      kind: "input",
      body: `Not a story-post into the void — twenty **specific** people or a specific room (your First 20 Users Directory is exactly this). Then count what happened.`,
      config: {
        fields: [
          {
            key: "results",
            label: "The numbers: views → clicks → signups/replies",
            multiline: true,
          },
          {
            key: "said",
            label: "What did people say or ask, unprompted?",
            multiline: true,
          },
        ],
      },
    },
    {
      key: "decision",
      title: "Day 7 — The call",
      kind: "choice",
      body: `Evidence in front of you. Make the call the evidence supports — not the one your ego prefers.`,
      config: {
        options: [
          {
            value: "continue",
            label: "Continue",
            description: "Signals are real — same problem, same approach, go deeper.",
          },
          {
            value: "change",
            label: "Change",
            description: "The problem is real but my angle is wrong — pivot the approach.",
          },
          {
            value: "kill",
            label: "Kill",
            description: "The evidence says no. Kill it and take the lesson.",
          },
        ],
      },
    },
    {
      key: "report",
      title: "The evidence report",
      kind: "input",
      config: {
        fields: [
          {
            key: "summary",
            label: "Three sentences: what you believed, what the evidence showed, what you're doing about it",
            multiline: true,
          },
        ],
      },
    },
    {
      key: "outcome",
      title: "Zero Week — complete",
      kind: "outcome",
      config: {
        blocks: [
          {
            when: { step: "decision", in: ["continue"] },
            title: "Verdict: CONTINUE",
            body: `Your evidence backs the problem. Report:

> {{report.summary}}

**Next:** fill out a Lean Canvas Lite and a Riskiest Assumption Card from the **Founder Field Kit** — you'll want both on day one of the cohort. Keep the landing page ({{day5.link}}) collecting signups, and post your Day 6 numbers to **Build Receipts**.`,
          },
          {
            when: { step: "decision", in: ["change"] },
            title: "Verdict: CHANGE",
            body: `The problem survived; your approach didn't. That's a successful week — most founders never find this out until month three.

> {{report.summary}}

**Next:** re-run Days 4–6 only (new offer, new page, new 20 people) — the interviews and competitor map still stand. Post the pivot to **Build Receipts**; "First Pivot" is a badge for a reason.`,
          },
          {
            when: { step: "decision", in: ["kill"] },
            title: "Verdict: KILL — and that's a win",
            body: `You just did in seven days what some founders spend a year avoiding.

> {{report.summary}}

**Next:** post it to **Build Receipts** — "Killed a Bad Idea" is genuinely one of the most respected badges here. Then back to **The Idea Gym** or the **50-Problem Bank** for your next candidate. You now run this loop faster than almost anyone applying.`,
          },
          {
            title: "Your evidence, on record",
            body: `Download this summary — it's your evidence report: problem ({{day0.statement}}), interviews, competitor gap, offer, and numbers. Bring it to your first mentor conversation.`,
          },
        ],
      },
    },
  ],
};

const talkToStrangers: SeedFlow = {
  slug: "talk-to-strangers",
  title: 'The "Talk to Strangers" Pack',
  tagline:
    "Scripts for the scariest part: DMs, emails, follow-ups, and the questions that get truth instead of politeness.",
  stage: "prove",
  est: 15,
  sort: 20,
  steps: [
    {
      key: "intro",
      title: "The central rule",
      kind: "content",
      body: `> Ask about what they **already do**, not whether they would use your imaginary product.

People are polite. Ask "would you use this?" and they say yes to be nice, and you build a company on kindness. Ask "what did you do last time this happened?" and you get facts.

Everything in this pack exists to get you into conversations where that rule can work.`,
    },
    {
      key: "scripts",
      title: "The outreach scripts",
      kind: "content",
      body: `**Interview request — DM version**

> Hey [name] — I'm researching how [specific people] handle [specific task] for a project with batch0 (a startup program I'm in). You deal with this constantly — could I ask you 4 quick questions? 10 minutes, I'm not selling anything.

**Email version**

> Subject: 10 minutes on how you handle [task]?
>
> Hi [name], I'm [you], a student in the batch0 startup program. I'm researching how [specific people] deal with [problem] — [mutual contact / where you found them] suggested you'd have real insight. Could I ask you a few questions this week? Happy to work around your schedule, and I'm not selling anything.

**In person**

> "Can I ask you something random? You [coach/run/organize] [thing] — what's the most annoying part of [task]? I'm researching it for a startup program."

**Follow-up (48h later, once, then stop)**

> No worries if you're busy! Even 5 minutes by text would genuinely help. If not, thanks anyway.

**Thank-you (always)**

> Thank you — the bit about [specific thing they said] changed how I see this. If I end up building something, you'll be the first to know.`,
    },
    {
      key: "safety",
      title: "Safety rules (non-negotiable)",
      kind: "content",
      body: `You're 13–18 and talking to strangers. These rules are not suggestions:

- A parent/guardian knows who you're interviewing and when. For video calls with adults you don't know, they're within earshot.
- Public places only for in-person conversations — a coffee shop, a school event, a practice.
- Never share your home address, and use school or program email — not personal accounts with your full details.
- Interviews happen where messages are logged (email, DMs) — not disappearing chats.
- Anyone who makes it weird: end it, block, tell an adult. No interview is worth it.
- Before posting evidence to Build Receipts, strip personal info — first names or initials only.`,
    },
    {
      key: "questions",
      title: "Leading vs. non-leading questions",
      kind: "content",
      body: `The difference between research and fishing for compliments:

| Leading (bad) | Non-leading (good) |
| --- | --- |
| "Would you use an app that organizes assignments?" | "Walk me through how you kept track of homework last week." |
| "Isn't it annoying when the coach texts three chats?" | "How does your team find out about schedule changes?" |
| "Would you pay $5/month for this?" | "What have you paid for (money OR hours) to deal with this?" |
| "Don't you think X is a huge problem?" | "When did this last happen? What did you do?" |

Signals that you found something real: they get **specific and animated**, they've already **tried to fix it themselves**, they ask "**can you actually build that?**", they introduce you to someone else with the problem.

Silence-tolerance is a skill: ask, then shut up and count to five. The good stuff comes after the pause.`,
    },
    {
      key: "practice",
      title: "Now use it",
      kind: "checklist",
      body: `The pack only works if it leaves this page this week:`,
      config: {
        items: [
          {
            key: "sent",
            label: "Sent three interview requests using the scripts",
            hint: "DM or email, real people from your First 20 Users Directory.",
          },
          {
            key: "booked",
            label: "Booked at least one conversation",
          },
          {
            key: "done",
            label: "Completed one interview and wrote the notes down",
            hint: "Strongest quote + what surprised you.",
          },
          {
            key: "safety-ok",
            label: "A parent/guardian knows who you're talking to",
          },
        ],
        requireAll: false,
      },
    },
    {
      key: "outcome",
      title: "Pack armed",
      kind: "outcome",
      config: {
        blocks: [
          {
            body: `Scripts, safety, and question craft — you're equipped. Every interview from here on feeds **The Zero Week Challenge** (Day 2) and earns receipts on **Build Receipts**.

First Stranger Interview is a badge. Go earn it.`,
          },
        ],
      },
    },
  ],
};

const oneSentence: SeedFlow = {
  slug: "one-sentence-startup",
  title: "One-Sentence Startup Builder",
  tagline:
    "A positioning builder, not an idea generator. One specific person, one outcome, one frustration — with a garbage-phrase detector.",
  stage: "prove",
  est: 10,
  sort: 30,
  steps: [
    {
      key: "intro",
      title: "Why one sentence",
      kind: "content",
      body: `If you can't say it in one sentence, you can't put it on a landing page, a DM, or a pitch — which means you can't test it.

The template:

> We help **[specific person]** accomplish **[specific outcome]** without **[current frustration]**.

One precise audience, one concrete outcome, one named frustration. Vague words get flagged as you type — that's the point.`,
    },
    {
      key: "build",
      title: "Fill the three slots",
      kind: "input",
      config: {
        fields: [
          {
            key: "person",
            label: "The specific person",
            placeholder: "high school club treasurers · FTC team captains · youth soccer coaches",
            flags: ["everyone", "all students", "users", "people", "anyone"],
          },
          {
            key: "outcome",
            label: "The specific outcome",
            placeholder: "collect dues and know exactly who's paid",
            flags: ["makes life easier", "be more productive", "save time and money"],
          },
          {
            key: "frustration",
            label: "The current frustration",
            placeholder: "chasing 40 kids over three group chats",
            flags: ["wasting time", "inefficiency"],
          },
        ],
      },
    },
    {
      key: "garbage",
      title: "The garbage-phrase list",
      kind: "content",
      body: `These phrases feel impressive and mean nothing. Each one hides a decision you haven't made:

- **"For everyone"** — you haven't chosen a customer.
- **"All-in-one"** — you haven't chosen what matters most.
- **"Revolutionary"** — the customer decides that, not you.
- **"AI-powered platform"** — technology is not a benefit.
- **"Connects users"** — with whom? to do what?
- **"Makes life easier"** — which hour of whose life?

One audience, one channel, one message, one concrete action beats a vague multi-channel "vision" every time. If a phrase could appear in any startup's pitch, it's dead weight in yours.`,
    },
    {
      key: "rewrite",
      title: "The final sentence",
      kind: "input",
      body: `Assemble it, then sharpen. Read it aloud — would the person it names recognize themselves instantly?`,
      config: {
        fields: [
          {
            key: "sentence",
            label: "Your one-sentence startup",
            placeholder: "We help … accomplish … without …",
            multiline: false,
            flags: [
              "for everyone",
              "all-in-one",
              "revolutionary",
              "AI-powered",
              "platform",
              "connects users",
              "makes life easier",
            ],
          },
        ],
      },
    },
    {
      key: "outcome",
      title: "Positioned",
      kind: "outcome",
      config: {
        blocks: [
          {
            title: "Your sentence",
            body: `> {{rewrite.sentence}}

Built from: **{{build.person}}** / **{{build.outcome}}** / **{{build.frustration}}**.

**Put it to work:**

1. It's the headline of your Day-5 landing page in **The Zero Week Challenge**.
2. It's the first line of your outreach DMs (**Talk to Strangers Pack**).
3. Say it to three people who match "{{build.person}}". If they don't say "wait, that's me" — the person slot isn't specific enough yet. Rewrite and re-test.`,
          },
        ],
      },
    },
  ],
};

const first20: SeedFlow = {
  slug: "first-20-users",
  title: "The First 20 Users Directory",
  tagline:
    'Name exactly where your earliest users come from. "Social media" is not an answer — specific or rejected.',
  stage: "prove",
  est: 20,
  sort: 40,
  steps: [
    {
      key: "intro",
      title: "Specific or rejected",
      kind: "content",
      body: `Every startup's first 20 users come from somewhere the founder can already reach. "We'll post on social media" is how launches disappear.

Acceptable answers look like:

> Three New Jersey FTC Discord servers
> Two AP Calculus study groups
> Ten local dental offices on Route 9

You'll list twenty sources in four buckets. The vague-phrase detector is on — it will call you out.`,
    },
    {
      key: "know",
      title: "Five people you personally know",
      kind: "input",
      body: `People who have the problem AND would take your call today. Name them.`,
      config: {
        fields: [
          {
            key: "list",
            label: "Five names (and why each one fits)",
            placeholder: "1. Coach D — runs two travel teams, lives in his group chats…",
            multiline: true,
            flags: ["social media", "my followers", "friends and family"],
          },
        ],
      },
    },
    {
      key: "communities",
      title: "Five communities",
      kind: "input",
      body: `Named rooms, not platforms. Not "Discord" — WHICH server? Not "Reddit" — which subreddit, and are you already a member?`,
      config: {
        fields: [
          {
            key: "list",
            label: "Five specific communities (name + your standing in each)",
            placeholder: "1. NJ FTC Discord (member 2 yrs, 800 people)…",
            multiline: true,
            flags: ["social media", "instagram", "tiktok", "online communities"],
          },
        ],
      },
    },
    {
      key: "orgs",
      title: "Five organizations",
      kind: "input",
      body: `Clubs, schools, teams, local businesses — places with a person whose name you can find, who could put your thing in front of their members.`,
      config: {
        fields: [
          {
            key: "list",
            label: "Five organizations (and who inside each you'd approach)",
            placeholder: "1. Lincoln HS DECA — Ms. Park runs it, meets Thursdays…",
            multiline: true,
            flags: ["schools", "local businesses in general"],
          },
        ],
      },
    },
    {
      key: "cold",
      title: "Five cold prospects",
      kind: "input",
      body: `Strangers who visibly have the problem — you've seen them complain, post the workaround, or run the spreadsheet. Where exactly will you find them?`,
      config: {
        fields: [
          {
            key: "list",
            label: "Five cold prospects (who + where you found them)",
            placeholder: "1. The tutor who posts availability screenshots in r/…",
            multiline: true,
            flags: ["social media", "ads", "influencers"],
          },
        ],
      },
    },
    {
      key: "outcome",
      title: "Your directory",
      kind: "outcome",
      config: {
        blocks: [
          {
            title: "Twenty sources, on record",
            body: `**People you know:**
{{know.list}}

**Communities:**
{{communities.list}}

**Organizations:**
{{orgs.list}}

**Cold prospects:**
{{cold.list}}

**The rule:** message the first three TODAY — the Talk to Strangers Pack has the scripts. This directory is also exactly who sees your Zero Week Day-6 landing page. Download the summary and keep it where you'll see it.`,
          },
        ],
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// PREPARE
// ---------------------------------------------------------------------------

const fieldKit: SeedFlow = {
  slug: "founder-field-kit",
  title: "Founder Field Kit",
  tagline:
    "The six templates you'll actually use — each with a filled example, a blank, and the bad version that shows the common mistakes.",
  stage: "prepare",
  est: 30,
  sort: 10,
  steps: [
    {
      key: "intro",
      title: "Only what you'll use",
      kind: "content",
      body: `No 80-page workbook. Six templates, each in three versions:

1. a **filled-out example** (steal the level of specificity)
2. a **blank** (copy it into your notes app)
3. a **bad version** (the mistakes everyone makes)

They map directly to the cohort's first sprint — interviews, Lean Canvas, riskiest assumption — so filling them now is a genuine head start, not busywork.`,
    },
    {
      key: "interview-script",
      title: "1 · Problem Interview Script",
      kind: "content",
      body: `**Example (filled):**

> Intro: "Thanks — I'm researching how club treasurers handle dues. Not selling anything, just learning."
> 1. "Walk me through the last time you collected dues. What actually happened?"
> 2. "What's the most annoying part of that?"
> 3. "What have you tried to fix it? What did that cost you?"
> 4. "When it went wrong, what did it cost — money, time, drama?"
> 5. "Who else deals with this worse than you?"
> Close: "Can I follow up if I build something for this?"

**Blank:** intro line → last-time story → worst part → attempted fixes → cost of failure → referral ask → follow-up permission.

**Bad version (don't do this):**

> "Hi! I'm building an app that tracks club dues with AI. Would you use it? How much would you pay? Do you think it's a good idea?"

Every question pitches, leads, or asks for a prediction. You'd leave with three polite yeses and zero facts.

**How to use (5 minutes):** memorize the shape, not the words. One story ("walk me through the last time") is worth ten opinions. Ask, then be silent for five full seconds.`,
    },
    {
      key: "notes-sheet",
      title: "2 · Interview Notes Sheet",
      kind: "content",
      body: `**Example (filled):**

> Who: JV soccer team manager, 16, manages 22 players
> Current behavior: three group chats + a paper roster + Venmo screenshots
> Strongest quote: "I spend Sunday nights matching Venmo names to actual humans."
> Pain score (their words, not yours): "genuinely the worst part of the job"
> Already tried: a shared spreadsheet — died in two weeks, nobody updated it
> Surprise: the COACH is the one who nags her about it
> Follow-up permission: yes — text

**Blank:** who → current behavior → strongest quote → pain in their words → what they tried → what surprised you → follow-up permission.

**Bad version:** "Talked to Sarah. She liked the idea a lot!! Would definitely use it." — no behavior, no quote, no cost, and "liked the idea" is worthless.

**How to use:** fill it within 10 minutes of the conversation ending, while the quotes are exact. The quote field is the most valuable thing you'll collect all week.`,
    },
    {
      key: "lean-canvas",
      title: "3 · Lean Canvas Lite",
      kind: "content",
      body: `Six boxes, one page. (The full nine-box canvas arrives in the cohort — this is the pre-season version.)

**Example (filled):**

> **Problem:** club treasurers track dues across chats/Venmo/paper; money gets lost
> **Customer:** high school club + team treasurers (start: my school's 12 clubs)
> **Existing alternatives:** spreadsheets, group-chat pinning, shoebox of cash
> **Solution guess (smallest):** one shared list: who owes, who paid, auto-reminder texts
> **Unfair advantage:** I'm a treasurer; I know all 11 others by name
> **First metric:** 3 clubs using it weekly without me nagging

**Blank:** Problem / Customer / Existing alternatives / Smallest solution guess / Unfair advantage / First metric.

**Bad version:** Problem: "organization is hard." Customer: "students and eventually everyone." Solution: "an AI-powered all-in-one platform." — three garbage phrases and no test anywhere in sight.

**How to use:** pencil, 20 minutes, everything is a guess to be corrected by interviews. Redo it after every 3–5 conversations; version 3 will embarrass version 1. That's the point.`,
    },
    {
      key: "assumption-card",
      title: "4 · Riskiest Assumption Card",
      kind: "content",
      body: `**Example (filled):**

> **Assumption:** treasurers will actually send payment reminders through a new tool instead of just texting like always
> **If wrong:** the whole product is a fancy list nobody opens twice
> **Cheapest test:** run reminders manually for 2 clubs for 2 weeks (I send the texts from a template)
> **Evidence that kills it:** treasurers ignore the system and text people directly anyway
> **Deadline:** before kickoff

**Blank:** assumption → if wrong, then → cheapest test → kill evidence → deadline.

**Bad version:** "Assumption: the app might have bugs." — that's a task, not an assumption. The riskiest assumption is always about **human behavior**, almost never about whether you can build it.

**How to use:** one card at a time. If you have five risky assumptions, you have one riskiest — rank them by "if wrong, everything dies" and test that one first.`,
    },
    {
      key: "experiment-planner",
      title: "5 · Experiment Planner",
      kind: "content",
      body: `**Example (filled):**

> **Question:** will parents click a signup link from a coach's group-chat message?
> **Method:** coach posts my one-liner + link in two team chats (~50 parents)
> **Success line (set BEFORE running):** 10+ clicks, 5+ signups within 48h
> **Cost:** one favor, zero dollars, one evening
> **Result:** 19 clicks, 7 signups, 3 unprompted "when does this start?" replies
> **Verdict:** pass — channel works; next test the paid version

**Blank:** question → method → success line (decided in advance) → cost → result → verdict.

**Bad version:** running the test first and deciding afterwards whether the numbers are "pretty good." Without a pre-committed success line, every result feels like a pass — that's how zombie projects survive.

**How to use:** cheap and fast beats rigorous and slow. A 48-hour test you actually run beats a perfect one you plan forever.`,
    },
    {
      key: "decision-log",
      title: "6 · Decision Log (continue / pivot / kill)",
      kind: "content",
      body: `**Example (filled):**

> **Date:** July 12
> **Decision:** PIVOT — from "dues tracking app" to "reminder service"
> **Evidence:** 6/6 interviews: the list isn't the pain, the CHASING is. Manual reminder test got 7 signups.
> **What I'm giving up:** two weeks of list-UI code
> **Next checkpoint:** Aug 1 — if reminder usage < weekly, kill.

**Blank:** date → decision → the evidence behind it → what it costs → next checkpoint.

**Bad version:** no log at all — deciding by momentum. Whatever you were doing last week silently becomes the plan. The log exists to make drifting impossible.

**How to use:** write an entry every time something meaningful changes, and set the next checkpoint immediately. One honest paragraph beats a strategy doc.`,
    },
    {
      key: "outcome",
      title: "Kit issued",
      kind: "outcome",
      config: {
        blocks: [
          {
            body: `Six templates, three versions each. Two are worth filling **before kickoff**:

1. **Lean Canvas Lite** — your current best guesses, in pencil.
2. **Riskiest Assumption Card** — the one belief that kills everything if wrong.

Bring both to your first mentor conversation. The others earn their keep inside **The Zero Week Challenge** — notes sheet on Day 2, experiment planner on Days 5–6, decision log on Day 7.`,
          },
        ],
      },
    },
  ],
};

const toolbelt: SeedFlow = {
  slug: "founder-toolbelt",
  title: "Founder Toolbelt",
  tagline:
    "One default tool per job, one alternative, and when to use each. Tool overload is procrastination with better branding.",
  stage: "prepare",
  est: 10,
  sort: 20,
  steps: [
    {
      key: "intro",
      title: "The anti-directory",
      kind: "content",
      body: `This is deliberately not "100 AI tools for founders." For each job: a **default** (free or student-friendly), **one alternative**, and one sentence on when to switch. Pick your stack in five minutes and get back to talking to users.

Rule of thumb: if you've spent more than 30 minutes choosing a tool, the tool was never the bottleneck.`,
    },
    {
      key: "reach",
      title: "Reaching people",
      kind: "content",
      body: `**Interview scheduling** — default: **Calendly (free)**. Alternative: Cal.com. Switch if you want open-source or hit the one-event-type limit. Honestly, for your first ten interviews, "what time works?" in a DM is fine.

**Forms & surveys** — default: **Tally** (free, clean). Alternative: Google Forms. Use Google when respondents' answers need to land in a shared spreadsheet a teammate watches. Remember: surveys are weak evidence — interviews first.

**Email outreach** — default: **Gmail** with a personal, hand-written note. Alternative: a school email for credibility with adults. No mass-mail tools before 20 users — personalization IS the strategy at your scale.`,
    },
    {
      key: "build",
      title: "Building & shipping",
      kind: "content",
      body: `**Landing pages** — default: **Carrd** ($19/yr, an hour to live). Alternative: Framer or plain HTML on **Vercel** (free) if you already know your way around code. Switch when you need custom interactions or a real waitlist backend.

**Prototyping** — default: **Figma** (free for education). Alternative: paper + phone camera. Paper wins for testing an idea's flow in front of a person TODAY.

**No-code apps** — default: **Glide** (spreadsheet → app in an afternoon). Alternative: Bubble for real logic. Switch to Bubble only after a Glide version proved people want it.

**Payments** — default: **Stripe Payment Links** (no code, real money). Alternative: Venmo/cash + a spreadsheet for local, in-person tests. Under 18: you'll likely need a parent/guardian on the Stripe account — sort this before Demo Day, not during.`,
    },
    {
      key: "measure",
      title: "Measuring & pitching",
      kind: "content",
      body: `**Analytics** — default: **Vercel Analytics** or **Plausible** (simple, private). Alternative: Google Analytics if a partner insists. You need exactly two numbers pre-cohort: visitors and signups.

**Design assets** — default: **Canva** (free education tier). Alternative: Figma for anything you'll iterate with a teammate. Don't design a brand before you've validated a problem — a text-only landing page converts fine.

**Pitch decks** — default: **Google Slides** (collaboration beats polish). Alternative: Canva templates when you want it prettier fast. Ten slides max; the cohort's Pitch sprint will restructure it anyway.

**Email updates** — default: a plain Gmail thread to your first users. Alternative: Buttondown when the list passes ~50. Investors and users both prefer a scrappy, honest update over a designed newsletter.`,
    },
    {
      key: "outcome",
      title: "Stack picked",
      kind: "outcome",
      config: {
        blocks: [
          {
            body: `That's the whole toolbelt: scheduling, forms, outreach, landing page, prototype, no-code, payments, analytics, design, deck. Default + one alternative each.

**Now spend the time you saved:** put your Zero Week landing page live (Carrd or Vercel), wire the two numbers that matter (visits, signups), and go back to talking to humans. The tools were never the hard part.`,
          },
        ],
      },
    },
  ],
};

const parentPreflight: SeedFlow = {
  slug: "parent-preflight",
  title: "Parent Preflight Guide",
  tagline:
    "Ten minutes with a parent or guardian so nothing about batch0 is a surprise — dates, money, safety, and how to help without taking over.",
  stage: "prepare",
  est: 10,
  sort: 30,
  steps: [
    {
      key: "intro",
      title: "Read this together",
      kind: "content",
      body: `You're 13–18, which means a confused parent can quietly veto everything. Ten minutes now prevents that. Sit down with a parent or guardian and go through the next three pages together — then tick the acknowledgement list at the end.`,
    },
    {
      key: "logistics",
      title: "Dates, time, and money — the facts",
      kind: "content",
      body: `**Dates:** the current cohort runs **August 17 – October 18** (your exact dates and kickoff day are on the Kickoff page of this dashboard).

**Weekly commitment:** several hours a week — live sessions, weekly deliverables, mentor check-ins, and real-world work like customer interviews. It's a build program, not a lecture series.

**Tuition:** a **one-time $130**, charged **only after acceptance**. Applying is free. There are no other program fees.

**Equity: batch0 takes none.** Whatever a student builds is entirely theirs.

**Funding is not guaranteed.** Investors attend Demo Day and some teams receive interest or checks — but no outcome is promised, and the program's value doesn't depend on it.`,
    },
    {
      key: "safety",
      title: "Safety, privacy, and who your kid talks to",
      kind: "content",
      body: `**Who students interact with:** vetted mentors, program staff, other admitted students (also 13–18), and — around Demo Day — invited investors. Community spaces are moderated; there are no private unmonitored channels with unknown adults.

**Customer interviews:** the program teaches students to talk to potential users. Our safety rules: parents know who's being interviewed, public places for in-person conversations, logged channels (email/DMs) for remote ones, and no sharing of home address or personal financial details.

**Public-facing work:** students ship real things — landing pages, posts, a Demo Day pitch. Expect your kid's first name and project to appear publicly. Full contact details never should.

**Recording:** program sessions may be recorded for students who miss them. Recordings stay inside the program.

**Data:** we collect what the program needs (name, email, application, work product) and don't sell it.`,
    },
    {
      key: "support",
      title: "How to help without taking over",
      kind: "content",
      body: `The strongest predictor of a good cohort: a student who owns the work, with a parent who's interested but hands-off.

**Helps:**

- Ask "what did you learn from users this week?" instead of "did you win?"
- Be the safety net for interviews — within earshot for calls with unknown adults.
- Treat "I killed my idea because the evidence said no" as the win it is.
- Protect the weekly time commitment like it's a varsity sport.

**Hurts:**

- Doing the work — mentors can tell within one question.
- Insisting the idea be "realistic." Half the point is learning to test unrealistic things cheaply.
- Measuring success by funding. The durable outcome is the skill, not the check.`,
    },
    {
      key: "acknowledge",
      title: "The acknowledgement",
      kind: "checklist",
      body: `Tick these together — every box should be true before kickoff:`,
      config: {
        requireAll: true,
        items: [
          {
            key: "dates",
            label: "We know the cohort dates and the weekly time commitment",
          },
          {
            key: "money",
            label: "We understand tuition is one-time $130 after acceptance — no equity, no other fees",
          },
          {
            key: "funding",
            label: "We understand funding/investment is possible but not guaranteed",
          },
          {
            key: "safety-rules",
            label: "We've read the interview and online-safety rules",
          },
          {
            key: "public",
            label: "We're OK with first name + project appearing publicly",
          },
          {
            key: "contact",
            label: "A parent/guardian knows how to reach batch0 with questions",
          },
        ],
      },
    },
    {
      key: "outcome",
      title: "Preflight cleared",
      kind: "outcome",
      config: {
        blocks: [
          {
            body: `Every box ticked — your family knows exactly what this is. Download the summary and keep it with the family calendar.

One more thing for the parent reading this: on kickoff day the workload becomes real. The single best thing you can do that week is ask about **evidence** ("what did users say?") — it keeps the whole cohort's culture honest.`,
          },
        ],
      },
    },
  ],
};

const founderPreflight: SeedFlow = {
  slug: "founder-preflight",
  title: "Accepted Founder Preflight",
  tagline:
    "The technical and mental setup for kickoff — ending with the one submission your mentor reads before meeting you.",
  stage: "prepare",
  est: 20,
  sort: 40,
  steps: [
    {
      key: "intro",
      title: "You're in. Get flight-ready.",
      kind: "content",
      body: `Acceptance was the easy part. This preflight makes sure that on kickoff day you're building, not fixing your microphone.

It ends with a short **baseline submission** — the problem you're investigating, your evidence, and what you don't know yet. Your mentor reads it before your first conversation, so it's the highest-leverage ten minutes of your prep.`,
    },
    {
      key: "setup",
      title: "Technical setup",
      kind: "checklist",
      body: `Boring, and the #1 source of week-one chaos. Clear it now:`,
      config: {
        requireAll: true,
        items: [
          {
            key: "calendar",
            label: "Cohort dates blocked on your (and the family) calendar",
            hint: "Weekly sessions + deliverable time. Treat it like a varsity schedule.",
          },
          {
            key: "av",
            label: "Zoom installed; camera + microphone tested on a real call",
            hint: "Call a friend for 2 minutes. Headphones kill echo.",
          },
          {
            key: "space",
            label: "A quiet spot claimed for live sessions",
          },
          {
            key: "accounts",
            label: "Accounts ready: Google (docs/slides), Figma or Canva, a landing-page tool",
            hint: "The Founder Toolbelt flow has the defaults.",
          },
          {
            key: "notifs",
            label: "batch0 email + dashboard notifications actually reach you",
            hint: "Check spam once now, not during week one.",
          },
        ],
      },
    },
    {
      key: "profile",
      title: "Presence & community",
      kind: "checklist",
      config: {
        requireAll: false,
        items: [
          {
            key: "profile-done",
            label: "Dashboard profile complete — real name, how you want to be addressed",
          },
          {
            key: "intro-video",
            label: "One-minute intro recorded (phone camera is fine)",
            hint: "Who you are, what problem you're investigating, one non-startup fact.",
          },
          {
            key: "guidelines",
            label: "Community guidelines read",
            hint: "Short version: be direct, be kind, bring evidence.",
          },
          {
            key: "parent-ack",
            label: "Parent Preflight done together (if applicable)",
            hint: "It's the flow right before this one.",
          },
        ],
      },
    },
    {
      key: "constraints",
      title: "Scheduling constraints",
      kind: "input",
      body: `Mentors match around real life — tell us yours now, not after the schedule ships.`,
      config: {
        fields: [
          {
            key: "timezone",
            label: "Your timezone / city",
          },
          {
            key: "conflicts",
            label: "Standing conflicts (practice, work, family) — days and times",
            multiline: true,
          },
        ],
      },
    },
    {
      key: "baseline",
      title: "The baseline submission",
      kind: "input",
      body: `Three honest answers. "I don't have evidence yet" is a respectable answer; a bluff is not — mentors calibrate their help to what you actually have.`,
      config: {
        fields: [
          {
            key: "problem",
            label: "The problem I'm currently investigating",
            multiline: true,
          },
          {
            key: "evidence",
            label: "The evidence I have so far (interviews, numbers, workarounds seen)",
            multiline: true,
          },
          {
            key: "unknown",
            label: "What I still don't know",
            multiline: true,
          },
        ],
      },
    },
    {
      key: "outcome",
      title: "Preflight complete",
      kind: "outcome",
      config: {
        blocks: [
          {
            title: "Your baseline, on record",
            body: `**Problem:** {{baseline.problem}}

**Evidence:** {{baseline.evidence}}

**Still unknown:** {{baseline.unknown}}

This is saved — your mentor reads it as context before your first conversation. If the evidence line felt thin, you know exactly what to do with the days before kickoff: **Zero Week**, the **Talk to Strangers Pack**, and the **First 20 Users Directory** are all one click away.

See you at kickoff. Come with receipts.`,
          },
        ],
      },
    },
  ],
};

const FLOWS: SeedFlow[] = [
  startingLine,
  ideaGym,
  autopsyLibrary,
  problemBank,
  zeroWeek,
  talkToStrangers,
  oneSentence,
  first20,
  fieldKit,
  toolbelt,
  parentPreflight,
  founderPreflight,
];

// ---------------------------------------------------------------------------
// Validation — catch authoring mistakes BEFORE anything is written.
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE =
  /\{\{\s*([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+))?\s*\}\}/g;

function validateFlow(f: SeedFlow): void {
  const keys = new Set(f.steps.map((s) => s.key));
  if (keys.size !== f.steps.length) {
    throw new Error(`${f.slug}: duplicate step keys`);
  }
  for (const s of f.steps) {
    const c = s.config ?? {};
    const targets = [c.next, ...(c.options ?? []).map((o) => o.next)].filter(
      Boolean,
    ) as string[];
    for (const t of targets) {
      if (!keys.has(t)) {
        throw new Error(`${f.slug}/${s.key}: unknown branch target "${t}"`);
      }
    }
    if (s.kind === "choice" && !c.options?.length) {
      throw new Error(`${f.slug}/${s.key}: choice step with no options`);
    }
    if (s.kind === "input" && !c.fields?.length) {
      throw new Error(`${f.slug}/${s.key}: input step with no fields`);
    }
    if (s.kind === "checklist" && !c.items?.length) {
      throw new Error(`${f.slug}/${s.key}: checklist step with no items`);
    }
    for (const b of c.blocks ?? []) {
      if (b.when) {
        if (!keys.has(b.when.step)) {
          throw new Error(
            `${f.slug}/${s.key}: block condition references unknown step "${b.when.step}"`,
          );
        }
        const condStep = f.steps.find((st) => st.key === b.when!.step);
        const optionValues = new Set(
          (condStep?.config?.options ?? []).map((o) => o.value),
        );
        for (const v of b.when.in) {
          if (!optionValues.has(v)) {
            throw new Error(
              `${f.slug}/${s.key}: block condition value "${v}" not an option of "${b.when.step}"`,
            );
          }
        }
      }
      let m: RegExpExecArray | null;
      PLACEHOLDER_RE.lastIndex = 0;
      while ((m = PLACEHOLDER_RE.exec(b.body))) {
        const [, stepKey, fieldKey] = m;
        if (!keys.has(stepKey)) {
          throw new Error(
            `${f.slug}/${s.key}: placeholder {{${stepKey}}} references unknown step`,
          );
        }
        const target = f.steps.find((st) => st.key === stepKey);
        if (fieldKey && target?.kind === "input") {
          const fieldKeys = (target.config?.fields ?? []).map((fl) => fl.key);
          if (!fieldKeys.includes(fieldKey)) {
            throw new Error(
              `${f.slug}/${s.key}: placeholder {{${stepKey}.${fieldKey}}} references unknown field`,
            );
          }
        }
      }
    }
  }
  // Every flow must end somewhere: at least one outcome step.
  if (!f.steps.some((s) => s.kind === "outcome")) {
    throw new Error(`${f.slug}: no outcome step`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (run via npm run seed-flows so .env.local loads).",
  );
  process.exit(1);
}
const db = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const force = process.argv.includes("--force");

for (const f of FLOWS) validateFlow(f);
console.log(`Validated ${FLOWS.length} flows.`);

for (const f of FLOWS) {
  const { data: existing, error: exErr } = await db
    .from("flows")
    .select("id")
    .eq("slug", f.slug)
    .maybeSingle();
  if (exErr) throw new Error(`${f.slug}: ${exErr.message}`);

  if (existing && !force) {
    console.log(`= ${f.slug} — exists, skipped (use --force to overwrite)`);
    continue;
  }

  const meta = {
    slug: f.slug,
    title: f.title,
    tagline: f.tagline,
    stage: f.stage,
    status: "published",
    est_minutes: f.est,
    sort_order: f.sort,
    cohort_id: null,
    updated_at: new Date().toISOString(),
  };

  let id = existing?.id as string | undefined;
  if (id) {
    const { error } = await db.from("flows").update(meta).eq("id", id);
    if (error) throw new Error(`${f.slug}: ${error.message}`);
  } else {
    const { data: created, error } = await db
      .from("flows")
      .insert(meta)
      .select("id")
      .single();
    if (error) throw new Error(`${f.slug}: ${error.message}`);
    id = created!.id;
  }

  const { error: delErr } = await db
    .from("flow_steps")
    .delete()
    .eq("flow_id", id);
  if (delErr) throw new Error(`${f.slug}: ${delErr.message}`);

  const rows = f.steps.map((s, i) => ({
    flow_id: id!,
    step_key: s.key,
    title: s.title ?? null,
    kind: s.kind,
    body: s.body ?? null,
    config: s.config ?? {},
    sort_order: i,
  }));
  const { error: insErr } = await db.from("flow_steps").insert(rows);
  if (insErr) throw new Error(`${f.slug}: ${insErr.message}`);

  console.log(
    `${existing ? "~" : "+"} ${f.slug} (${rows.length} steps, ${f.stage})`,
  );
}

console.log("Done.");
