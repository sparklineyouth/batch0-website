import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Flag } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { LocalTime } from "@/components/ui/local-time";
import {
  getDmViewer,
  getPeople,
  listMessages,
  listReportsForConversation,
  getConversationForViewer,
} from "@/lib/dm";
import { Avatar, PersonLabel } from "@/components/messages/person";
import { ReportControls } from "./report-controls";
import { Transcript } from "./transcript";

export const metadata = { title: "Reported conversation · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * A reported conversation, read-only, with the reports against it.
 *
 * Read access comes from getConversationForViewer(), which for a moderator
 * resolves to null unless the conversation has been reported — so an
 * unreported DM 404s here exactly like one that doesn't exist, even for an
 * admin who types the id in. That is the same answer a stranger gets, and it's
 * the promise the report dialog makes to the person pressing Report.
 */
export default async function AdminConversationPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const { profile, caps } = await requireViewer();
  const viewer = await getDmViewer(profile.id, caps);
  const convo = await getConversationForViewer(params.id, viewer);
  if (!convo) notFound();

  const [messages, reports, people] = await Promise.all([
    listMessages(convo.id, 1000),
    listReportsForConversation(convo.id),
    getPeople([convo.userA, convo.userB]),
  ]);
  const a = people.get(convo.userA);
  const b = people.get(convo.userB);

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/admin/messages"
        prefetch={false}
        className="press inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" />
        Reported DMs
      </Link>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {[a, b].map((p, i) =>
          p ? (
            <div key={p.id} className="flex items-center gap-2">
              {i > 0 && <span className="text-ink-faint">↔</span>}
              <Avatar person={p} size="sm" />
              <PersonLabel person={p} className="text-sm" />
            </div>
          ) : (
            <span key={i} className="text-sm text-ink-faint">
              Deleted account
            </span>
          ),
        )}
      </div>

      {/* Reports */}
      <section className="mt-6 space-y-2">
        {reports.map((r) => (
          <div
            key={r.id}
            className="rounded-xl border border-line bg-wash px-4 py-3"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-xs font-medium text-ink">
                  <Flag className="h-3 w-3 text-red-400" />
                  Reported by {r.reporterName}
                  <span className="font-normal text-ink-faint">
                    · <LocalTime value={r.createdAt} />
                  </span>
                </p>
                <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-ink-soft">
                  {r.reason}
                </p>
              </div>
              <ReportControls
                reportId={r.id}
                status={r.status}
                reviewedAt={r.reviewedAt}
              />
            </div>
          </div>
        ))}
      </section>

      {/* Transcript */}
      <section className="mt-6 overflow-hidden rounded-2xl border border-line">
        <p className="border-b border-line bg-wash px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Transcript · {messages.length} message{messages.length === 1 ? "" : "s"}
        </p>
        <Transcript conversationId={convo.id} messages={messages} />
      </section>

      <p className="mt-4 text-xs text-ink-faint">
        Read-only. You can&apos;t post in someone else&apos;s conversation — if
        something here needs saying, say it from your own account.
      </p>
    </div>
  );
}
