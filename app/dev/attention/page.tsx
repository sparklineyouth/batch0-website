import { notFound } from "next/navigation";
import { AttentionList } from "@/components/admin/attention-list";
import { FollowUpPreview } from "./follow-up-preview";
import {
  chatReportItems,
  feedbackItems,
  followUpItems,
  pickAttention,
  supportItems,
  type AttentionResult,
  type AttentionSource,
} from "@/lib/attention";

/**
 * Interface preview for the admin Overview's attention list, and the
 * follow-up drawer on Student progress that feeds it.
 *
 * The real list (/admin) needs a signed-in admin and a database; this builds
 * the same rows from fixtures with the same builders (lib/attention.ts) and
 * renders the same component, so the layout — reasons, owners, ages, the one
 * action per row, the confidential note, a failed source — can be reviewed
 * without any of that. `?empty=1` shows the clear state, `?failed=1` a source
 * whose read failed, `?confidential=1` a queue whose only waiting requests
 * are confidential (counted, never rows, and not "nothing waiting"). Saving in the drawer calls the real server action, which
 * refuses without an admin session.
 *
 * Gated on VERCEL_ENV (not NODE_ENV, which is "production" on every Vercel
 * deployment): it renders on localhost and on branch previews, and 404s on
 * the live site.
 */
export const metadata = {
  title: "Attention list preview · batch0",
  robots: { index: false, follow: false },
};

const ME = "00000000-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-10-17T16:00:00.000Z");
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function fixture(): AttentionResult {
  const support: AttentionSource = {
    key: "support",
    label: "Support",
    total: 6,
    href: "/admin/support",
    items: supportItems(
      [
        { id: "t1", reference: "B0-7K2M-9QXA", subject: "Refund for the spring cohort deposit", needsReply: true, priority: "high", sensitive: false, requesterActivityAt: ago(27), assignedTo: null, assignedName: null },
        { id: "t2", reference: "B0-3PZR-H8TN", subject: "Can't open the week 4 lesson video", needsReply: true, priority: "normal", sensitive: false, requesterActivityAt: ago(39), assignedTo: ME, assignedName: "Sam" },
        { id: "t3", reference: "B0-W2D9-6CVB", subject: "Change of email address", needsReply: true, priority: "low", sensitive: false, requesterActivityAt: ago(3), assignedTo: "x", assignedName: "Priya Raman" },
      ],
      { userId: ME, canManage: true },
      NOW,
    ),
    note: { text: "1 confidential request needs a reply. They're listed in Support only.", href: "/admin/support" },
  };
  const feedback: AttentionSource = {
    key: "feedback",
    label: "Feedback",
    total: 14,
    href: "/mentor/assignments",
    items: feedbackItems(
      [
        { id: "s1", assignmentId: "a1", userId: "u1", submittedAt: ago(96), assignment: { title: "Weekly update", week: 4, cohortId: "c1" }, studentName: "Ada Lovelace" },
        { id: "s2", assignmentId: "a2", userId: "u2", submittedAt: ago(50), assignment: { title: "Customer interview notes", week: 3, cohortId: "c1" }, studentName: "Grace Hopper" },
      ],
      { userId: ME, manager: true },
      new Map([["u1", [{ id: "m1", name: "Jordan Lee" }]]]),
      NOW,
    ),
  };
  const reports: AttentionSource = {
    key: "chat_reports",
    label: "Chat reports",
    total: 1,
    href: "/admin/chat",
    items: chatReportItems(
      [{ id: "r1", channelId: "ch1", partyIds: [], messageId: "m1", status: "open", createdAt: ago(6) }],
      new Map([["ch1", { kind: "channel" as const, name: "help" }]]),
      ME,
      NOW,
    ),
  };
  const followUps: AttentionSource = {
    key: "followups",
    label: "Follow-ups due",
    total: 2,
    href: "/admin/progress#follow-ups",
    items: followUpItems(
      [
        { id: "f1", studentId: "u3", studentName: "Katherine Johnson", ownerId: ME, ownerName: "Sam", nextCheckOn: "2026-10-17", status: "open" },
        { id: "f2", studentId: "u4", studentName: "Alan Turing", ownerId: null, ownerName: null, nextCheckOn: "2026-10-14", status: "open" },
      ],
      ME,
      "2026-10-17",
    ),
  };
  const sources = [support, feedback, reports, followUps];
  return { sources, rows: pickAttention(sources.flatMap((s) => s.items)), failed: [] };
}

/** As if one source's read had failed: gone from the counts and the rows, and named. */
function withFailed(full: AttentionResult, key: AttentionSource["key"]): AttentionResult {
  const sources = full.sources.filter((s) => s.key !== key);
  return { sources, rows: pickAttention(sources.flatMap((s) => s.items)), failed: [key] };
}

export default async function AttentionPreviewPage(props: {
  searchParams: Promise<{ empty?: string; failed?: string; confidential?: string }>;
}) {
  if (process.env.VERCEL_ENV === "production") notFound();
  const sp = await props.searchParams;
  const full = fixture();
  const cleared = full.sources.map((s) => ({ ...s, total: 0, items: [], note: null }));
  const attention: AttentionResult =
    sp.empty === "1"
      ? { sources: cleared, rows: [], failed: [] }
      : sp.confidential === "1"
        ? {
            sources: cleared.map((s) =>
              s.key === "support"
                ? { ...s, total: 2, note: { text: "2 confidential requests need a reply. They're listed in Support only.", href: "/admin/support" } }
                : s,
            ),
            rows: [],
            failed: [],
          }
        : sp.failed === "1"
          ? withFailed(full, "chat_reports")
          : full;

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <p className="mb-6 rounded-lg border border-amber-400/40 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
        Preview with made-up rows. The links go to the real admin pages, which need an admin session.
      </p>
      <h1 className="font-display text-4xl font-bold tracking-[-0.02em] text-ink">Overview</h1>
      <AttentionList attention={attention} />

      <h2 className="mt-16 mb-3 text-sm font-semibold text-ink">Follow-up drawer (Student progress)</h2>
      <FollowUpPreview />
    </main>
  );
}
