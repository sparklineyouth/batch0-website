import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import {
  Mail,
  Eye,
  MousePointerClick,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";

export const metadata = { title: "Email metrics · Admin" };
export const dynamic = "force-dynamic";

type EventRow = {
  event_type: string;
  subject: string | null;
  resend_email_id: string | null;
  occurred_at: string;
};

// Pretty-printable buckets for the per-template breakdown. We don't tag
// sends on the wire, so the only stable key is the subject — strip
// dynamic suffixes ("for Jane Doe", "$97", etc.) by grouping on the
// part before the first " — ", " · ", " for ", or numeric tail.
function normalizeSubject(s: string | null): string {
  if (!s) return "(unknown)";
  return s
    .replace(/\s[—·-]\s.*$/, "")
    .replace(/\s(for|to)\s.+$/i, "")
    .trim()
    .slice(0, 80);
}

function fmtPct(num: number, denom: number) {
  if (denom <= 0) return "—";
  return `${Math.round((num / denom) * 100)}%`;
}

export default async function AdminEmailMetricsPage() {
  const admin = createAdminClient();

  // Pull the last 30 days of events. Beyond that, the daily chart
  // becomes noise and we'd want to switch to a materialized rollup.
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);

  const { data: events, error } = await admin
    .from("email_events")
    .select("event_type, subject, resend_email_id, occurred_at")
    .gte("occurred_at", thirtyDaysAgo.toISOString())
    .order("occurred_at", { ascending: false })
    .limit(20000);

  // The table only exists if migration 0024 has been run. Until then,
  // show a setup screen instead of crashing the admin panel.
  if (error && /relation .*email_events.* does not exist/i.test(error.message)) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-bold tracking-tight">Email metrics</h1>
        <Card className="mt-6">
          <p className="text-sm text-white/70">
            Run migration{" "}
            <code className="font-mono text-spark">
              0024_email_events.sql
            </code>{" "}
            in your Supabase SQL editor, then set{" "}
            <code className="font-mono text-spark">
              RESEND_WEBHOOK_SECRET
            </code>{" "}
            and add a webhook in the Resend dashboard pointing at{" "}
            <code className="font-mono text-spark">
              /api/resend/webhook
            </code>
            . Subscribe to <em>delivered, opened, clicked, bounced,
            complained</em>.
          </p>
        </Card>
      </div>
    );
  }

  const rows = (events ?? []) as EventRow[];

  // Counts by event type for the hero strip. We treat "email.sent" and
  // "email.delivered" as the denominator for engagement rates — sent
  // covers the case where deliveries are still in flight; we prefer
  // delivered when present and fall back otherwise.
  const counts = {
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    bounced: 0,
    complained: 0,
  };
  for (const r of rows) {
    if (r.event_type === "email.sent") counts.sent++;
    else if (r.event_type === "email.delivered") counts.delivered++;
    else if (r.event_type === "email.opened") counts.opened++;
    else if (r.event_type === "email.clicked") counts.clicked++;
    else if (r.event_type === "email.bounced") counts.bounced++;
    else if (r.event_type === "email.complained") counts.complained++;
  }

  const deliveredDenom = counts.delivered || counts.sent;

  // Unique opens / clicks per email_id — Resend fires one event per
  // open / click which inflates rates if a user opens the same mail
  // twice. We dedupe by resend_email_id for the headline numbers but
  // keep the raw counts available below.
  const openedEmails = new Set<string>();
  const clickedEmails = new Set<string>();
  for (const r of rows) {
    if (!r.resend_email_id) continue;
    if (r.event_type === "email.opened") openedEmails.add(r.resend_email_id);
    else if (r.event_type === "email.clicked")
      clickedEmails.add(r.resend_email_id);
  }
  const uniqueOpened = openedEmails.size;
  const uniqueClicked = clickedEmails.size;

  // Per-template breakdown — group by normalized subject. Each "send"
  // is keyed by the resend_email_id so we don't double-count when the
  // delivered event arrives.
  type Template = {
    subject: string;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    bounced: number;
  };
  const byTemplate = new Map<string, Template>();
  const seenSendIds = new Set<string>();

  for (const r of rows) {
    const key = normalizeSubject(r.subject);
    const t = byTemplate.get(key) ?? {
      subject: key,
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
    };
    if (
      (r.event_type === "email.sent" || r.event_type === "email.delivered") &&
      r.resend_email_id
    ) {
      // Count a unique "send" per email_id so retries / deliveries don't
      // double the denominator.
      const dedupeKey = `${key}:${r.resend_email_id}`;
      if (!seenSendIds.has(dedupeKey)) {
        seenSendIds.add(dedupeKey);
        if (r.event_type === "email.sent") t.sent++;
        else t.delivered++;
      }
    } else if (r.event_type === "email.opened") t.opened++;
    else if (r.event_type === "email.clicked") t.clicked++;
    else if (r.event_type === "email.bounced") t.bounced++;
    byTemplate.set(key, t);
  }
  const templates = Array.from(byTemplate.values())
    .filter((t) => t.sent + t.delivered > 0)
    .sort((a, b) => b.sent + b.delivered - (a.sent + a.delivered));

  // Daily chart series — last 14 days, sent + opened side by side.
  const days: { key: string; sent: number; opened: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    days.push({
      key: d.toISOString().slice(0, 10),
      sent: 0,
      opened: 0,
    });
  }
  const dayIdx = new Map(days.map((d, i) => [d.key, i] as const));
  for (const r of rows) {
    const k = r.occurred_at.slice(0, 10);
    const idx = dayIdx.get(k);
    if (idx == null) continue;
    if (r.event_type === "email.sent" || r.event_type === "email.delivered")
      days[idx].sent++;
    else if (r.event_type === "email.opened") days[idx].opened++;
  }
  const maxDay = Math.max(1, ...days.map((d) => Math.max(d.sent, d.opened)));

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Email metrics</h1>
          <p className="mt-1 text-sm text-white/55">
            Open and click rates from the last 30 days of Resend events.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-[11px] text-white/40">
            {rows.length.toLocaleString()} events ingested
          </p>
          <a
            href="/admin/email/blast"
            className="inline-flex items-center gap-1.5 rounded-lg bg-spark px-3 py-1.5 text-xs font-semibold text-black hover:bg-spark-200"
          >
            Compose blast
          </a>
        </div>
      </div>

      <section className="mt-6 grid gap-3 md:grid-cols-5">
        <Tile
          icon={Mail}
          label="Sent / delivered"
          value={String(deliveredDenom)}
          hint={`${counts.sent} sent · ${counts.delivered} delivered`}
        />
        <Tile
          icon={Eye}
          label="Open rate"
          value={fmtPct(uniqueOpened, deliveredDenom)}
          hint={`${uniqueOpened} unique opens`}
        />
        <Tile
          icon={MousePointerClick}
          label="Click rate"
          value={fmtPct(uniqueClicked, deliveredDenom)}
          hint={`${uniqueClicked} unique clicks`}
        />
        <Tile
          icon={AlertTriangle}
          label="Bounced"
          value={String(counts.bounced)}
          tone={counts.bounced > 0 ? "warn" : "ok"}
        />
        <Tile
          icon={CheckCircle2}
          label="Complained"
          value={String(counts.complained)}
          tone={counts.complained > 0 ? "bad" : "ok"}
        />
      </section>

      <Card className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
          Last 14 days
        </h2>
        <p className="mt-1 text-xs text-white/40">
          Sent vs opened. Tall sent bars with short opens = subject lines
          need work.
        </p>
        <div className="mt-6 flex items-end gap-2 h-32">
          {days.map((d) => (
            <div
              key={d.key}
              className="flex min-w-0 flex-1 flex-col items-stretch gap-1"
            >
              <div className="flex h-full items-end gap-[2px]">
                <div
                  title={`${d.key} · ${d.sent} sent`}
                  className="flex-1 rounded-t bg-spark/50"
                  style={{
                    height: `${Math.max(2, Math.round((d.sent / maxDay) * 100))}%`,
                  }}
                />
                <div
                  title={`${d.key} · ${d.opened} opened`}
                  className="flex-1 rounded-t bg-emerald-400/70"
                  style={{
                    height: `${Math.max(1, Math.round((d.opened / maxDay) * 100))}%`,
                  }}
                />
              </div>
              <div className="text-[9px] tabular-nums text-white/40 text-center">
                {d.key.slice(5)}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-4 text-[10px] text-white/55">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded bg-spark/50" /> Sent
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded bg-emerald-400/70" />{" "}
            Opened
          </span>
        </div>
      </Card>

      <Card className="mt-6 !p-0 overflow-hidden">
        <div className="border-b border-white/10 px-5 py-3 text-xs uppercase tracking-wider text-white/40">
          By template
        </div>
        {templates.length === 0 ? (
          <p className="p-6 text-sm text-white/55">
            No engagement data yet. Once a few delivered events come in,
            they'll show up grouped by subject here.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/40">
                <th className="px-5 py-3">Template</th>
                <th className="px-5 py-3 text-right">Sent</th>
                <th className="px-5 py-3 text-right">Open rate</th>
                <th className="px-5 py-3 text-right">Click rate</th>
                <th className="px-5 py-3 text-right">Bounced</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => {
                const denom = t.delivered || t.sent;
                return (
                  <tr
                    key={t.subject}
                    className="border-b border-white/5 last:border-0"
                  >
                    <td className="px-5 py-3 text-white">{t.subject}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-white/75">
                      {denom}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-white/75">
                      {fmtPct(t.opened, denom)}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-white/75">
                      {fmtPct(t.clicked, denom)}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">
                      <span
                        className={
                          t.bounced > 0 ? "text-red-300" : "text-white/30"
                        }
                      >
                        {t.bounced}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
}: {
  icon: any;
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "ok" | "warn" | "bad";
}) {
  const colors = {
    default: "text-white",
    ok: "text-emerald-300",
    warn: "text-amber-300",
    bad: "text-red-300",
  } as const;
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-4">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-white/45">
        <Icon className={`h-3.5 w-3.5 ${tone !== "default" ? colors[tone] : ""}`} />
        {label}
      </div>
      <div className={`mt-2 text-2xl font-semibold tracking-tight ${colors[tone]}`}>
        {value}
      </div>
      {hint && <div className="mt-1 text-[11px] text-white/45">{hint}</div>}
    </div>
  );
}
