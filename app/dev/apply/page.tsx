import { notFound } from "next/navigation";
import { QUESTION_FIELDS } from "@/lib/application-fields";
import type { CustomQuestion } from "@/lib/question-schema";
import type { Application } from "@/lib/types";
import { ApplyFlow, type CohortOption } from "@/app/apply/apply-flow";

/**
 * Interface preview for /apply: the real question flow, against fixtures, with
 * no auth, no database and no server actions (ApplyFlow's `preview` mode) — so
 * the experience can be walked end to end without creating an account or
 * landing a test application in the review queue.
 *
 * Gated like app/dev/live: renders on localhost and branch previews, 404s on
 * production. See that page for why the gate is VERCEL_ENV, not NODE_ENV.
 *
 *   ?cohorts=1|2          one open cohort (no chooser) or two (chooser)
 *   ?mode=new|draft|reapply
 *   ?extras=1             add an admin question and the scholarship block
 */
export const metadata = {
  title: "Apply preview · batch0",
  robots: { index: false, follow: false },
};

const WINTER: CohortOption = {
  id: "winter",
  name: "Winter 2026",
  dates: "Dec 14, 2026 – Feb 12, 2027",
  weeks: 9,
  priceLabel: "$150.99",
  lateEntry: false,
  deadlineLabel: "Applications close Dec 12",
  catchUpPlan: null,
  capacity: 24,
};

const FALL: CohortOption = {
  id: "fall",
  name: "Fall 2026",
  dates: "Sep 14 – Nov 13, 2026",
  weeks: 9,
  priceLabel: "$130",
  lateEntry: true,
  deadlineLabel: "Late entry ends Sep 22",
  catchUpPlan:
    "Late entrants complete the Week 1 field guide and first customer-interview plan, then receive catch-up help from the team.",
  capacity: 24,
};

// Mirrors the live question config: Country and Experience made required, and
// Experience reworded by an admin.
const QUESTIONS = QUESTION_FIELDS.map((f) =>
  f.key === "country"
    ? { ...f, required: true }
    : f.key === "experience"
      ? {
          ...f,
          required: true,
          label: "Tell us a hurdle you faced and how you overcame it.",
          placeholder: "It can be for anything, not just STEM or business related.",
        }
      : { ...f },
);

const CUSTOM: CustomQuestion[] = [
  {
    id: "biggest_risk",
    type: "radio",
    label: "What's the biggest risk to your idea right now?",
    help: "",
    placeholder: "",
    required: true,
    hidden: false,
    options: [
      { value: "demand", label: "Nobody wants it" },
      { value: "build", label: "I can't build it yet" },
      { value: "reach", label: "I can't reach customers" },
    ],
  },
];

const SCHOLARSHIP: CustomQuestion[] = [
  {
    id: "cost_concern",
    type: "checkbox",
    label: "Would tuition be hard for your family to cover?",
    help: "",
    placeholder: "",
    required: false,
    hidden: false,
    options: [],
  },
];

const DRAFT = {
  full_name: "Ada Lovelace",
  age: 16,
  phone: "+1 (555) 123-4567",
  parent_email: "",
  why_join: "I want to build something real with people who take it seriously.",
} as unknown as Application;

export default async function ApplyPreviewPage(props: {
  searchParams: Promise<{ cohorts?: string; mode?: string; extras?: string }>;
}) {
  if (process.env.VERCEL_ENV === "production") notFound();
  const q = await props.searchParams;
  const cohorts = q.cohorts === "2" ? [FALL, WINTER] : [WINTER];
  const mode = q.mode === "draft" ? "draft" : q.mode === "reapply" ? "reapply" : "new";
  const extras = q.extras === "1";
  return (
    <ApplyFlow
      preview
      mode={mode}
      email="ada@example.com"
      defaults={mode === "draft" ? DRAFT : null}
      suggestedName="Ada Lovelace"
      questions={QUESTIONS}
      customQuestions={extras ? CUSTOM : []}
      scholarshipQuestions={extras ? SCHOLARSHIP : []}
      cohorts={cohorts}
      initialCohortId={cohorts.length > 1 ? null : cohorts[0].id}
      notices={
        mode === "reapply"
          ? [
              {
                tone: "neutral",
                title: "Starting a fresh application",
                body: "Your last application wasn't accepted. You can apply again, to a cohort you haven't been decided on.",
              },
            ]
          : []
      }
      blockedCohortNames={[]}
      parentGuideHref="/parents"
    />
  );
}
