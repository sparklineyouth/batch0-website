import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { rawText } from "@/lib/chat-format";
import { chatFileHref, type ChatAttachment } from "@/lib/chat-files-rules";
import { muteActive } from "@/lib/chat-access";
import {
  DELETED_NAME,
  getChannelRow,
  getChatViewer,
  getMessageRow,
  getMute,
  getPeople,
  getReport,
  listMembers,
  listReportsForChannel,
  listRevisions,
  listTranscript,
  toAttachments,
  type ChatPerson,
  type Revision,
} from "@/lib/chat";
import { ReportControls, type MuteTarget } from "./report-controls";

export const metadata = { title: "Chat report · Admin" };
export const dynamic = "force-dynamic";

/** Messages around the reported one (or the newest, for a whole conversation). */
const TRANSCRIPT_WINDOW = 200;

/**
 * One report: what was reported and why, every other report on the same
 * channel, and the transcript around it — deleted messages included with
 * what they said, edited ones with every earlier version, files included.
 * Bodies are shown as written (spoilers open, line breaks kept): this is the
 * evidence, not a preview. A moderator any report on the channel names — in
 * the DM or group, the sender of a reported message, a party to an earlier
 * report — gets a 404: who reported them, and why, is exactly what they must
 * not learn.
 */
export default async function ChatReportPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { profile, caps } = await requirePermission("chat.manage");

  let loaded: Awaited<ReturnType<typeof load>>;
  try {
    loaded = await load(id, profile.id, caps);
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    return (
      <div className="mx-auto max-w-3xl">
        <Link href="/admin/chat" prefetch={false} className="text-sm link-ink">← Chat</Link>
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            Chat isn&apos;t set up yet. Run migration <code>0101_chat.sql</code> in the Supabase SQL editor (see
            docs/chat.md); reports show here once it has.
          </p>
        </Card>
      </div>
    );
  }
  if (!loaded) notFound();
  const { report, channel, members, all, transcript, reported, revisions, people, mutes } = loaded;

  const name = (uid: string | null, kind: string = "message") =>
    uid ? (people.get(uid)?.name ?? DELETED_NAME) : kind === "system" ? "batch0" : DELETED_NAME;
  const text = (body: string) => rawText(body, (uid) => people.get(uid)?.name);
  const fileHref = (a: ChatAttachment) =>
    `/admin/chat/reports/${report.id}/file?p=${encodeURIComponent(a.path)}&n=${encodeURIComponent(a.name)}&t=${encodeURIComponent(a.type)}`;
  const where = !channel
    ? "A deleted channel"
    : channel.kind === "channel"
      ? `#${channel.name}`
      : channel.kind === "dm"
        ? "Direct message"
        : `Group DM${channel.name ? `: ${channel.name}` : ""}`;

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/admin/chat" prefetch={false} className="text-sm link-ink">← Chat</Link>
      <h1 className="mt-3 font-display text-3xl text-ink">
        {report.messageId ? "Reported message" : "Reported conversation"} · {where}
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        Reported by {report.reporterName} · <LocalTime value={report.createdAt} mode="datetime-short" /> · status{" "}
        <strong className="text-ink">{report.status}</strong>
        {channel && channel.kind !== "channel" ? ` · members: ${members.map((m) => name(m)).join(", ") || "none left"}` : ""}
      </p>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold text-ink">Reason</h2>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-soft">{report.reason}</p>
        {reported ? (
          <div className="mt-4 border-t border-line pt-4">
            <h2 className="text-sm font-semibold text-ink">The message</h2>
            <p className="mt-1 text-xs text-ink-faint">
              {name(reported.sender_id, reported.kind)} · <LocalTime value={reported.created_at} mode="datetime-short" />
              {reported.deleted_at ? " · deleted" : ""}
              {reported.edited_at ? " · edited" : ""}
            </p>
            <p className="mt-2 whitespace-pre-wrap break-words rounded-md border border-line bg-wash p-3 text-sm text-ink">
              {reported.deleted_at
                ? text(revisions.at(-1)?.body ?? "") || "(no text)"
                : text(reported.body ?? "") || "(attachment only)"}
            </p>
            <Files
              files={reported.deleted_at ? (revisions.at(-1)?.attachments ?? []) : toAttachments(reported.attachments)}
              href={(a, i) => (reported.deleted_at ? fileHref(a) : chatFileHref(reported.id, i))}
            />
            <Versions revisions={revisions} text={text} fileHref={fileHref} />
          </div>
        ) : null}
        <div className="mt-4 border-t border-line pt-4">
          <ReportControls
            reportId={report.id}
            status={report.status}
            messageId={reported && !reported.deleted_at ? reported.id : null}
            chatHref={channel ? `/chat?c=${channel.id}${reported ? `&m=${reported.id}` : ""}` : null}
            mutes={mutes}
          />
        </div>
      </Card>

      {all.length > 1 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
            All reports on this {channel?.kind === "channel" ? "channel" : "conversation"}
          </h2>
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

      {channel ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
            Transcript ({report.messageId ? "around the reported message" : "the newest messages"})
          </h2>
          <ol className="mt-3 divide-y divide-line rounded-md border border-line">
            {transcript.hasMoreBefore ? <li className="px-4 py-2 text-xs text-ink-faint">Earlier messages not shown.</li> : null}
            {transcript.messages.map((m) => {
              const before = m.revisions.at(-1);
              return (
                <li
                  key={m.id}
                  className={`px-4 py-2.5 text-sm ${m.id === report.messageId ? "bg-phosphor/15" : ""} ${m.deletedAt ? "bg-red-500/5" : ""}`}
                >
                  <p className="text-xs text-ink-faint">
                    <strong className="text-ink">{name(m.senderId, m.kind)}</strong> · <LocalTime value={m.createdAt} mode="datetime-short" />
                    {m.deletedAt ? " · deleted" : ""}
                    {m.editedAt ? " · edited" : ""}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-ink-soft">
                    {m.deletedAt ? `[deleted] ${text(before?.body ?? "")}` : text(m.body)}
                  </p>
                  <Files
                    files={m.deletedAt ? (before?.attachments ?? []) : m.attachments}
                    href={(a, i) => (m.deletedAt ? fileHref(a) : chatFileHref(m.id, i))}
                  />
                  {/* A delete's revision is shown above; what's left are the edits before it. */}
                  <Versions revisions={m.deletedAt ? m.revisions.slice(0, -1) : m.revisions} text={text} fileHref={fileHref} />
                </li>
              );
            })}
            {transcript.messages.length === 0 ? <li className="px-4 py-3 text-sm text-ink-faint">No messages.</li> : null}
            {transcript.hasMoreAfter ? <li className="px-4 py-2 text-xs text-ink-faint">Later messages not shown.</li> : null}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

async function load(id: string, viewerId: string, caps: Parameters<typeof getChatViewer>[1]) {
  const viewer = await getChatViewer(viewerId, caps);
  const report = await getReport(id, viewer);
  if (!report) return null;
  const channel = report.channelId ? await getChannelRow(report.channelId) : null;
  const [members, all, transcript, reported, revisions] = await Promise.all([
    channel ? listMembers([channel.id]).then((m) => m.get(channel.id) ?? []) : Promise.resolve([] as string[]),
    channel ? listReportsForChannel(channel.id, viewer) : Promise.resolve([report]),
    channel
      ? listTranscript(channel.id, { around: report.messageId, limit: TRANSCRIPT_WINDOW })
      : Promise.resolve({ messages: [], hasMoreBefore: false, hasMoreAfter: false }),
    report.messageId ? getMessageRow(report.messageId) : Promise.resolve(null),
    report.messageId ? listRevisions(report.messageId) : Promise.resolve([] as Revision[]),
  ]);
  // A moderator sees every name in the evidence, mentions included.
  const mentioned = (body: string) => Array.from(body.matchAll(/<@([0-9a-f-]{36})>/gi), (m) => m[1].toLowerCase());
  const people = await getPeople([
    ...members,
    ...transcript.messages.flatMap((m) => [m.senderId, ...mentioned(m.body), ...m.revisions.flatMap((r) => mentioned(r.body))]),
    ...(reported ? [reported.sender_id, ...mentioned(reported.body ?? "")] : []),
    ...revisions.flatMap((r) => mentioned(r.body)),
  ]);

  // Who the controls can mute: the reported message's sender, or for a
  // whole conversation everyone in it but the reporter. Never staff.
  const targetIds = reported
    ? [reported.sender_id].filter((x): x is string => !!x)
    : channel && channel.kind !== "channel"
      ? members.filter((m) => m !== report.reporterId)
      : [];
  const now = Date.now();
  const mutes: MuteTarget[] = (
    await Promise.all(
      targetIds.map(async (uid) => {
        const person: ChatPerson | undefined = people.get(uid);
        if (!person || person.isStaff) return null;
        const mute = await getMute(uid);
        return { userId: uid, name: person.name, muted: muteActive(mute, now), until: mute?.until ?? null };
      }),
    )
  ).filter((m): m is MuteTarget => !!m);

  return { report, channel, members, all, transcript, reported, revisions, people, mutes };
}

/** A message's files: the live route for a message still up, the moderator route for a deleted one's. */
function Files({ files, href }: { files: ChatAttachment[]; href: (a: ChatAttachment, i: number) => string }) {
  if (files.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {files.map((a, i) => (
        <li key={`${a.path}-${i}`}>
          <a href={href(a, i)} target="_blank" rel="noopener noreferrer" className="link-ink break-all">
            {a.name}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Every earlier version: before each edit, and what it said before a delete. */
function Versions({
  revisions,
  text,
  fileHref,
}: {
  revisions: Revision[];
  text: (body: string) => string;
  fileHref: (a: ChatAttachment) => string;
}) {
  if (revisions.length === 0) return null;
  return (
    <details className="mt-2 text-xs text-ink-soft">
      <summary className="cursor-pointer">Earlier versions ({revisions.length})</summary>
      <ul className="mt-2 space-y-2">
        {revisions.map((r, i) => (
          <li key={i} className="rounded border border-line p-2">
            <span className="font-mono text-[10px] text-ink-faint">
              {r.reason === "delete" ? "before delete" : "before edit"} · <LocalTime value={r.createdAt} mode="datetime-short" />
            </span>
            <p className="mt-1 whitespace-pre-wrap break-words">{text(r.body) || "(no text)"}</p>
            <Files files={r.attachments} href={(a) => fileHref(a)} />
          </li>
        ))}
      </ul>
    </details>
  );
}
