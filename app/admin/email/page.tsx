import { Suspense } from "react";
import Link from "next/link";
import {
  Mail,
  Eye,
  MousePointerClick,
  AlertTriangle,
  ShieldAlert,
  Send,
  Timer,
  Link2,
  Inbox,
  MonitorSmartphone,
  History,
} from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { env } from "@/lib/env";
import { getEmailSettings } from "@/lib/email/settings";
import {
  foldMessages,
  summarize,
  dailySeries,
  byTemplate,
  byBroadcast,
  topLinks,
  byClient,
  latency,
  problemRecipients,
  recentActivity,
  fmtPct,
  fmtDuration,
  type EmailEventRow,
} from "@/lib/email/metrics";
import {
  Bar,
  Chip,
  EmptyNote,
  LegendKey,
  PanelSkeleton,
  SectionHeading,
  ShareBar,
  TableShell,
  Tile,
  TONE_TEXT,
  type Tone,
} from "./metric-ui";
import {
  ProviderDiagnostics,
  ProviderFunnelPanel,
  DomainsPanel,
  WebhooksPanel,
  BroadcastsPanel,
  AudiencesPanel,
  ApiHealthPanel,
} from "./resend-panels";

export const metadata = { title: "Email metrics · Admin" };
export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;
const CHART_DAYS = 30;

/**
 * Everything migration 0057 added. Selected separately from the base columns so
 * a deploy that lands before `supabase db push` degrades to the old shape
 * instead of 400-ing the whole page — PostgREST rejects a select naming a
 * column that doesn't exist, and losing the dashboard for the length of a
 * migration window is a worse outcome than losing the link and client tables.
 */
const BASE_COLUMNS = "event_type, subject, recipient, resend_email_id, occurred_at";
const DETAIL_COLUMNS =
  "broadcast_id, template_key, bounce_type, bounce_subtype, bounce_message, click_link, user_agent, failure_reason";

/**
 * Industry thresholds, not ours: mailbox providers (Google and Yahoo's bulk
 * sender rules, and Resend's own acceptable-use policy) start filtering above
 * roughly 2% bounces and 0.1% complaints, and suspend accounts well before
 * 5% / 0.3%. Showing a raw count invites "eleven bounces, that's fine"; showing
 * it against the number that gets you blocked does not.
 */
const BOUNCE_WARN = 0.02;
const BOUNCE_BAD = 0.05;
const COMPLAINT_WARN = 0.001;
const COMPLAINT_BAD = 0.003;

function rateTone(v: number | null, warn: number, bad: number): Tone {
  if (v === null) return "default";
  if (v >= bad) return "bad";
  if (v >= warn) return "warn";
  return "ok";
}

export default async function AdminEmailMetricsPage() {
  const admin = createAdminClient();

  const windowStart = new Date();
  windowStart.setUTCDate(windowStart.getUTCDate() - WINDOW_DAYS);
  const sinceIso = windowStart.toISOString();

  const query = (columns: string) =>
    admin
      .from("email_events")
      .select(columns)
      .gte("occurred_at", sinceIso)
      .order("occurred_at", { ascending: false })
      .limit(20000);

  let { data: events, error } = await query(`${BASE_COLUMNS}, ${DETAIL_COLUMNS}`);
  let detailColumnsPresent = true;
  if (error && /column .* does not exist|could not find/i.test(error.message)) {
    detailColumnsPresent = false;
    ({ data: events, error } = await query(BASE_COLUMNS));
  }

  // The table only exists if migration 0024 has been run. Until then,
  // show a setup screen instead of crashing the admin panel.
  if (error && /relation .*email_events.* does not exist/i.test(error.message)) {
    return <MigrationNotice />;
  }

  const rows = (events ?? []) as unknown as EmailEventRow[];
  const webhookConfigured = Boolean(env.resendWebhookSecret);

  const messages = foldMessages(rows);
  const stats = summarize(messages.values());
  const series = dailySeries(rows, CHART_DAYS);
  const templates = byTemplate(messages.values());
  const links = topLinks(rows);
  const clients = byClient(rows);
  const speed = latency(messages.values());
  const problems = problemRecipients(rows);
  const feed = recentActivity(rows, 40);
  const broadcastEngagement = byBroadcast(messages.values());

  // Mail that failed before Resend ever saw it. It leaves no trace in
  // email_events by definition — the send never happened — so without this the
  // page can show a spotless delivery record while an automation has been
  // erroring into the queue for a week.
  const settings = await getEmailSettings();
  const { data: outboxRows } = await admin
    .from("email_outbox")
    .select("status")
    .gte("created_at", sinceIso)
    .limit(5000);
  const outbox = (outboxRows ?? []).reduce<Record<string, number>>((acc, r: any) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  const chartMax = Math.max(
    1,
    ...series.map((d) => Math.max(d.sent, d.delivered, d.opened, d.clicked)),
  );
  const proxiedOpens = clients
    .filter((c) => c.proxied)
    .reduce((n, c) => n + c.opens, 0);
  const totalClientOpens = clients.reduce((n, c) => n + c.opens, 0);

  return (
    <div className="mx-auto max-w-6xl pb-16">
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            Email metrics
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            The last {WINDOW_DAYS} days, from two independent sources: Resend&rsquo;s
            own record of every message, and the engagement events our webhook
            has collected. Where they disagree, the provider is right and the
            gap is a configuration problem.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-[11px] text-ink-faint">
            {rows.length.toLocaleString()} events · sending via{" "}
            {settings.transport === "smtp"
              ? `SMTP (${settings.smtpHost ?? "unconfigured"})`
              : "Resend"}
          </p>
          <Link
            href="/admin/email/blast"
            className="inline-flex items-center gap-1.5 rounded-lg bg-phosphor-fill px-3 py-1.5 text-xs font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-fill-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            Compose blast
          </Link>
        </div>
      </div>

      {/* Sending over SMTP means Resend sees nothing at all — worth saying
          before the reader interprets a page of zeros as a delivery failure. */}
      {settings.transport === "smtp" && (
        <Card className="mt-6 border-amber-500/30 bg-amber-500/5">
          <p className="text-sm text-ink">
            <strong>Mail is going out over SMTP, not Resend.</strong>{" "}
            <span className="text-ink-soft">
              SMTP has no delivery callbacks and no open or click tracking, so
              every engagement number below covers only what Resend sent while it
              was the active transport. Switch back at{" "}
              <Link href="/admin/email/settings" className="underline">
                email settings
              </Link>{" "}
              to resume collecting them.
            </span>
          </p>
        </Card>
      )}

      {!webhookConfigured && <WebhookSetupNotice />}

      {!detailColumnsPresent && (
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            Run migration{" "}
            <code className="font-mono text-phosphor-ink">
              0057_email_event_details.sql
            </code>{" "}
            to unlock per-template attribution, clicked-link and mail-client
            breakdowns, and bounce classification. Those sections are hidden
            until then; everything else on this page already works.
          </p>
        </Card>
      )}

      {/* Provider-verified configuration problems. Streamed — the API call
          behind it must never delay the numbers. */}
      <Suspense
        fallback={
          <Card className="mt-6">
            <PanelSkeleton rows={2} />
          </Card>
        }
      >
        <ProviderDiagnostics
          webhookSecretSet={webhookConfigured}
          delivered={stats.delivered}
          opened={stats.opened}
          clicked={stats.clicked}
          eventCount={rows.length}
        />
      </Suspense>

      {/* ---------------------------------------------------------------- */}
      <SectionHeading
        title="Headline"
        hint="Every rate counts messages, once each — not events. One person opening the same mail five times is one open."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          icon={Send}
          label="Messages sent"
          value={stats.sent.toLocaleString()}
          hint={`${stats.delivered.toLocaleString()} delivered · ${fmtPct(stats.deliveryRate)} delivery rate`}
        />
        <Tile
          icon={Eye}
          label="Open rate"
          value={fmtPct(stats.openRate)}
          hint={`${stats.opened.toLocaleString()} of ${stats.denom.toLocaleString()} opened · ${stats.totalOpens.toLocaleString()} opens total`}
        />
        <Tile
          icon={MousePointerClick}
          label="Click rate"
          value={fmtPct(stats.clickRate)}
          hint={`${fmtPct(stats.clickToOpenRate)} of openers clicked`}
        />
        <Tile
          icon={Timer}
          label="Time to open"
          value={fmtDuration(speed.toOpen)}
          hint={`median · delivery takes ${fmtDuration(speed.toDelivery)}`}
        />
        <Tile
          icon={AlertTriangle}
          label="Bounce rate"
          value={fmtPct(stats.bounceRate, 1)}
          tone={rateTone(stats.bounceRate, BOUNCE_WARN, BOUNCE_BAD)}
          hint={`${stats.hardBounced} permanent · ${stats.softBounced} transient · providers filter above 2%`}
        />
        <Tile
          icon={ShieldAlert}
          label="Complaint rate"
          value={fmtPct(stats.complaintRate, 2)}
          tone={rateTone(stats.complaintRate, COMPLAINT_WARN, COMPLAINT_BAD)}
          hint={`${stats.complained} marked as spam · keep under 0.1%`}
        />
        <Tile
          icon={Mail}
          label="Never delivered"
          value={String(stats.failed + stats.suppressed)}
          tone={stats.failed + stats.suppressed > 0 ? "warn" : "ok"}
          hint={`${stats.failed} failed · ${stats.suppressed} suppressed · ${stats.delayed} delayed`}
        />
        <Tile
          icon={Inbox}
          label="Queued locally"
          value={String(outbox.pending ?? 0)}
          tone={(outbox.failed ?? 0) > 0 ? "bad" : (outbox.pending ?? 0) > 0 ? "warn" : "ok"}
          hint={
            <>
              {outbox.failed ?? 0} failed · {outbox.sent ?? 0} sent ·{" "}
              <Link href="/admin/email/outbox" className="underline">
                outbox
              </Link>
              {settings.automationsPaused && " · sending is PAUSED"}
            </>
          }
        />
      </div>

      {/* ---------------------------------------------------------------- */}
      <SectionHeading
        title="Delivery funnel"
        hint="Resend's own view of every message it accepted from us, independent of our webhook. When the two halves of this page disagree, this is the one to believe."
      />
      <Suspense
        fallback={
          <Card className="mt-3">
            <PanelSkeleton rows={5} />
          </Card>
        }
      >
        <ProviderFunnelPanel />
      </Suspense>

      {/* ---------------------------------------------------------------- */}
      <SectionHeading
        title={`Last ${CHART_DAYS} days`}
        hint="Sent, delivered, opened and clicked — each message counted once per series per day. A gap in the sent bars is sending having stopped, not a rendering artefact."
      />
      <Card className="mt-3">
        {/* The fixed height sits on the BAR ROW, not on the row of columns: the
            bars' percentage heights resolve against this element, and a
            percentage against an `auto` height computes to zero — which is how
            this chart once rendered thirty invisible columns under a legend. */}
        <div className="flex items-end gap-[3px]">
          {series.map((d) => (
            <div key={d.key} className="flex min-w-0 flex-1 flex-col items-stretch gap-1">
              <div className="flex h-40 items-end gap-[1px]">
                <Bar
                  title={`${d.key} · ${d.sent} sent`}
                  value={d.sent}
                  max={chartMax}
                  className="bg-phosphor/45"
                />
                <Bar
                  title={`${d.key} · ${d.delivered} delivered`}
                  value={d.delivered}
                  max={chartMax}
                  className="bg-sky-400/70"
                />
                <Bar
                  title={`${d.key} · ${d.opened} opened`}
                  value={d.opened}
                  max={chartMax}
                  className="bg-emerald-400/70"
                />
                <Bar
                  title={`${d.key} · ${d.clicked} clicked`}
                  value={d.clicked}
                  max={chartMax}
                  className="bg-violet-400/70"
                />
              </div>
              {/* Every third label only — thirty dates in this width is a grey
                  smear that reads as decoration. Unlabelled columns get a
                  non-breaking space so they keep the same height and the bars
                  stay on one baseline. */}
              <div className="text-center text-[9px] tabular-nums text-ink-faint">
                {Number(d.key.slice(8, 10)) % 3 === 0 ? d.key.slice(5) : " "}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-[10px] text-ink-soft">
          <LegendKey color="bg-phosphor/45" label="Sent" />
          <LegendKey color="bg-sky-400/70" label="Delivered" />
          <LegendKey color="bg-emerald-400/70" label="Opened" />
          <LegendKey color="bg-violet-400/70" label="Clicked" />
          <span className="text-ink-faint">peak {chartMax.toLocaleString()}/day</span>
        </div>
      </Card>

      {/* ---------------------------------------------------------------- */}
      <SectionHeading
        title="By template"
        hint={
          templates.some((t) => t.exact)
            ? "Grouped by the template tag stamped on each send. Rows marked “subject” predate tagging or went out over SMTP, and are grouped by a normalized subject line instead."
            : "Grouped by a normalized subject line. Mail sent from now on carries a template tag, which groups exactly — these rows will sharpen as it comes through."
        }
      />
      <Card className="mt-3 !p-0 overflow-hidden">
        {templates.length === 0 ? (
          <EmptyNote>
            No engagement data yet. Templates appear here once a few delivered
            events come in.
          </EmptyNote>
        ) : (
          <TableShell
            head={
              <>
                <th className="px-5 py-3">Template</th>
                <th className="px-5 py-3 text-right">Sent</th>
                <th className="px-5 py-3 text-right">Delivered</th>
                <th className="px-5 py-3 text-right">Open</th>
                <th className="px-5 py-3 text-right">Click</th>
                <th className="px-5 py-3 text-right">CTOR</th>
                <th className="px-5 py-3 text-right">Bounced</th>
                <th className="px-5 py-3 text-right">Spam</th>
                <th className="px-5 py-3">Last sent</th>
              </>
            }
          >
            {templates.map((t) => (
              <tr key={t.label} className="border-b border-line last:border-0">
                <td className="px-5 py-3">
                  <span className="text-ink">{t.label}</span>
                  {!t.exact && (
                    <span className="ml-2 align-middle">
                      <Chip tone="muted" title="Grouped by subject line, not by template tag">
                        subject
                      </Chip>
                    </span>
                  )}
                </td>
                <td className="px-5 py-3 text-right tabular-nums text-ink-soft">
                  {t.sent.toLocaleString()}
                </td>
                <td className="px-5 py-3 text-right tabular-nums text-ink-faint">
                  {fmtPct(t.deliveryRate)}
                </td>
                <td className="px-5 py-3 text-right tabular-nums text-ink-soft">
                  {fmtPct(t.openRate)}
                </td>
                <td className="px-5 py-3 text-right tabular-nums text-ink-soft">
                  {fmtPct(t.clickRate)}
                </td>
                <td className="px-5 py-3 text-right tabular-nums text-ink-faint">
                  {fmtPct(t.clickToOpenRate)}
                </td>
                <td className="px-5 py-3 text-right tabular-nums">
                  <span className={t.bounced > 0 ? TONE_TEXT.bad : "text-ink-faint"}>
                    {t.bounced}
                  </span>
                </td>
                <td className="px-5 py-3 text-right tabular-nums">
                  <span className={t.complained > 0 ? TONE_TEXT.bad : "text-ink-faint"}>
                    {t.complained}
                  </span>
                </td>
                <td className="px-5 py-3 text-xs text-ink-faint">
                  <LocalTime value={t.lastSentAt} mode="datetime-short" />
                </td>
              </tr>
            ))}
          </TableShell>
        )}
      </Card>

      {/* ---------------------------------------------------------------- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionHeading
            title="Most clicked links"
            hint="Which link in the mail actually earned the click."
          />
          <Card className="mt-3 !p-0 overflow-hidden">
            {links.length === 0 ? (
              <EmptyNote>
                {detailColumnsPresent
                  ? "No clicks recorded yet. Click tracking has to be on for the sending domain, and links are only rewritten on mail sent after it was enabled."
                  : "Requires migration 0057."}
              </EmptyNote>
            ) : (
              <ul className="divide-y divide-line">
                {links.map((l) => (
                  <li key={l.url} className="px-5 py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-xs text-ink-soft"
                        title={l.url}
                      >
                        <Link2 className="mr-1.5 inline h-3 w-3 text-ink-faint" />
                        {l.url.replace(/^https?:\/\//, "")}
                      </span>
                      <span className="shrink-0 tabular-nums text-sm text-ink">
                        {l.clicks}
                        <span className="ml-1 text-[11px] text-ink-faint">
                          {l.messages === l.clicks ? "" : `· ${l.messages} people`}
                        </span>
                      </span>
                    </div>
                    <div className="mt-1.5">
                      <ShareBar
                        value={l.clicks}
                        max={links[0].clicks}
                        className="bg-violet-400/70"
                        label={`${l.clicks} clicks`}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div>
          <SectionHeading
            title="Opened with"
            hint="Mail client behind each open and click."
          />
          <Card className="mt-3 !p-0 overflow-hidden">
            {clients.length === 0 ? (
              <EmptyNote>
                {detailColumnsPresent
                  ? "No opens or clicks with a user agent yet."
                  : "Requires migration 0057."}
              </EmptyNote>
            ) : (
              <>
                <ul className="divide-y divide-line">
                  {clients.map((c) => (
                    <li key={c.client} className="px-5 py-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm text-ink-soft">
                          <MonitorSmartphone className="mr-1.5 inline h-3 w-3 text-ink-faint" />
                          {c.client}
                          {c.proxied && (
                            <span className="ml-2 align-middle">
                              <Chip tone="warn" title="This client pre-fetches tracking pixels">
                                proxied
                              </Chip>
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 tabular-nums text-sm text-ink">
                          {c.opens}
                          <span className="ml-1 text-[11px] text-ink-faint">
                            {totalClientOpens > 0
                              ? `${((c.opens / totalClientOpens) * 100).toFixed(0)}%`
                              : ""}
                          </span>
                        </span>
                      </div>
                      <div className="mt-1.5">
                        <ShareBar
                          value={c.opens}
                          max={clients[0].opens}
                          className={c.proxied ? "bg-amber-400/70" : "bg-emerald-400/70"}
                          label={`${c.client}: ${c.opens}`}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
                {proxiedOpens > 0 && (
                  <p className="border-t border-line px-5 py-3 text-[11px] leading-relaxed text-ink-faint">
                    <strong className="text-ink-soft">
                      {((proxiedOpens / totalClientOpens) * 100).toFixed(0)}% of
                      opens came from a client that pre-fetches images.
                    </strong>{" "}
                    Apple Mail Privacy Protection and Gmail&rsquo;s image proxy
                    load the tracking pixel whether or not a human ever looked at
                    the message, so treat the open rate above as a ceiling. The
                    click rate has no such problem — nothing clicks a link on
                    your behalf.
                  </p>
                )}
              </>
            )}
          </Card>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      <SectionHeading
        title="Addresses to deal with"
        hint="Bounces, spam complaints and suppressions. Permanent bounces should be removed from the list — repeatedly mailing a dead address is what turns a good sending reputation into a bad one."
      />
      <Card className="mt-3 !p-0 overflow-hidden">
        {problems.length === 0 ? (
          <EmptyNote>
            No bounces, complaints or suppressions in the last {WINDOW_DAYS} days.
          </EmptyNote>
        ) : (
          <TableShell
            head={
              <>
                <th className="px-5 py-3">Address</th>
                <th className="px-5 py-3">What happened</th>
                <th className="px-5 py-3">Detail</th>
                <th className="px-5 py-3">Message</th>
                <th className="px-5 py-3">When</th>
              </>
            }
          >
            {problems.map((p) => (
              <tr key={p.email} className="border-b border-line last:border-0">
                <td className="px-5 py-3 font-mono text-xs text-ink">{p.email}</td>
                <td className="px-5 py-3">
                  <Chip tone={p.kind === "complained" ? "bad" : "warn"}>{p.kind}</Chip>
                </td>
                <td className="max-w-[240px] truncate px-5 py-3 text-xs text-ink-soft" title={p.detail ?? ""}>
                  {p.detail ?? "—"}
                </td>
                <td className="max-w-[240px] truncate px-5 py-3 text-xs text-ink-faint" title={p.subject ?? ""}>
                  {p.subject ?? "—"}
                </td>
                <td className="px-5 py-3 text-xs text-ink-faint">
                  <LocalTime value={p.at} mode="datetime-short" />
                </td>
              </tr>
            ))}
          </TableShell>
        )}
      </Card>

      {/* ---------------------------------------------------------------- */}
      <SectionHeading
        title="Broadcasts"
        hint="Campaigns created in the Resend dashboard, matched against the events our webhook collected for them."
      />
      <Suspense
        fallback={
          <Card className="mt-3">
            <PanelSkeleton rows={3} />
          </Card>
        }
      >
        <BroadcastsPanel engagement={broadcastEngagement} />
      </Suspense>

      {/* ---------------------------------------------------------------- */}
      <SectionHeading
        title="Sending domains"
        hint="Verification state and the DNS records behind it. An unverified SPF or DKIM record is the single most common reason mail lands in spam."
      />
      <Suspense
        fallback={
          <Card className="mt-3">
            <PanelSkeleton rows={4} />
          </Card>
        }
      >
        <DomainsPanel />
      </Suspense>

      {/* ---------------------------------------------------------------- */}
      <SectionHeading
        title="Webhook subscriptions"
        hint="Which events Resend is actually forwarding. A metric on this page can only be as complete as its subscription."
      />
      <Suspense
        fallback={
          <Card className="mt-3">
            <PanelSkeleton rows={2} />
          </Card>
        }
      >
        <WebhooksPanel />
      </Suspense>

      {/* ---------------------------------------------------------------- */}
      <SectionHeading
        title="API health"
        hint="Calls this app made to Resend. A send Resend rejected produces no webhook event at all, so it is invisible everywhere else on this page."
      />
      <Suspense
        fallback={
          <Card className="mt-3">
            <PanelSkeleton rows={3} />
          </Card>
        }
      >
        <ApiHealthPanel />
      </Suspense>

      <Suspense fallback={null}>
        <AudiencesPanel />
      </Suspense>

      {/* ---------------------------------------------------------------- */}
      <SectionHeading
        title="Recent activity"
        hint="The raw event stream, newest first — what to read when a number above looks wrong."
      />
      <Card className="mt-3 !p-0 overflow-hidden">
        {feed.length === 0 ? (
          <EmptyNote>
            <History className="mr-1.5 inline h-4 w-4" />
            No events in the last {WINDOW_DAYS} days.
          </EmptyNote>
        ) : (
          <TableShell
            head={
              <>
                <th className="px-5 py-3">When</th>
                <th className="px-5 py-3">Event</th>
                <th className="px-5 py-3">Recipient</th>
                <th className="px-5 py-3">Subject</th>
                <th className="px-5 py-3">Detail</th>
              </>
            }
          >
            {feed.map((r, i) => {
              const kind = r.event_type.replace("email.", "");
              const detail =
                r.click_link ||
                r.bounce_message ||
                r.failure_reason ||
                [r.bounce_type, r.bounce_subtype].filter(Boolean).join(" · ");
              return (
                <tr
                  key={`${r.resend_email_id ?? "x"}-${r.occurred_at}-${i}`}
                  className="border-b border-line last:border-0"
                >
                  <td className="whitespace-nowrap px-5 py-2.5 text-xs text-ink-faint">
                    <LocalTime value={r.occurred_at} mode="datetime-short" />
                  </td>
                  <td className="px-5 py-2.5">
                    <Chip
                      tone={
                        ["bounced", "complained", "failed", "suppressed"].includes(kind)
                          ? "bad"
                          : ["opened", "clicked", "delivered"].includes(kind)
                            ? "ok"
                            : "default"
                      }
                    >
                      {kind.replace(/_/g, " ")}
                    </Chip>
                  </td>
                  <td className="max-w-[200px] truncate px-5 py-2.5 font-mono text-xs text-ink-soft">
                    {r.recipient ?? "—"}
                  </td>
                  <td className="max-w-[260px] truncate px-5 py-2.5 text-xs text-ink-soft" title={r.subject ?? ""}>
                    {r.subject ?? "—"}
                  </td>
                  <td
                    className="max-w-[240px] truncate px-5 py-2.5 text-xs text-ink-faint"
                    title={detail || ""}
                  >
                    {detail || "—"}
                  </td>
                </tr>
              );
            })}
          </TableShell>
        )}
      </Card>

      {rows.length >= 20000 && (
        <p className="mt-3 text-xs text-ink-faint">
          Capped at the 20,000 most recent events — at this volume the numbers
          above under-report and a materialized rollup is overdue.
        </p>
      )}
    </div>
  );
}

function MigrationNotice() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        Email metrics
      </h1>
      <Card className="mt-6">
        <p className="text-sm text-ink-soft">
          Run migrations{" "}
          <code className="font-mono text-phosphor-ink">0024_email_events.sql</code>{" "}
          and{" "}
          <code className="font-mono text-phosphor-ink">
            0057_email_event_details.sql
          </code>{" "}
          in your Supabase SQL editor, then set{" "}
          <code className="font-mono text-phosphor-ink">RESEND_WEBHOOK_SECRET</code>{" "}
          and add a webhook in the Resend dashboard pointing at{" "}
          <code className="font-mono text-phosphor-ink">/api/resend/webhook</code>.
        </p>
      </Card>
    </div>
  );
}

function WebhookSetupNotice() {
  return (
    <Card className="mt-6 border-amber-500/30 bg-amber-500/5">
      <p className="text-sm text-ink">
        <strong>No engagement data is being collected.</strong>{" "}
        <span className="text-ink-soft">
          <code className="font-mono text-phosphor-ink">RESEND_WEBHOOK_SECRET</code>{" "}
          isn&rsquo;t set, so{" "}
          <code className="font-mono text-phosphor-ink">/api/resend/webhook</code>{" "}
          rejects every event Resend sends with a 503. Sending still works, and
          the delivery funnel below still reads from the provider directly — but
          opens, clicks, bounce reasons and the activity feed all stay empty.
        </span>
      </p>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-ink-soft">
        <li>
          In the Resend dashboard, add a webhook pointing at{" "}
          <code className="font-mono text-phosphor-ink">
            {env.siteUrl}/api/resend/webhook
          </code>
        </li>
        <li>
          Subscribe to <em>sent, delivered, opened, clicked, bounced, complained,
          failed, delivery_delayed, suppressed</em>
        </li>
        <li>
          Copy its signing secret (it starts with{" "}
          <code className="font-mono">whsec_</code>) into{" "}
          <code className="font-mono text-phosphor-ink">RESEND_WEBHOOK_SECRET</code>,
          then redeploy
        </li>
      </ol>
    </Card>
  );
}
