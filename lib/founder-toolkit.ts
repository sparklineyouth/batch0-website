// The Founder Toolkit (perk 6): real, batch0-voiced startup templates a pass
// holder can use whether or not they get into the cohort. Content lives in code
// (like the rest of the marketing copy) rather than as uploaded files, so it's
// version-controlled, searchable, and can't rot into a dead download link.
//
// Each template renders as sections of short prompts/checklists — the kind of
// thing you copy into your own doc and fill in. Kept deliberately lean: a
// worksheet you'll actually finish beats an ebook you won't. The toolkit page
// (app/pass/toolkit) is gated to pass holders; this module is just the data.

export type ToolkitSection = {
  heading: string;
  /** Short prompts or checklist items. Rendered as a bulleted list. */
  items: string[];
};

export type ToolkitTemplate = {
  slug: string;
  title: string;
  /** One line: what it's for and when to use it. */
  purpose: string;
  sections: ToolkitSection[];
};

export const FOUNDER_TOOLKIT: ToolkitTemplate[] = [
  {
    slug: "problem-validation",
    title: "Problem-validation worksheet",
    purpose:
      "Before you build anything, prove the problem is real, frequent, and painful for a specific person.",
    sections: [
      {
        heading: "The problem in one sentence",
        items: [
          "Who has it? (Be specific — “high schoolers” is not a person; “juniors applying to competitive CS programs” is.)",
          "What are they trying to get done when the problem shows up?",
          "What do they do today instead, however badly?",
        ],
      },
      {
        heading: "Is it worth solving?",
        items: [
          "How often does the problem occur — daily, weekly, once a year?",
          "What does it cost them right now (time, money, stress, missed outcome)?",
          "On a scale of 1–10, how much do they care? If it's under 7, keep looking.",
        ],
      },
      {
        heading: "Evidence, not opinions",
        items: [
          "Name 5 real people who have this problem. Can you reach them this week?",
          "What have you observed them do (not say) that proves the pain?",
          "What would have to be true for this to NOT be worth building? Go check that first.",
        ],
      },
    ],
  },
  {
    slug: "customer-interview",
    title: "Customer-interview script",
    purpose:
      "Learn the truth from 5–10 potential users without leading them or pitching your idea.",
    sections: [
      {
        heading: "Ground rules",
        items: [
          "Ask about their life and past behavior, not your idea. Never say “would you use…”.",
          "Aim for stories: “Tell me about the last time you…”.",
          "Talk 20% of the time. Silence is your friend — let them fill it.",
        ],
      },
      {
        heading: "Opening",
        items: [
          "“Walk me through how you currently handle [the job to be done].”",
          "“When did you last run into a problem with that? What happened?”",
          "“What did you do next? Did you look for another way?”",
        ],
      },
      {
        heading: "Digging in",
        items: [
          "“What was the hardest part about that?”",
          "“Have you tried to fix it? What did that cost you (time/money)?”",
          "“If a magic wand fixed one thing here, what would it be?”",
        ],
      },
      {
        heading: "After every interview",
        items: [
          "Write down surprising quotes verbatim within 10 minutes.",
          "Note: did they have the problem you expected — or a different, sharper one?",
          "Ask: “Who else should I talk to?” — this is how you get to 10.",
        ],
      },
    ],
  },
  {
    slug: "lean-canvas",
    title: "Lean Canvas",
    purpose:
      "Your whole business on one page. Fill it in fast, in pencil — it's a hypothesis, not a plan.",
    sections: [
      {
        heading: "The nine boxes",
        items: [
          "Problem: top 3 problems your customer has.",
          "Customer segments: who exactly, and who are the early adopters.",
          "Unique value proposition: one clear, compelling sentence.",
          "Solution: the smallest thing that addresses each problem.",
          "Channels: how you'll reach customers.",
          "Revenue streams: how you make money.",
          "Cost structure: what it costs to operate.",
          "Key metrics: the one number that tells you it's working.",
          "Unfair advantage: what can't be easily copied or bought.",
        ],
      },
      {
        heading: "How to use it",
        items: [
          "Do it in 20 minutes. Perfect is the enemy here.",
          "Circle the riskiest box — that's what you go validate next.",
          "Redo it every time you learn something. Date each version.",
        ],
      },
    ],
  },
  {
    slug: "mvp-plan",
    title: "MVP planning tool",
    purpose:
      "Scope the smallest thing that lets a real user get real value — and cut everything else.",
    sections: [
      {
        heading: "Define the core",
        items: [
          "What is the ONE thing a user must be able to do for this to be useful?",
          "Who is the first user, by name, and what will they do with it?",
          "What does success look like in week one — a number, not a vibe?",
        ],
      },
      {
        heading: "Cut ruthlessly",
        items: [
          "List every feature you imagined. Now cross out everything that isn't the core.",
          "Can it be a spreadsheet, a form, or a manual “Wizard of Oz” before it's code?",
          "What's the fastest version you could put in front of a user this week?",
        ],
      },
      {
        heading: "Build → measure → learn",
        items: [
          "What will you watch to know if it worked (activation, repeat use, referral)?",
          "What would make you kill or pivot this? Decide now, while you're honest.",
          "Ship it to 1 real user before you build the second feature.",
        ],
      },
    ],
  },
  {
    slug: "landing-page",
    title: "Landing-page template",
    purpose:
      "A one-page site that explains the value and captures interest — buildable in an afternoon.",
    sections: [
      {
        heading: "Above the fold",
        items: [
          "Headline: the outcome you deliver, in the customer's words (not your feature).",
          "Subhead: one sentence on who it's for and how it works.",
          "One clear call to action (join the waitlist / try it / book a call).",
        ],
      },
      {
        heading: "The body",
        items: [
          "The problem, stated so the visitor thinks “that's me”.",
          "3 benefits (not features) with a concrete example each.",
          "Proof: a quote, a number, a logo, or a short demo/GIF.",
        ],
      },
      {
        heading: "Before you ship",
        items: [
          "Add an email capture — even a Tally/Google form counts.",
          "Instrument it: how many visitors, how many sign up? (That's your first metric.)",
          "Send it to 10 people in your target segment and watch what they do.",
        ],
      },
    ],
  },
  {
    slug: "go-to-market",
    title: "Go-to-market worksheet",
    purpose:
      "Pick the one channel you'll get good at to reach your first 100 users.",
    sections: [
      {
        heading: "Who and where",
        items: [
          "Where does your early adopter already hang out (subreddit, Discord, class, club)?",
          "What are they searching for, and what would make them click?",
          "Who is a person or group that could reach 100 of them at once?",
        ],
      },
      {
        heading: "Pick one channel",
        items: [
          "List 3 plausible channels (e.g. cold outreach, a community, content, partnerships).",
          "Score each: can you reach 100 people this month, cheaply, repeatably?",
          "Commit to ONE for 4 weeks. Two half-efforts beat nothing, but one full effort beats both.",
        ],
      },
      {
        heading: "First 10 → first 100",
        items: [
          "Write the exact message/DM you'll send. Make it about them, not you.",
          "Set a weekly target (e.g. 25 conversations). Track replies and conversions.",
          "Double down on whatever gets a response; cut whatever doesn't after 2 weeks.",
        ],
      },
    ],
  },
  {
    slug: "pitch-deck",
    title: "Pitch-deck template",
    purpose:
      "10 slides that tell a clear story for demo day or a first investor conversation.",
    sections: [
      {
        heading: "The 10 slides",
        items: [
          "1. Title: company, one-line description, your name.",
          "2. Problem: who hurts, and how much.",
          "3. Solution: what you built, shown not told.",
          "4. Demo: the product doing the one important thing.",
          "5. Market: who's the customer and how many are there.",
          "6. Traction: users, usage, revenue, or learning — real numbers.",
          "7. Business model: how you make money.",
          "8. Go-to-market: how you reach customers.",
          "9. Team: why you, why now.",
          "10. Ask: what you want (feedback, users, funding) and next milestone.",
        ],
      },
      {
        heading: "Delivery",
        items: [
          "One idea per slide. If you're reading it, it's too wordy.",
          "Lead with the demo if it's strong — show, then explain.",
          "Rehearse to 3 minutes. Then cut it to 2.",
        ],
      },
    ],
  },
  {
    slug: "seven-day-launch",
    title: "Seven-day launch plan",
    purpose:
      "A day-by-day sprint from “an idea” to “a real thing in front of real users”.",
    sections: [
      {
        heading: "Days 1–2 — Validate",
        items: [
          "Day 1: Write the problem in one sentence. Line up 5 people to talk to.",
          "Day 2: Run 5 interviews. Rewrite the problem based on what you heard.",
        ],
      },
      {
        heading: "Days 3–5 — Build",
        items: [
          "Day 3: Scope the MVP to one core action. Cut everything else.",
          "Day 4: Build the smallest working version (or the manual Wizard-of-Oz version).",
          "Day 5: Put it in front of 1 real user. Fix what breaks.",
        ],
      },
      {
        heading: "Days 6–7 — Launch & learn",
        items: [
          "Day 6: Ship a landing page + get it to 10 people in your segment.",
          "Day 7: Look at the numbers. Write down what you learned and what's next.",
        ],
      },
    ],
  },
];
