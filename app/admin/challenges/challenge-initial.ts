import type { Challenge } from "@/lib/challenges-shared";

// Plain (non-"use client") module so the mapper can be CALLED from the server
// edit page. A function exported from a "use client" module becomes a client
// reference across the RSC boundary and throws "is not a function" when a
// Server Component calls it — only components may cross that boundary.

export type ChallengeEditorInitial = Omit<Challenge, "createdAt" | "updatedAt">;

export function challengeToInitial(c: Challenge): ChallengeEditorInitial {
  // Structured clone keeps nested arrays (questions, prizes…) from sharing
  // references with anything the server rendered.
  const { createdAt: _c, updatedAt: _u, ...rest } = c;
  return JSON.parse(JSON.stringify(rest));
}
