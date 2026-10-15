import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { plainText } from "@/lib/chat-format";
import {
  getChannelRow,
  getChatViewer,
  getMessageRow,
  getPeople,
  getReport,
  listMembers,
  listReportsForChannel,
  listRevisions,
  listTranscript,
} from "@/lib/chat";
import { ReportControls } from "./report-controls";

export const metadata = { title: "Chat report · Admin" };
export const dynamic = "force-dynamic";

/**
 * One report: what was reported and why, every other report on the same
 * channel, and the transcript — deleted messages included with what they
 * said, edits with their earlier versions. A moderator the report is about
 * — in the DM or group when it was filed or now, or the sender of the
 * reported message — gets a 404: who reported them, and why, is exactly what
 * they must not learn.
 */
export default async function ChatReportPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { profile, caps } = await requirePermission("chat.manage");
  const viewer = await getChatViewer(profile.id, caps);
  const report = await getReport(id, viewer);
  if (!report) notFound();
  const channel = await getChannelRow(report.channelId);
  if (!channel) notFound();
  const members = (await listMembers([channel.id])).get(channel.id) ?? [];

  const [all, transcript, reported, revisions] = await Promise.all([
    listReportsForChannel(channel.id, viewer),
    listTranscript(channel.id, 200),
    report.messageId ? getMessageRow(report.messageId) : Promise.resolve(null),
    report.messageId ? listRevisions(report.messageId) : Promise.resolve([]),
  ]);
  const people = await getPeople([
    ...members,
    ...transcript.map((m) => m.senderId),
    ...(reported ? [reported.sender_id] : []),
  ]);
  const name = (uid: string | null) => (uid ? (people.get(uid)?.name ?? "Deleted account") : "batch0");
  const where =
    channel.kind === "channel" ? `#${channel.name}` : channel.kind === "dm" ? "Direct message" : `Group DM${channel.name ? `: ${channel.name}` : ""}`;

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/admin/chat" prefetch={false} className="text-sm link-ink">← Chat</Link>
      <h1 className="mt-3 font-display text-3xl text-ink">
        {report.messageId ? "Reported message" : "Reported conversation"} · {where}
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        Reported by {report.reporterName} · <LocalTime value={report.createdAt} mode="datetime-short" /> · status{" "}
        <strong className="text-ink">{report.status}</strong>
        {channel.kind !== "channel" ? ` · members: ${members.map((m) => name(m)).join(", ") || "none left"}` : ""}
      </p>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold text-ink">Reason</h2>
        <p className="mt-1 whitespace-pre-wrap text-sm text-ink-soft">{report.reason}</p>
        {reported ? (
          <div className="mt-4 border-t border-line pt-4">
            <h2 className="text-sm font-semibold text-ink">The message</h2>
            <p className="mt-1 text-xs text-ink-faint">
              {name(reported.sender_id)} · <LocalTime value={reported.created_at} mode="datetime-short" />
              {reported.deleted_at ? " · deleted" : ""}
              {reported.edited_at ? " · edited" : ""}
            </p>
            <p className="mt-2 whitespace-pre-wrap break-words rounded-md border border-line bg-wash p-3 text-sm text-ink">
              {reported.deleted_at ? (revisions.at(-1)?.body ?? "(no text)") : reported.body || "(attachment only)"}
            </p>
            {revisions.length > 0 ? (
              <details className="mt-2 text-xs text-ink-soft">
                <summary className="cursor-pointer">Earlier versions ({revisions.length})</summary>
                <ul className="mt-2 space-y-2">
                  {revisions.map((r, i) => (
                    <li key={i} className="rounded border border-line p-2">
                      <span className="font-mono text-[10px] text-ink-faint">
                        {r.reason === "delete" ? "before delete" : "before edit"} · <LocalTime value={r.createdAt} mode="datetime-short" />
                      </span>
                      <p className="mt-1 whitespace-pre-wrap break-words">{r.body || "(no text)"}</p>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
        <div className="mt-4 border-t border-line pt-4">
          <ReportControls
            reportId={report.id}
            status={report.status}
            messageId={reported && !reported.deleted_at ? reported.id : null}
            chatHref={`/chat?c=${channel.id}${reported ? `&m=${reported.id}` : ""}`}
          />
        </div>
      </Card>

      {all.length > 1 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">All reports on this {channel.kind === "channel" ? "channel" : "conversation"}</h2>
          <ul className="mt-3 divide-y divide-line rounded-md border border-line">
            {all.map((r) => (
              <li key={r.id} className="px-4 py-3 text-sm">
                <Link href={`/admin/chat/reports/${r.id}`} prefetch={false} className={r.id === report.id ? "font-semibold text-ink" : "link-ink"}>
                  {r.reporterName}
                </Link>{" "}
                <span className="text-ink-faint">· {r.status} · <LocalTime value={r.createdAt} mode="datetime-short" /></span>
                <p className="mt-1 truncate text-ink-soft">{r.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">Transcript (last 200 messages)</h2>
        <ol className="mt-3 divide-y divide-line rounded-md border border-line">
          {transcript.map((m) => (
            <li key={m.id} className={`px-4 py-2.5 text-sm ${m.id === report.messageId ? "bg-phosphor/15" : ""} ${m.deletedAt ? "bg-red-500/5" : ""}`}>
              <p className="text-xs text-ink-faint">
                <strong className="text-ink">{name(m.senderId)}</strong> · <LocalTime value={m.createdAt} mode="datetime-short" />
                {m.deletedAt ? " · deleted" : ""}
                {m.editedAt ? " · edited" : ""}
              </p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-ink-soft">
                {m.deletedAt
                  ? `[deleted] ${m.original ?? ""}`
                  : plainText(m.body || (m.attachments.length ? `[${m.attachments.length} attachment(s)]` : ""), (uid) => people.get(uid)?.name, () => null, 4000)}
              </p>
            </li>
          ))}
          {transcript.length === 0 ? <li className="px-4 py-3 text-sm text-ink-faint">No messages.</li> : null}
        </ol>
      </section>
    </div>
  );
}
