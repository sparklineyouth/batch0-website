// ---------------------------------------------------------------------------
// Build receipts — the proof-of-work feed. Shared kind labels + the badge
// rules derived from a student's own receipts. Credibility for evidence,
// not likes: badges come from what you did, and "Killed a Bad Idea" is
// deliberately one of them.
// ---------------------------------------------------------------------------

export type ReceiptKind =
  | "interview"
  | "landing_page"
  | "users"
  | "experiment"
  | "pivot"
  | "kill"
  | "ship"
  | "other";

export const RECEIPT_KINDS: {
  value: ReceiptKind;
  label: string;
  prompt: string;
}[] = [
  {
    value: "interview",
    label: "Interview done",
    prompt: "Who did you talk to and what surprised you?",
  },
  {
    value: "landing_page",
    label: "Landing page live",
    prompt: "Link it. What are you measuring?",
  },
  {
    value: "users",
    label: "User update",
    prompt: "How many real users, and what are they doing?",
  },
  {
    value: "experiment",
    label: "Experiment result",
    prompt: "What did you test, and what happened — including failures?",
  },
  {
    value: "pivot",
    label: "Pivoted",
    prompt: "What evidence changed your direction?",
  },
  {
    value: "kill",
    label: "Killed an idea",
    prompt: "What did the evidence say? Killing a bad idea is a win.",
  },
  {
    value: "ship",
    label: "Shipped something",
    prompt: "What went out the door before it felt ready?",
  },
  {
    value: "other",
    label: "Other proof",
    prompt: "Any other evidence of real work.",
  },
];

export function receiptKindLabel(kind: string): string {
  return RECEIPT_KINDS.find((k) => k.value === kind)?.label ?? "Proof";
}

export type ReceiptBadge = { id: string; label: string; hint: string };

/** Badges earned from a per-kind count of the student's own receipts. */
export function earnedBadges(
  counts: Partial<Record<ReceiptKind, number>>,
): ReceiptBadge[] {
  const n = (k: ReceiptKind) => counts[k] ?? 0;
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  const badges: ReceiptBadge[] = [];
  if (n("interview") >= 1)
    badges.push({
      id: "first-stranger",
      label: "First Stranger Interview",
      hint: "Talked to someone who isn't a friend being polite.",
    });
  if (n("landing_page") + n("ship") >= 1)
    badges.push({
      id: "shipped",
      label: "Shipped Before Ready",
      hint: "Put something real in front of the world.",
    });
  if (n("users") >= 1)
    badges.push({
      id: "first-user",
      label: "First User",
      hint: "Someone actually used the thing.",
    });
  if (n("experiment") >= 1)
    badges.push({
      id: "experimenter",
      label: "Ran a Real Experiment",
      hint: "Tested an assumption instead of arguing about it.",
    });
  if (n("pivot") >= 1)
    badges.push({
      id: "first-pivot",
      label: "First Pivot",
      hint: "Followed the evidence somewhere new.",
    });
  if (n("kill") >= 1)
    badges.push({
      id: "idea-killer",
      label: "Killed a Bad Idea",
      hint: "The most respected badge here. Evidence said no; you listened.",
    });
  if (total >= 5)
    badges.push({
      id: "evidence-machine",
      label: "Evidence Machine",
      hint: "Five or more receipts posted.",
    });
  return badges;
}
