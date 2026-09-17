import type { ScholarshipInput } from "./actions";

/**
 * The scholarship form's value shape and the two pure functions that seed it.
 *
 * These live here rather than beside the form because both seeds are called
 * from Server Components — `emptyScholarshipForm()` by the new-scholarship
 * page, `scholarshipToForm()` by the edit page — and every export of a
 * `"use client"` module is a client *reference*, not the function itself.
 * Calling one on the server throws "Attempted to call X() from the server but X
 * is on the client" at request time, which neither `tsc` nor `next build`
 * catches: the admin page 500s in production and nowhere else.
 *
 * So the rule this file exists to enforce: a helper a server page needs to
 * *call* cannot be exported from a client module, only imported by one.
 */
export type ScholarshipFormValues = ScholarshipInput;

/** An ISO timestamp as a <input type="datetime-local"> value, in local time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function emptyScholarshipForm(): ScholarshipFormValues {
  return {
    id: null,
    slug: "",
    name: "",
    kind: "need",
    tagline: "",
    description: "",
    // Money on by default — it's what most scholarships are — with every perk
    // off. The "how many" boxes carry a sensible number so ticking a perk
    // never lands on an empty box the save then refuses.
    money: true,
    awardDollars: "",
    awardPercent: "",
    mentorCallsOn: false,
    mentorCalls: "3",
    feedbackCreditsOn: false,
    feedbackCredits: "1",
    demoDayTicketsOn: false,
    demoDayTickets: "2",
    aiBoost: false,
    seats: "",
    opensAt: "",
    closesAt: "",
    eligibleStages: ["accepted", "enrolled"],
    enabled: true,
    sortIndex: "100",
  };
}

export function scholarshipToForm(s: {
  id: string;
  slug: string;
  name: string;
  kind: string;
  tagline: string | null;
  description: string | null;
  terms: {
    amountCents: number;
    percent: number | null;
    perks: {
      mentorCalls: number;
      feedbackCredits: number;
      demoDayTickets: number;
      aiBoost: boolean;
    };
  };
  seats: number | null;
  opensAt: string | null;
  closesAt: string | null;
  eligibleStages: string[];
  enabled: boolean;
  sortIndex: number;
}): ScholarshipFormValues {
  const money = s.terms.percent !== null || s.terms.amountCents > 0;
  const { perks } = s.terms;
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    kind: s.kind,
    tagline: s.tagline ?? "",
    description: s.description ?? "",
    money,
    awardDollars: s.terms.amountCents ? String(s.terms.amountCents / 100) : "",
    awardPercent: s.terms.percent === null ? "" : String(s.terms.percent),
    // A perk reads as ticked when the row carries it; an unticked box keeps
    // the same default number the empty form would, so ticking it later
    // starts somewhere sensible.
    mentorCallsOn: perks.mentorCalls > 0,
    mentorCalls: String(perks.mentorCalls || 3),
    feedbackCreditsOn: perks.feedbackCredits > 0,
    feedbackCredits: String(perks.feedbackCredits || 1),
    demoDayTicketsOn: perks.demoDayTickets > 0,
    demoDayTickets: String(perks.demoDayTickets || 2),
    aiBoost: perks.aiBoost,
    seats: s.seats === null ? "" : String(s.seats),
    opensAt: toLocalInput(s.opensAt),
    closesAt: toLocalInput(s.closesAt),
    eligibleStages: s.eligibleStages,
    enabled: s.enabled,
    sortIndex: String(s.sortIndex),
  };
}
