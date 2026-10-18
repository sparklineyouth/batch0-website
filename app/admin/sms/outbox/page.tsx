import Link from "next/link";
import { Inbox } from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { smsTransportStatus } from "@/lib/sms/send";
import { MAX_ATTEMPTS } from "@/lib/sms/queue";
import { SmsOutboxTable, SmsQueueControls, type SmsOutboxRow } from "./outbox-table";

export const metadata = { title: "SMS outbox · Admin" };
export const dynamic = "force-dynamic";

const STATUSES = [
  "all",
  "pending",
  "sending",
  "sent",
  "failed",
  "skipped",
  "canceled",
] as const;
type StatusFilter = (typeof STATUSES)[number];

const PAGE_LIMIT = 200;

type Campaign = { id: string; name: string; status: string };

const STATUS_CHIP: Record<string, string> = {
  pending: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  sending: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  sent: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  canceled: "border-line bg-wash text-ink-faint",
  skipped: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

/** One URL builder, so a status click keeps the campaign filter and vice versa. */
function hrefFor(status: StatusFilter, campaign: string | null) {
  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  if (campaign) params.set("campaign", campaign);
  return `/admin/sms/outbox${params.toString() ? `?${params}` : ""}`;
}

export default async function SmsOutboxPage(props: {
  searchParams: Promise<{ status?: string; campaign?: string }>;
}) {
  const searchParams = await props.searchParams;
  const admin = createAdminClient();

  const statusFilter: StatusFilter =
    (STATUSES.find((s) => s === searchParams.status) as StatusFilter) ?? "all";
  const campaignId = searchParams.campaign?.trim() || null;

  let listQuery = admin
    .from("sms_outbox")
    .select(
      "id, to_phone, to_name, segments, status, attempts, last_error, send_after, sent_at, template_key, campaign_id",
    )
    // By send_after rather than created_at: the queue's own order is the point of
    // the page, and something queued today for next week belongs at the bottom.
    .order("send_after", { ascending: false })
    .limit(PAGE_LIMIT);
  if (statusFilter !== "all") listQuery = listQuery.eq("status", statusFilter);
  if (campaignId) listQuery = listQuery.eq("campaign_id", campaignId);

  // Counts come from their own skinny scan, NOT from the visible page. Deriving
  // them from a filtered, 200-row list would make the chips report the filter
  // back to itself — "3 failed" while looking at failures only, whatever the
  // real number is.
  let countQuery = admin.from("sms_outbox").select("status").limit(5000);
  if (campaignId) countQuery = countQuery.eq("campaign_id", campaignId);

  const [{ data: rows, error }, { data: countRows }, transport] = await Promise.all([
    listQuery,
    countQuery,
    smsTransportStatus(),
  ]);

  if (error && isMissingSchemaError(error)) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
          Outbox
        </h1>
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            Texting isn&rsquo;t set up yet: migration{" "}
            <code className="font-mono text-phosphor-ink">
              0106_sms_messaging.sql
            </code>{" "}
            creates the send queue, the consent ledger and the settings row.
            Until it runs nothing queues, nothing sends, and no number can be
            opted in. See <code className="font-mono">docs/sms.md</code>.
          </p>
        </Card>
      </div>
    );
  }

  const list = (rows ?? []) as {
    id: string;
    to_phone: string;
    to_name: string | null;
    segments: number | null;
    status: string;
    attempts: number | null;
    last_error: string | null;
    send_after: string;
    sent_at: string | null;
    template_key: string | null;
    campaign_id: string | null;
  }[];

  const counts = ((countRows ?? []) as { status: string }[]).reduce<
    Record<string, number>
  >((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const total = (countRows ?? []).length;

  // Campaign names, for the row subtitle and for the filter banner. Fetched for
  // the ids actually on screen plus the filtered one, so a campaign whose rows
  // have all drained still names itself in the header.
  const campaignIds = new Set(
    list.map((r) => r.campaign_id).filter((id): id is string => Boolean(id)),
  );
  if (campaignId) campaignIds.add(campaignId);
  const campaignsById = new Map<string, Campaign>();
  if (campaignIds.size > 0) {
    const { data: campaignRows } = await admin
      .from("sms_campaigns")
      .select("id, name, status")
      .in("id", [...campaignIds]);
    for (const c of (campaignRows ?? []) as Campaign[]) campaignsById.set(c.id, c);
  }
  const focused = campaignId ? (campaignsById.get(campaignId) ?? null) : null;

  const tableRows: SmsOutboxRow[] = list.map((r) => ({
    id: r.id,
    toPhone: r.to_phone,
    toName: r.to_name,
    segments: r.segments ?? 1,
    status: r.status,
    attempts: r.attempts ?? 0,
    lastError: r.last_error,
    sendAfter: r.send_after,
    sentAt: r.sent_at,
    templateKey: r.template_key,
    campaignId: r.campaign_id,
    campaignName: r.campaign_id
      ? (campaignsById.get(r.campaign_id)?.name ?? null)
      : null,
  }));

  return (
    <div className="mx-auto max-w-6xl pb-16">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            Outbox
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            Every text, queued and sent. A <strong>skipped</strong> row is
            usually the consent gate doing its job — the drain re-checks consent
            at send time, so a STOP that arrives after a campaign is queued stops
            the rest of it. Anything still pending can be cancelled; once
            it&rsquo;s sent, it&rsquo;s on somebody&rsquo;s phone.
          </p>
        </div>
        <SmsQueueControls
          pendingCount={counts.pending ?? 0}
          campaign={focused}
        />
      </div>

      {/* Why nothing is draining, said once, where the question comes up. */}
      {!transport.ok && (
        <Card className="mt-5 border-amber-500/30 bg-amber-500/5">
          <p className="text-sm text-ink-soft">
            <strong className="text-ink">Nothing is being sent.</strong>{" "}
            {transport.detail} Due messages pile up here rather than going out —
            nothing is lost. Fix it at{" "}
            <Link href="/admin/sms/settings" className="underline">
              SMS settings
            </Link>
            .
          </p>
        </Card>
      )}

      {focused && (
        <Card className="mt-5">
          <p className="text-sm text-ink-soft">
            Filtered to campaign{" "}
            <strong className="text-ink">{focused.name}</strong> (
            {focused.status}).{" "}
            <Link href={hrefFor(statusFilter, null)} className="underline">
              Show every message
            </Link>
          </p>
        </Card>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        <Link
          href={hrefFor("all", campaignId)}
          aria-current={statusFilter === "all" ? "page" : undefined}
          className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${
            statusFilter === "all"
              ? "border-phosphor text-ink"
              : "border-line text-ink-soft hover:text-ink"
          }`}
        >
          All {total.toLocaleString()}
        </Link>
        {STATUSES.filter((s) => s !== "all" && (counts[s] ?? 0) > 0).map((s) => (
          <Link
            key={s}
            href={hrefFor(s, campaignId)}
            aria-current={statusFilter === s ? "page" : undefined}
            className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${
              statusFilter === s
                ? (STATUS_CHIP[s] ?? "border-line text-ink")
                : "border-line text-ink-soft hover:text-ink"
            }`}
          >
            {counts[s]} {s}
          </Link>
        ))}
      </div>

      <Card className="mt-6 !p-0 overflow-hidden">
        {tableRows.length === 0 ? (
          <div className="p-10 text-center">
            <Inbox className="mx-auto h-8 w-8 text-ink-faint" />
            <p className="mt-3 text-sm text-ink-soft">
              {statusFilter === "all" && !campaignId
                ? "Nothing here yet. Every text this program sends lands in this table, whether it queued first or went straight out."
                : "No messages match that filter."}
            </p>
          </div>
        ) : (
          <SmsOutboxTable rows={tableRows} maxAttempts={MAX_ATTEMPTS} />
        )}
      </Card>

      {tableRows.length === PAGE_LIMIT && (
        <p className="mt-3 text-xs text-ink-faint">
          Showing the {PAGE_LIMIT} most recent rows for this filter.
        </p>
      )}
      {error && !isMissingSchemaError(error) && (
        <p className="mt-3 text-xs text-red-500">
          The queue could not be read: {error.message}
        </p>
      )}
    </div>
  );
}
