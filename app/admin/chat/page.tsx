import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/auth";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { getChatViewer, getChannelRow, listAllChannels, listMembers, listReports, getPeople, type ChannelRow, type ChatReport } from "@/lib/chat";
import { ChannelAdmin, type ChannelAdminRow } from "./channel-admin";

export const metadata = { title: "Chat · Admin" };
export const dynamic = "force-dynamic";

/**
 * Running batch0 Chat: every text channel (create, edit, archive, delete,
 * extra members), and the report queue. DMs and groups don't appear here —
 * there is no staff view of them until one is reported, and then it's the
 * report, below.
 */
export default async function AdminChatPage(props: { searchParams?: Promise<{ reports?: string }> }) {
  const sp = (await props.searchParams) ?? {};
  const { profile, caps } = await requirePermission("chat.manage");
  const status = sp.reports === "closed" ? "closed" : "open";

  let channels: ChannelRow[];
  try {
    channels = await listAllChannels();
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="font-display text-3xl text-ink">Chat</h1>
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            Chat isn&apos;t set up yet. Run migration <code>0101_chat.sql</code> in the Supabase SQL editor
            (see docs/chat.md); this page fills in once it has.
          </p>
        </Card>
      </div>
    );
  }

  const admin = createAdminClient();
  const viewer = await getChatViewer(profile.id, caps);
  const [cohorts, teams, members, reports] = await Promise.all([
    admin.from("cohorts").select("id, name, status").order("starts_on", { ascending: false }),
    admin.from("teams").select("id, name, cohort_id").order("name").limit(1000),
    listMembers(channels.map((c) => c.id)),
    status === "open"
      ? listReports(viewer, "open")
      : Promise.all([listReports(viewer, "actioned"), listReports(viewer, "dismissed")]).then(([a, d]) =>
          [...a, ...d].sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1)).slice(0, 100),
        ),
  ]);
  const cohortName = new Map(((cohorts.data ?? []) as any[]).map((c) => [c.id, c.name as string]));
  const teamName = new Map(((teams.data ?? []) as any[]).map((t) => [t.id, t.name as string]));
  const memberIds = Array.from(new Set(Array.from(members.values()).flat()));
  const people = await getPeople(memberIds);

  const rows: ChannelAdminRow[] = channels.map((c) => ({
    id: c.id,
    name: c.name ?? "",
    topic: c.topic,
    audience: c.audience,
    cohortId: c.cohortId,
    teamId: c.teamId,
    audienceLabel:
      c.audience === "cohort"
        ? `Cohort: ${cohortName.get(c.cohortId ?? "") ?? "?"}`
        : c.audience === "team"
          ? `Team: ${teamName.get(c.teamId ?? "") ?? "?"}`
          : c.audience === "everyone"
            ? "Everyone let in"
            : c.audience === "staff"
              ? "Staff only"
              : "Members only",
    posting: c.posting,
    slowmodeSeconds: c.slowmodeSeconds,
    position: c.position,
    system: !!c.systemKey,
    archived: !!c.archivedAt,
    messageCount: c.messageCount,
    lastMessageAt: c.lastMessageAt,
    members: (members.get(c.id) ?? []).map((id) => ({ id, name: people.get(id)?.name ?? "Deleted account" })),
  }));

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl text-ink">Chat</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Channels and the report queue. People use chat at{" "}
            <Link href="/chat" className="link-ink" prefetch={false}>/chat</Link>.
          </p>
        </div>
        <Link href="/chat" prefetch={false} className="text-sm link-ink">Open chat →</Link>
      </div>

      <ReportQueue reports={reports} status={status} />

      <ChannelAdmin
        rows={rows}
        cohorts={((cohorts.data ?? []) as any[]).map((c) => ({ id: c.id, name: c.name }))}
        teams={((teams.data ?? []) as any[]).map((t) => ({ id: t.id, name: t.name }))}
      />
    </div>
  );
}

async function ReportQueue({ reports, status }: { reports: ChatReport[]; status: "open" | "closed" }) {
  const channels = new Map<string, ChannelRow | null>();
  await Promise.all(
    Array.from(new Set(reports.map((r) => r.channelId))).map(async (id) => channels.set(id, await getChannelRow(id).catch(() => null))),
  );
  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
          Reports {status === "open" ? `· ${reports.length} open` : "· closed"}
        </h2>
        <Link href={status === "open" ? "/admin/chat?reports=closed" : "/admin/chat"} className="text-xs link-ink" prefetch={false}>
          {status === "open" ? "Closed reports" : "Open reports"}
        </Link>
      </div>
      {reports.length === 0 ? (
        <Card className="mt-3">
          <p className="text-sm text-ink-soft">{status === "open" ? "Nothing to review." : "No closed reports yet."}</p>
        </Card>
      ) : (
        <ul className="mt-3 divide-y divide-line rounded-md border border-line">
          {reports.map((r) => {
            const c = channels.get(r.channelId);
            const where = !c ? "a deleted channel" : c.kind === "channel" ? `#${c.name}` : c.kind === "dm" ? "a direct message" : "a group DM";
            return (
              <li key={r.id}>
                <Link href={`/admin/chat/reports/${r.id}`} prefetch={false} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 hover:bg-wash">
                  <span className="text-sm font-medium text-ink">{r.messageId ? "Message" : "Conversation"} in {where}</span>
                  <span className="text-xs text-ink-faint">reported by {r.reporterName}</span>
                  <span className="ml-auto font-mono text-[11px] text-ink-faint">
                    {r.status !== "open" ? `${r.status} · ` : ""}
                    <LocalTime value={r.createdAt} mode="datetime-short" />
                  </span>
                  <span className="w-full truncate text-sm text-ink-soft">{r.reason}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
