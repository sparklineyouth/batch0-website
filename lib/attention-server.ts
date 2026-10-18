import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { can, type Capabilities } from "@/lib/permissions";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { easternDate } from "@/lib/assignments";
import { loadFeedbackQueue } from "@/lib/assignments-server";
import { mentorScope } from "@/lib/mentor-scope";
import { countTicketsForStaff, listTicketsForStaff } from "@/lib/support";
import { supportScopeFor } from "@/lib/support-access";
import { getChannelRow, listOpenReportsFor } from "@/lib/chat";
import { listDueFollowUps } from "@/lib/student-followups-server";
import { loadUnansweredQuestions } from "@/lib/chat-questions";
import { displayEmail } from "@/lib/placeholder-email";
import {
  ATTENTION_LIMIT,
  ATTENTION_PERMITTED,
  chatReportItems,
  collectAttention,
  feedbackItems,
  followUpItems,
  questionItems,
  questionLeftToSupport,
  supportItems,
  type AttentionProvider,
  type AttentionResult,
  type ReportChannelLike,
} from "@/lib/attention";

/**
 * The providers behind the Overview's attention list (lib/attention.ts has
 * the rules and says why it's shaped this way). Each one reads with the same
 * function as the page its rows open, so its count is that page's count.
 *
 * Read-only by construction: nothing in this file writes a row, sends a
 * notification, an email or a message, or marks anything seen.
 * lib/attention-server.test.ts holds it to that.
 */

export type AttentionContext = {
  userId: string;
  caps: Capabilities;
  /** One clock for the whole list. */
  now: number;
};

/**
 * Provider failures are logged here, then reported as "couldn't load". A
 * provider returns null only when its source isn't set up (a missing table);
 * every other failed read throws, so it lands in `failed` and is said under
 * the list, rather than reading as "nothing waiting".
 */
async function logged<T>(key: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.error(`[attention] ${key}`, (err as any)?.message ?? err);
    throw err;
  }
}

const support: AttentionProvider<AttentionContext> = {
  key: "support",
  permitted: ATTENTION_PERMITTED.support,
  load: ({ userId, caps, now }) =>
    logged("support", async () => {
      const scope = supportScopeFor(userId, caps);
      // Rows come from a scope that can't see confidential tickets at all, so
      // a concern's subject never reaches the Overview, whoever is looking.
      const listed = { ...scope, canSeeSensitive: false };
      const [page, counts] = await Promise.all([
        listTicketsForStaff({ view: "needs_reply", pageSize: ATTENTION_LIMIT }, listed),
        // The viewer's own queue count — the Support tab's "Needs reply" and
        // the tile above — only differs when they can see confidential ones.
        scope.canSeeSensitive ? countTicketsForStaff(scope, {}, now) : null,
      ]);
      if (page.error) {
        if (isMissingSchemaError(page.error)) return null;
        throw new Error(page.error.message);
      }
      const total = counts?.available ? Math.max(counts.needs_reply, page.total) : page.total;
      const confidential = total - page.total;
      return {
        key: "support",
        label: "Support",
        total,
        href: "/admin/support",
        items: supportItems(page.tickets, { userId, canManage: scope.canManage }, now),
        note:
          confidential > 0
            ? {
                text: `${confidential} confidential ${confidential === 1 ? "request needs" : "requests need"} a reply. They're listed in Support only.`,
                href: "/admin/support",
              }
            : counts && !counts.available
              ? // The rows are right; only the confidential count is unknown.
                // Say so rather than let the total pass for the whole queue.
                { text: "Couldn't count confidential requests just now. Support has the full queue.", href: "/admin/support" }
              : null,
      };
    }),
};

const feedback: AttentionProvider<AttentionContext> = {
  key: "feedback",
  permitted: ATTENTION_PERMITTED.feedback,
  load: ({ userId, caps, now }) =>
    logged("feedback", async () => {
      const admin = createAdminClient();
      // The review action's rule: program-wide for assignments.manage,
      // otherwise the mentor's own cohorts and students.
      const manager = can(caps, "assignments.manage");
      const scope = manager ? null : await mentorScope(admin, userId);
      const queue = await loadFeedbackQueue(admin, scope, { limit: ATTENTION_LIMIT });
      if (!queue.ready) {
        if (queue.failed) throw new Error("Couldn't load the feedback queue");
        return null;
      }
      return {
        key: "feedback",
        label: "Feedback",
        total: queue.total,
        // The page that shows the same count: the mentor review queue, or
        // for a manager without mentor.panel the "Waiting for feedback" list
        // on /admin/assignments, which reads the same loadFeedbackQueue.
        href: can(caps, "mentor.panel") ? "/mentor/assignments" : "/admin/assignments#waiting-feedback",
        items: feedbackItems(queue.items, { userId, manager }, await mentorsOf(queue.items.map((s) => s.userId)), now),
      };
    }),
};

/**
 * Each student's direct mentors (mentor_assignments), with names. A failed
 * read throws: "Any reviewer" on a student who has a mentor would be a wrong
 * owner, and the owner is what stops two people picking up the same work.
 */
async function mentorsOf(studentIds: readonly string[]): Promise<Map<string, { id: string; name: string }[]>> {
  const out = new Map<string, { id: string; name: string }[]>();
  const ids = Array.from(new Set(studentIds));
  if (ids.length === 0) return out;
  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("mentor_assignments")
    .select("student_id, mentor_id")
    .in("student_id", ids);
  if (error) throw new Error(`Couldn't read mentors: ${error.message}`);
  if (!rows?.length) return out;
  const mentorIds = Array.from(new Set(rows.map((r: any) => r.mentor_id as string).filter(Boolean)));
  const { data: people, error: peopleError } = await admin
    .from("profiles")
    .select("id, full_name, email")
    .in("id", mentorIds);
  if (peopleError) throw new Error(`Couldn't read mentor names: ${peopleError.message}`);
  const name = new Map(
    ((people ?? []) as any[]).map((p) => [p.id as string, (p.full_name as string | null)?.trim() || displayEmail(p.email) || "Mentor"]),
  );
  for (const r of rows as any[]) {
    if (!r.mentor_id) continue;
    const list = out.get(r.student_id) ?? [];
    if (!list.some((m) => m.id === r.mentor_id)) list.push({ id: r.mentor_id, name: name.get(r.mentor_id) ?? "Mentor" });
    out.set(r.student_id, list);
  }
  return out;
}

const chatReports: AttentionProvider<AttentionContext> = {
  key: "chat_reports",
  permitted: ATTENTION_PERMITTED.chat_reports,
  load: ({ userId, caps, now }) =>
    logged("chat_reports", async () => {
      try {
        // Most days there is no open report at all. Say so from one count,
        // before reading anything about the reports. A GET, not a HEAD: a
        // HEAD's error has no body to say "does not exist".
        const { count, error } = await createAdminClient()
          .from("chat_reports")
          .select("id", { count: "exact" })
          .eq("status", "open")
          .limit(1);
        if (error) throw Object.assign(new Error(error.message || "Couldn't count chat reports"), { code: error.code });
        if (count === 0) return { key: "chat_reports", label: "Chat reports", total: 0, href: "/admin/chat", items: [] };
        // The queue /admin/chat shows, with every report naming this
        // moderator already left out. listOpenReportsFor (lib/chat.ts) is
        // listReports without resolving the moderator's whole chat
        // membership (thousands of DM rows for staff) on every Overview
        // render: it reads their membership of the reported channels only.
        const open = await listOpenReportsFor(userId, caps);
        // A report this moderator filed is counted (it's in their queue) but
        // isn't theirs to judge, so it isn't a row; the note says so.
        const theirs = open.filter((r) => r.reporterId !== userId);
        const filed = open.length - theirs.length;
        // Newest first from the queue; the attention list wants the oldest.
        const oldest = theirs.slice(-ATTENTION_LIMIT);
        const channels = new Map<string, ReportChannelLike>();
        await Promise.all(
          Array.from(new Set(oldest.map((r) => r.channelId))).map(async (id) => {
            const c = await getChannelRow(id).catch(() => null);
            channels.set(id, c ? { kind: c.kind, name: c.name } : null);
          }),
        );
        return {
          key: "chat_reports",
          label: "Chat reports",
          total: open.length,
          href: "/admin/chat",
          items: chatReportItems(oldest, channels, userId, now),
          note:
            filed > 0
              ? {
                  text: `${filed === 1 ? "A report you filed is" : `${filed} reports you filed are`} left for another moderator.`,
                  href: "/admin/chat",
                }
              : null,
        };
      } catch (err) {
        if (isMissingSchemaError(err)) return null;
        throw err;
      }
    }),
};

/**
 * #help's open questions (Chat threads, 0110): the count its Unanswered list
 * shows, and the oldest few as rows that open their thread. A question whose
 * help request is in Support's "Needs reply" queue is counted but left to
 * its Support row — for a viewer who sees Support's rows — and the note says
 * how many (questionLeftToSupport). One the team has answered in Support
 * (waiting on the asker) is in no queue, so it stays a row here.
 */
const chatQuestions: AttentionProvider<AttentionContext> = {
  key: "chat_questions",
  permitted: ATTENTION_PERMITTED.chat_questions,
  load: ({ caps, now }) =>
    logged("chat_questions", async () => {
      try {
        const q = await loadUnansweredQuestions({ limit: ATTENTION_LIMIT });
        if (!q.ready || !q.help) return null;
        const supportListed = ATTENTION_PERMITTED.support(caps);
        const items = questionItems(q.rows, now, { supportListed }).slice(0, ATTENTION_LIMIT);
        const withHelp = q.rows.filter((r) => questionLeftToSupport(r, supportListed)).length;
        return {
          key: "chat_questions",
          label: "Unanswered questions",
          total: q.total,
          href: `/chat?c=${q.help.id}`,
          items,
          note:
            withHelp > 0
              ? {
                  text: `${withHelp === 1 ? "1 question has" : `${withHelp} questions have`} a help request open: listed under Support.`,
                  href: "/admin/support",
                }
              : null,
        };
      } catch (err) {
        if (isMissingSchemaError(err)) return null;
        throw err;
      }
    }),
};

const followUps: AttentionProvider<AttentionContext> = {
  key: "followups",
  permitted: ATTENTION_PERMITTED.followups,
  load: ({ userId, now }) =>
    logged("followups", async () => {
      const today = easternDate(new Date(now));
      const due = await listDueFollowUps({ today, limit: ATTENTION_LIMIT });
      if (!due.ready) {
        if (due.failed) throw new Error("Couldn't load due follow-ups");
        return null;
      }
      return {
        key: "followups",
        label: "Follow-ups due",
        total: due.total,
        href: "/admin/progress#follow-ups",
        items: followUpItems(due.rows, userId, today),
      };
    }),
};

/** In the order the source links read on the Overview. */
export const ATTENTION_PROVIDERS: readonly AttentionProvider<AttentionContext>[] = [
  support,
  feedback,
  chatReports,
  chatQuestions,
  followUps,
];

/** The attention list for this viewer. Never throws: a failed source is named in `failed`. */
export async function loadAttention(ctx: AttentionContext): Promise<AttentionResult> {
  try {
    return await collectAttention(ctx.caps, ATTENTION_PROVIDERS, ctx);
  } catch (err) {
    console.error("[attention] loadAttention", err);
    return { sources: [], rows: [], failed: [] };
  }
}
