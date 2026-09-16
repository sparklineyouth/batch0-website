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
    awardType: "discount",
    awardDollars: "",
    awardPercent: "",
    mentorCalls: "3",
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
    awardType: string;
    amountCents: number;
    percent: number | null;
    mentorCalls: number;
  };
  seats: number | null;
  opensAt: string | null;
  closesAt: string | null;
  eligibleStages: string[];
  enabled: boolean;
  sortIndex: number;
}): ScholarshipFormValues {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    kind: s.kind,
    tagline: s.tagline ?? "",
    description: s.description ?? "",
    awardType: s.terms.awardType,
    awardDollars: s.terms.amountCents ? String(s.terms.amountCents / 100) : "",
    awardPercent: s.terms.percent === null ? "" : String(s.terms.percent),
    mentorCalls: String(s.terms.mentorCalls || 3),
    seats: s.seats === null ? "" : String(s.seats),
    opensAt: toLocalInput(s.opensAt),
    closesAt: toLocalInput(s.closesAt),
    eligibleStages: s.eligibleStages,
    enabled: s.enabled,
    sortIndex: String(s.sortIndex),
  };
}
