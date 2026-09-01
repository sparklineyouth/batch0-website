import Link from "next/link";
import { Inbox } from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { isMissingTable } from "@/lib/email/store";
import { getEmailSettings } from "@/lib/email/settings";
import { OutboxControls, RowAction } from "./outbox-controls";

export const metadata = { title: "Email outbox · Admin" };
export const dynamic = "force-dynamic";

// Queue-specific statuses; `StatusBadge` in components/ui/card.tsx doesn't
// model sending/skipped/canceled. `pending` deliberately matches the amber it
// wears everywhere else in the admin rather than inventing a second meaning
// for the same word.
const STATUS_STYLES: Record<string, string> = {
  pending: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  sending: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  sent: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  canceled: "border-line bg-wash text-ink-faint",
  skipped: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

export default async function EmailOutboxPage() {
  const admin = createAdminClient();
  const settings = await getEmailSettings();

  // Ordered by send_after, not created_at: the queue's own order is what the
  // page is for, and a drip queued today for next week belongs at the bottom.
  const { data: rows, error } = await admin
    .from("email_outbox")
    .select(
      "id, to_email, to_name, status, send_after, sent_at, attempts, last_error, created_at, template:email_templates(name), automation:email_automations(id, name)",
    )
    .order("send_after", { ascending: false })
    .limit(200);

  if (error && isMissingTable(error)) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
          Outbox
        </h1>
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            Run migration{" "}
            <code className="font-mono text-phosphor-ink">
              0052_email_automation.sql
            </code>{" "}
            to enable the send queue.
          </p>
        </Card>
      </div>
    );
  }

  const list = (rows ?? []) as any[];
  const pendingCount = list.filter((r) => r.status === "pending").length;
  const counts = list.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            Outbox
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            Every automated and scheduled email, before and after it goes out.
            Anything still pending can be cancelled — once it's sent, it's sent.
            The queue drains every five minutes; “Run queue now” doesn't wait.
          </p>
        </div>
        <OutboxControls pendingCount={pendingCount} />
      </div>

      {settings.automationsPaused && (
        <Card className="mt-5 border-amber-500/30 bg-amber-500/5">
          <p className="text-sm text-ink-soft">
            <strong className="text-ink">Sending is paused.</strong> Due mail is
            piling up here rather than going out. Resume at{" "}
            <Link href="/admin/email/settings" className="underline">
              email settings
            </Link>
            .
          </p>
        </Card>
      )}

      {Object.keys(counts).length > 0 && (
        <div className="mt-5 flex flex-wrap gap-2">
          {Object.entries(counts).map(([status, n]) => (
            <span
              key={status}
              className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${
                STATUS_STYLES[status] ?? "border-line text-ink-soft"
              }`}
            >
              {n} {status}
            </span>
          ))}
        </div>
      )}

      <Card className="mt-6 !p-0 overflow-hidden">
        {list.length === 0 ? (
          <div className="p-10 text-center">
            <Inbox className="mx-auto h-8 w-8 text-ink-faint" />
            <p className="mt-3 text-sm text-ink-soft">
              Nothing in the queue. Transactional email that sends immediately
              doesn't wait here — this fills up when an automation has a delay,
              or you schedule something for later.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-faint">
                  <th className="px-5 py-3">Recipient</th>
                  <th className="px-5 py-3">Email</th>
                  <th className="px-5 py-3">From</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Due / sent</th>
                  <th className="px-5 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => {
                  const template = Array.isArray(r.template) ? r.template[0] : r.template;
                  const automation = Array.isArray(r.automation)
                    ? r.automation[0]
                    : r.automation;
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-line last:border-0 hover:bg-wash"
                    >
                      <td className="px-5 py-3">
                        <div className="text-ink">{r.to_name || "—"}</div>
                        <div className="font-mono text-xs text-ink-faint">
                          {r.to_email}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-ink-soft">
                        {template?.name ?? <em className="text-ink-faint">one-off</em>}
                      </td>
                      <td className="px-5 py-3 text-ink-soft">
                        {automation ? (
                          <Link
                            href={`/admin/email/automations/${automation.id}`}
                            className="hover:underline"
                          >
                            {automation.name}
                          </Link>
                        ) : (
                          <span className="text-ink-faint">manual</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={`inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                            STATUS_STYLES[r.status] ?? "border-line text-ink-faint"
                          }`}
                        >
                          {r.status}
                        </span>
                        {r.last_error && (
                          <div
                            className="mt-1 max-w-[260px] truncate text-xs text-ink-faint"
                            title={r.last_error}
                          >
                            {r.last_error}
                          </div>
                        )}
                        {r.attempts > 1 && (
                          <div className="mt-0.5 text-xs text-ink-faint">
                            {r.attempts} attempts
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3 text-xs text-ink-soft">
                        <LocalTime
                          value={r.sent_at ?? r.send_after}
                          mode="datetime-short"
                        />
                      </td>
                      <td className="px-5 py-3">
                        <RowAction id={r.id} status={r.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {list.length === 200 && (
        <p className="mt-3 text-xs text-ink-faint">
          Showing the 200 most recent rows.
        </p>
      )}
    </div>
  );
}
