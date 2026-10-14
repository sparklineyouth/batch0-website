/**
 * Notification importance — which /notifications tab a row lands in.
 *
 * Every notification type has a default classification here, and a person can
 * override any of them (public.notification_importance, migration 0091). The
 * split is deliberately coarse: "important" means a human probably has to do
 * something or would be upset to miss it; everything else is the receipts,
 * recaps and queue chatter that make an inbox unreadable when it's all one
 * list.
 *
 * Shared by the page (classifying rows) and the settings panel (listing the
 * types you can reclassify), so the two can't drift apart.
 */

export type Importance = "important" | "other";

export type NotificationKind = {
  type: string;
  label: string;
  /** Shown under the label in the settings panel. Keep it to one clause. */
  hint?: string;
  group: string;
  default: Importance;
};

/**
 * Group order is the order they render in the settings panel. Roughly
 * "things about you" → "things about other people's work".
 */
export const IMPORTANCE_GROUPS = [
  "Your place in the program",
  "Scholarships",
  "Money",
  "Schedule & calls",
  "Check-ins & feedback",
  "Challenges",
  "Your team",
  "Conversations",
  "Support",
  "Staff queues",
] as const;

/**
 * Unknown types — a notification shipped by a feature newer than this list —
 * classify as important. A new notification type being loud by accident is a
 * nuisance; one being silent by accident loses information.
 */
export const DEFAULT_FOR_UNKNOWN: Importance = "important";

export const NOTIFICATION_KINDS: NotificationKind[] = [
  // ── Your place in the program ──────────────────────────────────────────
  {
    type: "application_accepted",
    label: "Application accepted",
    group: "Your place in the program",
    default: "important",
  },
  {
    type: "application_rejected",
    label: "Application decision — not accepted",
    group: "Your place in the program",
    default: "important",
  },
  {
    type: "application_waitlisted",
    label: "Waitlisted",
    group: "Your place in the program",
    default: "important",
  },
  {
    type: "application_submitted",
    label: "Your application was received",
    hint: "A receipt for something you just did.",
    group: "Your place in the program",
    default: "other",
  },
  {
    type: "application_fee_waived",
    label: "Application fee waived",
    group: "Your place in the program",
    default: "important",
  },
  {
    type: "enrolled",
    label: "Enrolled in a cohort",
    group: "Your place in the program",
    default: "important",
  },
  {
    type: "moved_to_cohort",
    label: "Moved to another cohort",
    group: "Your place in the program",
    default: "important",
  },
  {
    type: "removed_from_program",
    label: "Removed from the program",
    group: "Your place in the program",
    default: "important",
  },
  {
    type: "certificate_issued",
    label: "Certificate issued",
    group: "Your place in the program",
    default: "important",
  },
  {
    type: "welcome",
    label: "Welcome message",
    hint: "Sent once, when your account is created.",
    group: "Your place in the program",
    default: "other",
  },

  // ── Scholarships ──────────────────────────────────────────────────────
  {
    type: "scholarship_invite",
    label: "A scholarship you should look at",
    group: "Scholarships",
    default: "important",
  },
  {
    type: "scholarship_awarded",
    label: "Scholarship awarded",
    group: "Scholarships",
    default: "important",
  },
  {
    type: "scholarship_declined",
    label: "Scholarship decision — not awarded",
    group: "Scholarships",
    default: "important",
  },
  {
    type: "scholarship_submitted",
    label: "Your scholarship application was received",
    hint: "A receipt for something you just did.",
    group: "Scholarships",
    default: "other",
  },

  // ── Money ─────────────────────────────────────────────────────────────
  {
    type: "payment_failed",
    label: "Payment failed",
    group: "Money",
    default: "important",
  },
  {
    type: "payment_refunded",
    label: "Payment refunded",
    group: "Money",
    default: "important",
  },
  {
    type: "fee_issued",
    label: "Fee added to your account",
    group: "Money",
    default: "important",
  },
  {
    type: "fine_issued",
    label: "Fine added to your account",
    group: "Money",
    default: "important",
  },
  {
    type: "charge_waived",
    label: "Fee or fine waived",
    group: "Money",
    default: "important",
  },
  {
    type: "charge_refunded",
    label: "Fee or fine refunded",
    group: "Money",
    default: "important",
  },
  {
    type: "charge_paid",
    label: "Fee or fine paid",
    hint: "A receipt for a payment you just made.",
    group: "Money",
    default: "other",
  },
  {
    type: "scholarship_refunded",
    label: "Scholarship payment refunded",
    group: "Money",
    default: "important",
  },
  {
    type: "payment_succeeded",
    label: "Payment went through",
    hint: "A receipt for a payment you just made.",
    group: "Money",
    default: "other",
  },
  {
    type: "demo_day_ticket_paid",
    label: "Demo Day ticket paid",
    group: "Money",
    default: "other",
  },
  {
    type: "demo_day_ticket_sent",
    label: "Demo Day ticket sent to you",
    group: "Money",
    default: "other",
  },
  {
    type: "demo_day_ticket_refunded",
    label: "Demo Day ticket refunded",
    group: "Money",
    default: "important",
  },

  // ── Schedule & calls ──────────────────────────────────────────────────
  {
    type: "announcement",
    label: "Announcements",
    hint: "Posted by the team to a whole cohort.",
    group: "Schedule & calls",
    default: "important",
  },
  {
    type: "event_posted",
    label: "New event on the calendar",
    group: "Schedule & calls",
    default: "other",
  },
  {
    type: "event_live",
    label: "A webinar started now",
    group: "Schedule & calls",
    default: "important",
  },
  {
    type: "call_invited",
    label: "You're invited to a call",
    group: "Schedule & calls",
    default: "important",
  },
  {
    type: "call_cancelled",
    label: "A call was cancelled",
    group: "Schedule & calls",
    default: "important",
  },
  {
    type: "call_response",
    label: "Someone answered a call invite",
    group: "Schedule & calls",
    default: "other",
  },
  {
    type: "interview_requested",
    label: "Interview requested",
    group: "Schedule & calls",
    default: "important",
  },
  {
    type: "interview_declined",
    label: "Interview declined",
    group: "Schedule & calls",
    default: "important",
  },
  {
    type: "office_hours_booked",
    label: "Office hours booked",
    group: "Schedule & calls",
    default: "important",
  },
  {
    type: "office_hours_recap",
    label: "Office hours recap",
    group: "Schedule & calls",
    default: "other",
  },
  {
    type: "founder_pass_feedback_scheduled",
    label: "Founder pass feedback scheduled",
    group: "Schedule & calls",
    default: "other",
  },
  {
    type: "founder_pass_feedback_ready",
    label: "Founder pass feedback ready",
    group: "Schedule & calls",
    default: "important",
  },

  // ── Check-ins & feedback ──────────────────────────────────────────────
  {
    type: "checkin_nudge",
    label: "Reminder to check in",
    group: "Check-ins & feedback",
    default: "important",
  },
  {
    type: "intervention",
    label: "A student you mentor needs a nudge",
    hint: "Raised when someone misses two check-ins in a row.",
    group: "Check-ins & feedback",
    default: "important",
  },
  {
    type: "checkin_feedback",
    label: "Feedback on your check-in",
    group: "Check-ins & feedback",
    default: "other",
  },
  {
    type: "file_feedback",
    label: "Feedback on a file you uploaded",
    group: "Check-ins & feedback",
    default: "other",
  },
  {
    type: "checkin_submitted",
    label: "A student submitted a check-in",
    group: "Check-ins & feedback",
    default: "other",
  },

  // ── Challenges ────────────────────────────────────────────────────────
  {
    type: "challenge_registered",
    label: "You're registered for a challenge",
    group: "Challenges",
    default: "other",
  },
  {
    type: "challenge_submitted",
    label: "Your challenge submission was received",
    group: "Challenges",
    default: "other",
  },

  // ── Your team ─────────────────────────────────────────────────────────
  {
    type: "team_invite",
    label: "Invited to a team",
    group: "Your team",
    default: "important",
  },
  {
    type: "team_invite_response",
    label: "Someone answered your team invite",
    group: "Your team",
    default: "other",
  },
  {
    type: "team_message",
    label: "Message in your team",
    group: "Your team",
    default: "other",
  },
  {
    type: "team_logo_rejected",
    label: "Team logo rejected",
    group: "Your team",
    default: "important",
  },
  {
    type: "team_logo_approved",
    label: "Team logo approved",
    group: "Your team",
    default: "other",
  },
  {
    type: "team_logo_pending",
    label: "Team logo waiting on review",
    group: "Your team",
    default: "other",
  },
  {
    type: "pitch_submitted",
    label: "A team submitted a pitch",
    group: "Your team",
    default: "other",
  },

  // ── Conversations ─────────────────────────────────────────────────────
  {
    type: "direct_message",
    label: "Direct messages",
    group: "Conversations",
    default: "important",
  },
  {
    type: "discussion_question",
    label: "A question for the team",
    group: "Conversations",
    default: "other",
  },
  {
    type: "discussion_reply",
    label: "Reply in a discussion",
    group: "Conversations",
    default: "other",
  },
  {
    type: "intro_request",
    label: "Intro requested",
    group: "Conversations",
    default: "important",
  },
  {
    type: "intro_status_update",
    label: "Intro request update",
    group: "Conversations",
    default: "other",
  },

  // ── Support ───────────────────────────────────────────────────────────
  // Low volume, and somebody is waiting at the other end of every one of
  // these, which is why the team-facing ones default to important where the
  // other queues don't.
  {
    type: "support_staff_reply",
    label: "The team replied to your request",
    group: "Support",
    default: "important",
  },
  {
    type: "support_resolved",
    label: "Your request was resolved",
    group: "Support",
    default: "other",
  },
  {
    type: "support_ticket",
    label: "New support request",
    group: "Support",
    default: "important",
  },
  {
    type: "support_assigned",
    label: "A support request was assigned to you",
    group: "Support",
    default: "important",
  },
  {
    type: "support_reply",
    label: "Follow-up on a support request",
    group: "Support",
    default: "other",
  },

  // ── Staff queues ──────────────────────────────────────────────────────
  {
    type: "admin_new_application",
    label: "New application to review",
    group: "Staff queues",
    default: "other",
  },
  {
    type: "admin_new_challenge_submission",
    label: "New challenge submission to review",
    group: "Staff queues",
    default: "other",
  },
  {
    type: "scholarship_call_requested",
    label: "Someone booked a scholarship call",
    group: "Staff queues",
    default: "other",
  },
  {
    type: "dm_reported",
    label: "A conversation was reported",
    hint: "Opens a private DM to moderators — worth seeing promptly.",
    group: "Staff queues",
    default: "important",
  },
  {
    type: "discord_blocker",
    label: "Blocker posted in Discord",
    group: "Staff queues",
    default: "other",
  },
];

const BY_TYPE = new Map(NOTIFICATION_KINDS.map((k) => [k.type, k]));

export function kindFor(type: string): NotificationKind | undefined {
  return BY_TYPE.get(type);
}

/** "office_hours_recap" → "Office hours recap", for types not in the list. */
export function labelForType(type: string): string {
  const known = BY_TYPE.get(type);
  if (known) return known.label;
  const words = type.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function defaultImportance(type: string): Importance {
  return BY_TYPE.get(type)?.default ?? DEFAULT_FOR_UNKNOWN;
}

/** A person's overrides, keyed by type. Anything absent uses the default. */
export type ImportanceOverrides = Record<string, Importance>;

export function importanceOf(
  type: string,
  overrides: ImportanceOverrides,
): Importance {
  return overrides[type] ?? defaultImportance(type);
}

export function isImportant(
  type: string,
  overrides: ImportanceOverrides,
): boolean {
  return importanceOf(type, overrides) === "important";
}

/**
 * Split a list of notifications into the two tabs in one pass, preserving
 * order within each.
 */
export function splitByImportance<T extends { type: string }>(
  rows: T[],
  overrides: ImportanceOverrides,
): { important: T[]; other: T[] } {
  const important: T[] = [];
  const other: T[] = [];
  for (const row of rows) {
    (isImportant(row.type, overrides) ? important : other).push(row);
  }
  return { important, other };
}

export function isImportanceValue(v: unknown): v is Importance {
  return v === "important" || v === "other";
}
