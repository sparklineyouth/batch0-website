// Client-safe founder-pass constants. Kept in their OWN module — with zero
// imports — so a client component (app/pass/feedback-credit.tsx) can use the
// topic list without dragging lib/founder-pass-perks.ts, and through it
// lib/founder-pass-code.ts's node:crypto, into the browser bundle. Same carve-
// out the ticket makes by taking a preformatted serial. lib/founder-pass-perks
// re-exports these so server code has a single import site.

export const FEEDBACK_TOPICS = [
  { value: "application", label: "Your application" },
  { value: "idea", label: "Startup idea" },
  { value: "interview_plan", label: "Customer-interview plan" },
  { value: "landing_page", label: "Landing page" },
  { value: "mvp", label: "MVP" },
  { value: "pitch_deck", label: "Pitch deck" },
] as const;

export type FeedbackTopic = (typeof FEEDBACK_TOPICS)[number]["value"];

export function feedbackTopicLabel(topic: string): string {
  return FEEDBACK_TOPICS.find((t) => t.value === topic)?.label ?? topic;
}
