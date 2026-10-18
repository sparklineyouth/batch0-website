/**
 * The admin Overview's attention list — the pure rules. Relative .ts imports
 * so `node --test` runs it without a bundler; lib/attention-server.ts holds
 * the providers that read the database.
 *
 * One short list (ATTENTION_LIMIT rows) of work waiting on the team, each row
 * a reason, an age, an owner and one next action that opens the source
 * record. It is a view over the sources, never a copy of them: every row is
 * derived from the source's state when the page renders, so doing the work
 * at the source — replying, reviewing, closing the report or the follow-up —
 * is what takes a row off. Nothing here writes, and nothing here messages
 * anyone; opening the Overview tells nobody that it was opened.
 *
 * Each source is a provider: a permission check and a loader. The check runs
 * first and decides whether the loader runs at all, so a source the viewer
 * can't open is never read — not its rows, not its count. A provider's
 * `total` is the number its own page shows for the same work (the Support
 * queue's "Needs reply", the review queue's "To review", the open chat
 * reports, the due follow-ups), read with the same function, so the two
 * can't disagree.
 *
 * "Unanswered questions" (#help's open questions, Chat threads, migration
 * 0110) is one more provider of the same shape: a key, a permission check, a
 * loader, and questionItems below.
 */
import { can, canViewAdminPath, type Capabilities } from "./permissions.ts";
import { formatElapsed, slaState, type TicketPriority } from "./support-access.ts";
import { easternToUtc } from "./assignments.ts";
import { daysBetween, isFollowUpDue, type FollowUpStatus } from "./student-followups.ts";

/** At most this many rows; each source's full list is one click away. */
export const ATTENTION_LIMIT = 8;

export type AttentionSourceKey = "support" | "feedback" | "chat_reports" | "chat_questions" | "followups";

/**
 * How pressing a row is: past a target (overdue), at one (due), or simply
 * waiting. Rows sort by this, then oldest first.
 */
export type AttentionUrgency = "overdue" | "due" | "waiting";

export type AttentionOwner =
  /** `others`: more people share it (a student with two mentors). */
  | { kind: "person"; name: string; isViewer: boolean; others?: number }
  /** Nobody has it — "No owner" is itself something to act on. */
  | { kind: "nobody" }
  /** Work a group picks up, with no single assignee (reports, unmatched reviews). */
  | { kind: "team"; label: string };

export type AttentionItem = {
  /** Unique across sources: `${source}:${record id}`. */
  key: string;
  source: AttentionSourceKey;
  /** Why it's here, in words: "Reply overdue", "Waiting for feedback". */
  reason: string;
  /** Which record: a ticket's reference and subject, a student, a channel. */
  context: string;
  /** When the wait began — for sorting. */
  since: string;
  /** How long, for the eye: "3d 2h", "Due today". */
  age: string;
  urgency: AttentionUrgency;
  owner: AttentionOwner;
  /** The one next action, which opens the source record. */
  action: { label: string; href: string };
};

export type AttentionSource = {
  key: AttentionSourceKey;
  /** "Support", "Feedback", … */
  label: string;
  /** Every item this source has for the viewer — the number its own page shows. */
  total: number;
  /** That page. */
  href: string;
  /** Its most pressing items, at most ATTENTION_LIMIT. */
  items: AttentionItem[];
  /** A line about work counted but deliberately not itemized here. */
  note?: { text: string; href: string } | null;
};

export type AttentionProvider<Ctx> = {
  key: AttentionSourceKey;
  /** The source's own permission. Runs BEFORE anything is read. */
  permitted: (caps: Capabilities) => boolean;
  /**
   * Null when the source isn't set up yet (its migration hasn't run). Any
   * other failed read throws, and the source is named in `failed`.
   */
  load: (ctx: Ctx) => Promise<AttentionSource | null>;
};

/**
 * Who may see each source: whoever may open the page its rows open — the
 * admin route gate itself (lib/permissions.ts ADMIN_ROUTE_PERMISSIONS), so
 * a row's one action can never bounce off the layout back to the Overview.
 *
 *   support       /admin/support (support.view; support.manage alone
 *                 doesn't open the page, so it doesn't open the source)
 *   feedback      /admin/assignments (assignments.manage, program-wide), or
 *                 mentor.panel for their own cohorts and students — the
 *                 review action's rule
 *   chat_reports  /admin/chat (chat.manage)
 *   chat_questions  a #help thread in /chat: chat.manage, which reads every
 *                 text channel (canReadChannel) — #help included, whatever
 *                 its audience is set to
 *   followups     /admin/progress (people.view)
 */
export const ATTENTION_PERMITTED: Readonly<Record<AttentionSourceKey, (caps: Capabilities) => boolean>> = {
  support: (caps) => canViewAdminPath(caps, "/admin/support"),
  feedback: (caps) => canViewAdminPath(caps, "/admin/assignments") || can(caps, "mentor.panel"),
  chat_reports: (caps) => canViewAdminPath(caps, "/admin/chat"),
  chat_questions: (caps) => can(caps, "chat.manage"),
  followups: (caps) => canViewAdminPath(caps, "/admin/progress"),
};

export type AttentionResult = {
  /** Sources the viewer may see that loaded, in provider order. */
  sources: AttentionSource[];
  /** The rows to show, most pressing first. */
  rows: AttentionItem[];
  /** Sources the viewer may see whose read failed: said, not shown as empty. */
  failed: AttentionSourceKey[];
};

/**
 * Run the providers this viewer may see, and pick the rows. A provider the
 * viewer can't see is never called. One that throws is reported in `failed`
 * and the rest still show.
 */
export async function collectAttention<Ctx>(
  caps: Capabilities | null,
  providers: readonly AttentionProvider<Ctx>[],
  ctx: Ctx,
  limit: number = ATTENTION_LIMIT,
): Promise<AttentionResult> {
  if (!caps) return { sources: [], rows: [], failed: [] };
  const allowed = providers.filter((p) => p.permitted(caps));
  const settled = await Promise.allSettled(allowed.map((p) => p.load(ctx)));
  const sources: AttentionSource[] = [];
  const failed: AttentionSourceKey[] = [];
  settled.forEach((r, i) => {
    if (r.status === "rejected") failed.push(allowed[i].key);
    else if (r.value) sources.push({ ...r.value, items: r.value.items.filter((it) => it.source === r.value!.key) });
  });
  return { sources, rows: pickAttention(sources.flatMap((s) => s.items), limit), failed };
}

const URGENCY_RANK: Record<AttentionUrgency, number> = { overdue: 0, due: 1, waiting: 2 };

/** Most pressing first: urgency, then the longest wait, then a stable tiebreak. */
export function compareAttention(a: AttentionItem, b: AttentionItem): number {
  return (
    URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] ||
    Date.parse(a.since) - Date.parse(b.since) ||
    a.key.localeCompare(b.key)
  );
}

/**
 * The `limit` rows to show. Every source with work keeps its most pressing
 * row, so forty support requests can't hide the one submission that has
 * waited a week; the remaining slots go to whatever is most pressing overall.
 */
export function pickAttention(items: readonly AttentionItem[], limit: number = ATTENTION_LIMIT): AttentionItem[] {
  if (limit <= 0) return [];
  const sorted = [...items].sort(compareAttention);
  const chosen = new Set<string>();
  const out: AttentionItem[] = [];
  const firstOf = new Map<AttentionSourceKey, AttentionItem>();
  for (const it of sorted) if (!firstOf.has(it.source)) firstOf.set(it.source, it);
  for (const it of firstOf.values()) {
    if (out.length >= limit) break;
    out.push(it);
    chosen.add(it.key);
  }
  for (const it of sorted) {
    if (out.length >= limit) break;
    if (chosen.has(it.key)) continue;
    out.push(it);
    chosen.add(it.key);
  }
  return out.sort(compareAttention);
}

/**
 * What the list says when it has no rows, or null to say nothing. "Nothing
 * is waiting on the team" only when every source that loaded counts zero and
 * none failed: a source with work it doesn't itemize (confidential requests,
 * a report the viewer filed) or one that couldn't be read means something
 * may well be waiting, and its note or the "couldn't load" line says what.
 */
export function attentionEmptyText(result: AttentionResult): string | null {
  if (result.rows.length > 0 || result.sources.length === 0) return null;
  if (result.sources.some((s) => s.total > 0)) return null;
  return result.failed.length > 0 ? "Nothing waiting in the lists that loaded." : "Nothing is waiting on the team.";
}

/** "3d 2h", "45m" — never "0m", so a fresh item still reads as an age. */
export function ageSince(since: string, now: number): string {
  const ms = now - Date.parse(since);
  return formatElapsed(Number.isFinite(ms) ? Math.max(ms, 60_000) : 60_000);
}

export function ownerLabel(owner: AttentionOwner): string {
  if (owner.kind === "person") {
    const who = owner.isViewer ? "You" : owner.name;
    return owner.others ? `${who} +${owner.others}` : who;
  }
  if (owner.kind === "team") return owner.label;
  return "No owner";
}

// ---------------------------------------------------------------------------
// Support: requests that need a reply
// ---------------------------------------------------------------------------

export type SupportLike = {
  id: string;
  reference: string;
  subject: string;
  needsReply: boolean;
  priority: TicketPriority;
  sensitive: boolean;
  requesterActivityAt: string;
  assignedTo: string | null;
  assignedName: string | null;
};

/**
 * Rows for requests waiting on the team. A confidential ticket never becomes
 * a row, whoever is looking: its subject has no place on a page people glance
 * at over each other's shoulders. (The provider also reads with a scope that
 * can't see them; this is the second lock.) An unassigned request says so,
 * and its next action is to take it.
 */
export function supportItems(
  tickets: readonly SupportLike[],
  viewer: { userId: string; canManage: boolean },
  now: number,
): AttentionItem[] {
  return tickets
    .filter((t) => t.needsReply && !t.sensitive)
    .map((t) => {
      const state = slaState({ needsReply: true, priority: t.priority, requesterActivityAt: t.requesterActivityAt }, now);
      const owner: AttentionOwner = t.assignedTo
        ? { kind: "person", name: t.assignedName?.trim() || "Someone on the team", isViewer: t.assignedTo === viewer.userId }
        : { kind: "nobody" };
      const label = !viewer.canManage ? "Open" : t.assignedTo ? "Reply" : "Assign";
      return {
        key: `support:${t.id}`,
        source: "support" as const,
        reason: state === "overdue" ? "Reply overdue" : state === "due_soon" ? "Reply due soon" : "Needs a reply",
        context: `${t.reference} · ${t.subject}`,
        since: t.requesterActivityAt,
        age: ageSince(t.requesterActivityAt, now),
        urgency: state === "overdue" ? ("overdue" as const) : state === "due_soon" ? ("due" as const) : ("waiting" as const),
        owner,
        action: { label, href: `/admin/support/${t.id}` },
      };
    });
}

// ---------------------------------------------------------------------------
// Feedback: submissions waiting on a reviewer
// ---------------------------------------------------------------------------

export type FeedbackLike = {
  id: string;
  assignmentId: string;
  userId: string;
  status?: string;
  submittedAt: string | null;
  assignment: { title: string; week: number | null; cohortId: string };
  studentName: string | null;
};

/**
 * Rows for handed-in work nobody has reviewed. The owner is the student's
 * mentor when they have one (by mentor_assignments); otherwise anyone who
 * reviews. Holders of assignments.manage land on the admin review drawer;
 * mentors on their own queue.
 */
export function feedbackItems(
  subs: readonly FeedbackLike[],
  viewer: { userId: string; manager: boolean },
  mentorsOf: ReadonlyMap<string, readonly { id: string; name: string }[]>,
  now: number,
): AttentionItem[] {
  return subs
    .filter((s) => (s.status ?? "submitted") === "submitted")
    .map((s) => {
      const since = s.submittedAt ?? new Date(now).toISOString();
      const mentors = mentorsOf.get(s.userId) ?? [];
      const mine = mentors.find((m) => m.id === viewer.userId);
      const owner: AttentionOwner =
        mentors.length === 0
          ? { kind: "team", label: "Any reviewer" }
          : { kind: "person", name: (mine ?? mentors[0]).name, isViewer: !!mine, others: mentors.length - 1 };
      const week = s.assignment.week ? ` · Week ${s.assignment.week}` : "";
      return {
        key: `feedback:${s.id}`,
        source: "feedback" as const,
        reason: "Waiting for feedback",
        context: `${s.studentName || "Student"} · ${s.assignment.title}${week}`,
        since,
        age: ageSince(since, now),
        urgency: "waiting" as const,
        owner,
        action: {
          label: "Review",
          href: viewer.manager
            ? `/admin/assignments?cohort=${s.assignment.cohortId}&review=${s.assignmentId}:${s.userId}`
            : `/mentor/assignments#submission-${s.id}`,
        },
      };
    });
}

// ---------------------------------------------------------------------------
// Chat reports
// ---------------------------------------------------------------------------

export type ChatReportLike = {
  id: string;
  channelId: string;
  partyIds: readonly string[];
  messageId: string | null;
  /** Who filed it. Never shown; a moderator's own report isn't theirs to judge. */
  reporterId?: string | null;
  status: string;
  createdAt: string;
};

export type ReportChannelLike = { kind: "channel" | "dm" | "group"; name: string | null } | null;

/**
 * Rows for open chat reports. Reports naming the viewer as a party were
 * already left out by the queue (lib/chat.ts listReports); they are dropped
 * here again, so no change upstream can put a report about you in your own
 * list. A report the viewer filed isn't a row either: it's in their queue,
 * but judging your own complaint is for another moderator (the provider
 * counts it and says so). A row says where, never who reported or why —
 * that's on the report.
 */
export function chatReportItems(
  reports: readonly ChatReportLike[],
  channels: ReadonlyMap<string, ReportChannelLike>,
  viewerId: string,
  now: number,
): AttentionItem[] {
  return reports
    .filter((r) => r.status === "open" && !r.partyIds.includes(viewerId) && r.reporterId !== viewerId)
    .map((r) => {
      const c = channels.get(r.channelId) ?? null;
      const where = !c ? "a deleted channel" : c.kind === "channel" ? `#${c.name ?? "channel"}` : c.kind === "dm" ? "a direct message" : "a group DM";
      return {
        key: `chat_reports:${r.id}`,
        source: "chat_reports" as const,
        reason: "Report to review",
        context: `${r.messageId ? "Message" : "Conversation"} in ${where}`,
        since: r.createdAt,
        age: ageSince(r.createdAt, now),
        // Someone asked the team to look at something said to or about them.
        urgency: "due" as const,
        owner: { kind: "team", label: "Moderators" } as const,
        action: { label: "Review", href: `/admin/chat/reports/${r.id}` },
      };
    });
}

// ---------------------------------------------------------------------------
// Unanswered questions (#help, Chat threads — migration 0110)
// ---------------------------------------------------------------------------

export type QuestionLike = {
  rootId: string;
  channelId: string;
  channelName: string | null;
  askerName: string;
  askedAt: string;
  replyCount: number;
  /** The thread's help request (a Support ticket), when someone asked the team. */
  help: { status: "open" | "waiting_on_requester" | "resolved" | "closed"; assigneeName: string | null } | null;
};

/** A question nobody has replied to for this long is overdue. */
export const QUESTION_STALE_MS = 24 * 3_600_000;

/**
 * Is this question left to its Support row? Only while its help request is
 * in Support's "Needs reply" queue (status open — the one the Support
 * provider lists), and only for someone who sees that provider. A request
 * the team answered (waiting on the asker) or handled is in no queue, so the
 * question is a row of its own; so is every question for a chat.manage
 * holder who can't open Support.
 */
export function questionLeftToSupport(q: Pick<QuestionLike, "help">, supportListed: boolean): boolean {
  return supportListed && q.help?.status === "open";
}

/**
 * Rows for #help's open questions, the ones waiting longest first. A
 * question whose help request is in the team's Support queue isn't a row:
 * that request is a Support row already (one record, one row), and the
 * provider says so in its note (questionLeftToSupport). A row names the
 * channel and who asked — never the question's words — and opens the
 * thread, where it's answered and marked answered: doing that is what takes
 * the row off.
 */
export function questionItems(
  rows: readonly QuestionLike[],
  now: number,
  opts: { supportListed: boolean },
): AttentionItem[] {
  return rows
    .filter((q) => !questionLeftToSupport(q, opts.supportListed))
    .map((q) => {
      const waited = now - Date.parse(q.askedAt);
      const unreplied = q.replyCount === 0;
      const stale = unreplied && Number.isFinite(waited) && waited >= QUESTION_STALE_MS;
      return {
        key: `chat_questions:${q.rootId}`,
        source: "chat_questions" as const,
        reason: stale ? "No reply in 24 hours" : unreplied ? "No reply yet" : "Not marked answered",
        context: `#${q.channelName ?? "help"} · ${q.askerName}`,
        since: q.askedAt,
        age: ageSince(q.askedAt, now),
        urgency: stale ? ("overdue" as const) : ("waiting" as const),
        owner: { kind: "team", label: "Anyone on the team" } as const,
        action: { label: unreplied ? "Answer" : "Open", href: `/chat?c=${q.channelId}&thread=${q.rootId}` },
      };
    });
}

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

export type FollowUpLike = {
  id: string;
  studentId: string;
  studentName: string;
  ownerId: string | null;
  ownerName: string | null;
  nextCheckOn: string;
  status: FollowUpStatus;
};

/**
 * Rows for follow-ups whose next check is today or earlier (New York). The
 * reason is the date the owner set, nothing inferred about the student.
 */
export function followUpItems(rows: readonly FollowUpLike[], viewerId: string, today: string): AttentionItem[] {
  return rows
    .filter((f) => isFollowUpDue(f, today))
    .map((f) => {
      const late = daysBetween(f.nextCheckOn, today);
      const since = easternToUtc(f.nextCheckOn, "00:00") ?? `${f.nextCheckOn}T00:00:00Z`;
      const owner: AttentionOwner = f.ownerId
        ? { kind: "person", name: f.ownerName ?? "Someone on the team", isViewer: f.ownerId === viewerId }
        : { kind: "nobody" };
      return {
        key: `followups:${f.id}`,
        source: "followups" as const,
        reason: late > 0 ? "Follow-up check overdue" : "Follow-up check due",
        context: f.studentName,
        since,
        age: late === 0 ? "Due today" : late === 1 ? "1 day late" : `${late} days late`,
        urgency: late > 0 ? ("overdue" as const) : ("due" as const),
        owner,
        action: { label: "Open", href: `/admin/progress?followup=${f.studentId}` },
      };
    });
}
