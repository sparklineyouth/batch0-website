import type { Challenge, ChallengeQuestion } from "@/lib/challenges-shared";

// Plain (non-"use client") module so the mapper can be CALLED from the server
// edit page. A function exported from a "use client" module becomes a client
// reference across the RSC boundary and throws "is not a function" when a
// Server Component calls it — only components may cross that boundary.

export type ChallengeEditorInitial = {
  id: string;
  slug: string;
  title: string;
  description: string;
  prizeLabel: string;
  prizeAmountCents: number | null;
  marqueeText: string;
  ctaLabel: string;
  ctaHref: string | null;
  opensAt: string | null;
  closesAt: string | null;
  winnersPublished: boolean;
  questions: ChallengeQuestion[];
};

export function challengeToInitial(c: Challenge): ChallengeEditorInitial {
  return {
    id: c.id,
    slug: c.slug,
    title: c.title,
    description: c.description,
    prizeLabel: c.prizeLabel,
    prizeAmountCents: c.prizeAmountCents,
    marqueeText: c.marqueeText,
    ctaLabel: c.ctaLabel,
    ctaHref: c.ctaHref,
    opensAt: c.opensAt,
    closesAt: c.closesAt,
    winnersPublished: c.winnersPublished,
    questions: c.questions.map((q) => ({ ...q, options: [...q.options] })),
  };
}
