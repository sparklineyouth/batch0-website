/**
 * Pure blast-addressing logic, shared by the page (which builds the list),
 * the form (which counts what a send will produce), and the action (which
 * actually sends).
 *
 * It lives in its own module for one reason: the recipient count on the
 * button and the addresses the server sends to have to come from the same
 * dedupe, or the button quietly lies. No imports — safe on both sides.
 */

/** Who a blast goes to: their own inbox, their parent's, or both. */
export type BlastAudience = "students" | "parents" | "both";

/** Which copy of the message — the two greet differently. */
export type BlastVariant = "student" | "parent";

/**
 * Application lifecycle rank, used to collapse someone's multiple
 * applications down to the furthest-along one.
 */
export const STATUS_RANK: Record<string, number> = {
  enrolled: 6,
  paid: 5,
  accepted: 4,
  waitlisted: 3,
  submitted: 2,
  rejected: 1,
  draft: 0,
};

export type ApplicationRow = {
  status: string;
  parent_email: string | null;
  created_at?: string | null;
};

/**
 * The parent address to use when someone has applied more than once.
 *
 * Takes it from their furthest-along application, most recent as the
 * tie-break — matching how the row's status is collapsed, so the list can't
 * show a status from one application and an address from another.
 */
export function pickParentEmail(applications: ApplicationRow[]): string | null {
  let best: { rank: number; at: string; email: string } | null = null;
  for (const a of applications ?? []) {
    const email = a.parent_email?.trim();
    if (!email) continue;
    const rank = STATUS_RANK[a.status] ?? -1;
    const at = a.created_at ?? "";
    if (!best || rank > best.rank || (rank === best.rank && at > best.at)) {
      best = { rank, at, email };
    }
  }
  return best?.email ?? null;
}

export function firstName(full: string | null | undefined): string {
  const first = (full ?? "").trim().split(/\s+/)[0];
  return first || "there";
}

/** "Alex" · "Alex and Sam" · "Alex, Sam, and Jo" */
export function joinNames(names: string[]): string {
  const list = Array.from(new Set(names.filter(Boolean)));
  if (list.length === 0) return "your student";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
}

/**
 * Fill the two tokens.
 *
 * `{{name}}` greets whoever opens the email. We know a student's name; the
 * application never asks for the parent's, so a parent gets a neutral
 * "there" rather than being addressed by their own child's name.
 *
 * `{{student}}` is always the student — that's what lets one message read
 * correctly to both audiences ("a quick update on {{student}}").
 */
export function personalize(
  text: string,
  greet: string,
  student: string,
): string {
  return text.split("{{name}}").join(greet).split("{{student}}").join(student);
}

export type BlastPerson = {
  email: string | null;
  full_name: string | null;
  parentEmail: string | null;
};

export type Envelope = {
  email: string;
  /** Fills {{name}}. */
  greet: string;
  /** Students this address is being written to about — fills {{student}}. */
  students: string[];
  kind: BlastVariant;
};

/**
 * Turn selected people into the addresses actually being mailed.
 *
 * Deduped by address, which is the whole point: siblings share one parent
 * address, and plenty of under-18s put a parent's address on their own
 * account. Without this, that parent gets the same email twice.
 *
 * When one address covers several students their names merge, so
 * {{student}} reads "Alex and Sam" instead of silently picking one. A
 * student's own address always beats a parent match on the same address, so
 * they're greeted by name rather than as an anonymous guardian.
 */
export function buildEnvelopes(
  people: BlastPerson[],
  audience: BlastAudience,
): Envelope[] {
  const byAddress = new Map<string, Envelope>();

  function add(email: string | null, kind: BlastVariant, student: string) {
    const clean = email?.trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    const existing = byAddress.get(key);
    if (!existing) {
      byAddress.set(key, {
        email: clean,
        greet: kind === "parent" ? "there" : student,
        students: [student],
        kind,
      });
      return;
    }
    if (!existing.students.includes(student)) existing.students.push(student);
    if (kind === "student" && existing.kind === "parent") {
      existing.kind = "student";
      existing.greet = student;
    }
  }

  for (const p of people) {
    const student = firstName(p.full_name);
    if (audience !== "parents") add(p.email, "student", student);
    if (audience !== "students") add(p.parentEmail, "parent", student);
  }
  return Array.from(byAddress.values());
}
