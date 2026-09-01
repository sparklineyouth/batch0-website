import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  Globe,
  Radio,
  Megaphone,
  Activity,
  Users,
  Info,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { env } from "@/lib/env";
import {
  getResendInsights,
  providerFunnel,
  EMAIL_PAGE_CAP,
  REQUIRED_WEBHOOK_EVENTS,
  OPTIONAL_WEBHOOK_EVENTS,
} from "@/lib/email/resend-insights";
import {
  Chip,
  EmptyNote,
  SectionHeading,
  ShareBar,
  TableShell,
  Tile,
  TONE_TEXT,
  type Tone,
} from "./metric-ui";

/**
 * The half of /admin/email that comes from the Resend API rather than from our
 * own `email_events` table.
 *
 * Each panel is its own async server component so the page streams: the
 * database numbers paint immediately and these fill in as the provider answers,
 * instead of the whole dashboard waiting on the slowest of a dozen HTTP calls.
 * `getResendInsights()` is memoised, so six panels are still one fan-out.
 */

function since30Days(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString();
}

/* ------------------------------------------------------------------------- *
 * Diagnostics
 * ------------------------------------------------------------------------- */

/**
 * The "why are the numbers wrong" panel, and the reason the provider API is
 * worth calling at all.
 *
 * A zero open rate has three completely different causes that used to look
 * identical from the database: nobody opened the mail, the webhook isn't
 * subscribed to opens, or the domain has open tracking switched off (which is
 * Resend's default, and means the pixel is never injected in the first place).
 * The first is a copywriting problem and the other two are configuration bugs
 * that silently make every engagement number on this page a lie. Only the API
 * can tell them apart, so the heuristic is now a fallback for when the API is
 * unreachable rather than the primary signal.
 */
export async function ProviderDiagnostics({
  webhookSecretSet,
  delivered,
  opened,
  clicked,
  eventCount,
}: {
  webhookSecretSet: boolean;
  delivered: number;
  opened: number;
  clicked: number;
  eventCount: number;
}) {
  const insights = await getResendInsights();
  const problems: React.ReactNode[] = [];

  // --- Domain-level tracking flags -----------------------------------------
  // `sending: "disabled"` is a receive-only domain; its tracking flags say
  // nothing about the mail we send.
  const sendingDomains = insights.domains.filter((d) => d.sending !== "disabled");
  const domainsWithFlag = sendingDomains.filter((d) => d.openTracking !== null);
  const openTrackingOff = domainsWithFlag.filter((d) => d.openTracking === false);
  const clickTrackingOff = domainsWithFlag.filter((d) => d.clickTracking === false);

  if (openTrackingOff.length > 0 || clickTrackingOff.length > 0) {
    const off = [
      openTrackingOff.length > 0 ? "Open tracking" : null,
      clickTrackingOff.length > 0 ? "Click tracking" : null,
    ].filter(Boolean);
    const names = Array.from(
      new Set([...openTrackingOff, ...clickTrackingOff].map((d) => d.name)),
    );
    problems.push(
      <Problem
        key="tracking"
        tone="warn"
        title={`${off.join(" and ")} ${off.length > 1 ? "are" : "is"} off for ${names.join(", ")}.`}
      >
        Resend confirms this from the domain settings — it is not an inference
        from missing data. With tracking off, Resend never injects the pixel or
        rewrites links, so{" "}
        <code className="font-mono text-phosphor-ink">email.opened</code>
        {clickTrackingOff.length > 0 && (
          <>
            {" "}
            and <code className="font-mono text-phosphor-ink">email.clicked</code>
          </>
        )}{" "}
        can never fire and every engagement rate below will read zero no matter
        how the mail performs. Turn it on under{" "}
        <strong>Domains → {names[0]}</strong> in the Resend dashboard; only mail
        sent afterwards reports. Domain settings were last read at{" "}
        <LocalTime value={insights.configFetchedAt} mode="time" /> and are held
        for ten minutes, so this notice outlives the fix by a few minutes.
      </Problem>,
    );
  }

  // --- Domain verification --------------------------------------------------
  for (const d of insights.domains) {
    if (d.status === "verified") continue;
    const failing = d.records.filter((r) => r.status !== "verified");
    problems.push(
      <Problem
        key={`domain-${d.id}`}
        tone={d.status === "failed" || d.status === "partially_failed" ? "bad" : "warn"}
        title={`${d.name} is ${d.status.replace(/_/g, " ")}.`}
      >
        {failing.length > 0 ? (
          <>
            {failing.length} DNS record{failing.length === 1 ? "" : "s"} still
            unverified ({failing.map((r) => r.record).join(", ")}). Until they
            resolve, mail from this domain is far more likely to be filtered.
          </>
        ) : (
          <>Resend hasn&rsquo;t confirmed this domain yet.</>
        )}{" "}
        Records are listed under <em>Sending domains</em> below.
      </Problem>,
    );
  }

  // --- Webhook wiring -------------------------------------------------------
  const ours = insights.webhooks.filter((w) => w.isOurs);
  const subscribed = new Set(ours.flatMap((w) => w.events));

  if (insights.available && insights.webhooks.length === 0) {
    problems.push(
      <Problem key="zero-webhooks" tone="warn" title="This Resend account has no webhooks at all.">
        Resend is sending mail, but nothing is telling us what happened to it.
        The delivery funnel below still works — it reads the provider directly —
        while opens, clicks, bounce reasons and the activity feed have no source.
        Add one pointing at{" "}
        <code className="font-mono text-phosphor-ink">
          {env.siteUrl}/api/resend/webhook
        </code>
        .
      </Problem>,
    );
  } else if (insights.webhooks.length > 0 && ours.length === 0) {
    problems.push(
      <Problem key="no-webhook" tone="warn" title="No Resend webhook points at this site.">
        {insights.webhooks.length} webhook
        {insights.webhooks.length === 1 ? " is" : "s are"} configured on the
        account, but none of them target{" "}
        <code className="font-mono text-phosphor-ink">
          {env.siteUrl}/api/resend/webhook
        </code>
        . Everything on this page below the provider funnel is fed by that
        endpoint, so it will stay empty until one does.
      </Problem>,
    );
  } else if (ours.some((w) => w.status !== "enabled")) {
    problems.push(
      <Problem key="webhook-disabled" tone="bad" title="This site's webhook is disabled.">
        Resend has stopped delivering events to it — usually after a run of
        failed deliveries. Re-enable it in the dashboard; events that arrived
        while it was off are not replayed.
      </Problem>,
    );
  } else if (ours.length > 0) {
    const missingRequired = REQUIRED_WEBHOOK_EVENTS.filter(
      (e) => !subscribed.has(e),
    );
    const missingOptional = OPTIONAL_WEBHOOK_EVENTS.filter(
      (e) => !subscribed.has(e),
    );
    if (missingRequired.length > 0) {
      problems.push(
        <Problem
          key="webhook-events"
          tone="warn"
          title={`The webhook isn't subscribed to ${missingRequired.length} event type${missingRequired.length === 1 ? "" : "s"} this page needs.`}
        >
          Missing:{" "}
          {missingRequired.map((e, i) => (
            <span key={e}>
              {i > 0 && ", "}
              <code className="font-mono text-phosphor-ink">{e}</code>
            </span>
          ))}
          . Any metric derived from {missingRequired.length === 1 ? "it" : "them"}{" "}
          reads zero — which is indistinguishable from genuinely poor
          performance unless you know to look here.
        </Problem>,
      );
    }
    if (missingOptional.length > 0) {
      problems.push(
        <Problem
          key="webhook-optional"
          tone="default"
          title="Three newer event types aren't subscribed."
        >
          {missingOptional.map((e, i) => (
            <span key={e}>
              {i > 0 && ", "}
              <code className="font-mono text-phosphor-ink">{e}</code>
            </span>
          ))}{" "}
          — these cover mail that never left Resend at all. Without them a
          rejected send looks on this page like a delivery nobody opened.
        </Problem>,
      );
    }
  }

  // --- Fallback heuristic, only when the provider can't be reached ----------
  if (!insights.available && webhookSecretSet && delivered >= 3 && opened === 0 && clicked === 0) {
    problems.push(
      <Problem key="heuristic" tone="warn" title="Opens and clicks aren't being tracked.">
        {delivered} messages were delivered and not one open or click came back.
        That is the signature of open/click tracking being off for the sending
        domain, which is Resend&rsquo;s default. The provider API isn&rsquo;t
        reachable from here to confirm it — check <strong>Domains</strong> in
        the Resend dashboard.
      </Problem>,
    );
  }

  // --- API errors -----------------------------------------------------------
  if (insights.errors.length > 0) {
    problems.push(
      <Problem
        key="api-errors"
        tone="default"
        title={`${insights.errors.length} Resend API call${insights.errors.length === 1 ? "" : "s"} didn't return.`}
      >
        <ul className="mt-1 space-y-0.5">
          {insights.errors.slice(0, 5).map((e, i) => (
            <li key={i} className="font-mono text-[11px]">
              {e.source}: {e.message}
            </li>
          ))}
        </ul>
        Panels fed by those calls are missing rather than wrong — some endpoints
        aren&rsquo;t available on every Resend plan.
      </Problem>,
    );
  }

  if (problems.length > 0) return <div className="mt-6 space-y-3">{problems}</div>;

  // No problems found is only good news if the checks actually ran. An
  // unreachable API produces an empty domain list and an empty webhook list,
  // which finds nothing wrong for exactly the same reason a healthy account
  // does — printing a green tick over that is how a dashboard earns a
  // reputation for lying.
  if (!insights.available) {
    return (
      <Card className="mt-6">
        <p className="flex items-start gap-2 text-sm text-ink-soft">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
          <span>
            <strong className="text-ink">
              Configuration couldn&rsquo;t be verified against Resend.
            </strong>{" "}
            {insights.reason ??
              "The API didn't answer."}{" "}
            Nothing below is wrong because of it — the webhook-derived numbers
            still stand — but the domain, tracking and subscription checks
            didn&rsquo;t run.
          </span>
        </p>
      </Card>
    );
  }

  const verified = insights.domains.filter((d) => d.status === "verified").length;
  // Reachable, nothing broken, but nothing to affirm either — an account with
  // no domain of its own sends from resend.dev, which is fine for a test and
  // not something to award a green tick to.
  if (verified === 0) {
    return (
      <Card className="mt-6">
        <p className="flex items-start gap-2 text-sm text-ink-soft">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
          <span>
            <strong className="text-ink">No verified sending domain.</strong>{" "}
            Mail is going out from a Resend-owned address rather than one of
            ours, which caps deliverability and shows an odd sender to
            recipients. Nothing else looks misconfigured.
          </span>
        </p>
      </Card>
    );
  }

  return (
    <Card className="mt-6 border-emerald-500/25 bg-emerald-500/5">
      <p className="flex items-start gap-2 text-sm text-ink">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span>
          <strong>Delivery pipeline checks out.</strong>{" "}
          <span className="text-ink-soft">
            {verified} verified domain{verified === 1 ? "" : "s"}, tracking on,
            and this site&rsquo;s webhook is enabled and subscribed to
            everything the numbers below depend on.
            {eventCount === 0 &&
              " No events have arrived in the window yet — that only means nothing has been sent recently."}
          </span>
        </span>
      </p>
    </Card>
  );
}

function Problem({
  tone,
  title,
  children,
}: {
  tone: Tone;
  title: string;
  children: React.ReactNode;
}) {
  const border =
    tone === "bad"
      ? "border-red-500/30 bg-red-500/5"
      : tone === "warn"
        ? "border-amber-500/30 bg-amber-500/5"
        : "border-line";
  const Icon = tone === "default" ? Info : AlertTriangle;
  return (
    <Card className={border}>
      <p className="flex items-start gap-2 text-sm text-ink">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${TONE_TEXT[tone]}`} />
        <span>
          <strong>{title}</strong>{" "}
          <span className="text-ink-soft">{children}</span>
        </span>
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------------- *
 * Provider funnel
 * ------------------------------------------------------------------------- */

const STATUS_TONE: Record<string, Tone> = {
  delivered: "ok",
  opened: "ok",
  clicked: "ok",
  sent: "default",
  queued: "warn",
  scheduled: "warn",
  delivery_delayed: "warn",
  bounced: "bad",
  complained: "bad",
  failed: "bad",
  suppressed: "bad",
  canceled: "muted",
};

/**
 * Where every message currently stands according to Resend itself.
 *
 * This is the only section on the page that works with no webhook at all — it
 * reads each message's `last_event` straight from the provider. When the
 * webhook is misconfigured, this panel is the ground truth the rest of the page
 * should be checked against.
 */
export async function ProviderFunnelPanel() {
  const insights = await getResendInsights();
  if (!insights.available) {
    return (
      <Card className="mt-3">
        <p className="text-sm text-ink-soft">
          {insights.reason ??
            "The Resend API didn't answer, so the provider-side funnel is unavailable."}
        </p>
      </Card>
    );
  }

  const f = providerFunnel(insights.emails, since30Days());
  if (f.total === 0) {
    return (
      <Card className="mt-3">
        <p className="text-sm text-ink-soft">
          Resend has no record of mail sent from this account in the last 30
          days.
        </p>
      </Card>
    );
  }

  const steps = [
    { label: "Accepted by Resend", n: f.total, className: "bg-ink/25" },
    { label: "Left Resend", n: f.sent, className: "bg-phosphor/60" },
    { label: "Delivered", n: f.delivered, className: "bg-sky-400/70" },
    { label: "Opened", n: f.opened, className: "bg-emerald-400/70" },
    { label: "Clicked", n: f.clicked, className: "bg-violet-400/70" },
  ];

  return (
    <Card className="mt-3">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div>
          <div className="space-y-3">
            {steps.map((s) => (
              <div key={s.label}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-ink-soft">{s.label}</span>
                  <span className="tabular-nums text-ink">
                    {s.n.toLocaleString()}
                    <span className="ml-2 text-xs text-ink-faint">
                      {f.total > 0
                        ? `${((s.n / f.total) * 100).toFixed(0)}%`
                        : "—"}
                    </span>
                  </span>
                </div>
                <div className="mt-1.5">
                  <ShareBar
                    value={s.n}
                    max={f.total}
                    className={s.className}
                    label={`${s.label}: ${s.n} of ${f.total}`}
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs leading-relaxed text-ink-faint">
            Read straight from the provider, so these hold even with no webhook
            configured. Resend keeps one <em>current</em> status per message
            rather than a history, so the funnel is reconstructed from it: a
            message sitting at &ldquo;clicked&rdquo; is counted at every step
            before it too. The one thing that cannot be recovered this way is a
            message that was opened and later bounced or complained — it counts
            only at its final state, so opens here read slightly low against the
            webhook numbers above.
            {insights.emailsTruncated &&
              ` Only the ${(EMAIL_PAGE_CAP).toLocaleString()} most recent messages were paged through.`}{" "}
            Read from Resend at{" "}
            <LocalTime value={insights.fetchedAt} mode="time" />; cached for a
            few minutes so a reload doesn&rsquo;t re-fetch the account.
          </p>
        </div>

        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-ink-faint">
            Current state
          </div>
          <ul className="mt-3 space-y-1.5">
            {f.byStatus.map((s) => (
              <li key={s.status} className="flex items-center justify-between gap-3 text-sm">
                <Chip tone={STATUS_TONE[s.status] ?? "default"}>
                  {s.status.replace(/_/g, " ")}
                </Chip>
                <span className="tabular-nums text-ink-soft">
                  {s.count.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------------- *
 * Domains
 * ------------------------------------------------------------------------- */

const RECORD_TONE = (status: string): Tone =>
  status === "verified" ? "ok" : status === "failed" ? "bad" : "warn";

export async function DomainsPanel() {
  const insights = await getResendInsights();
  if (insights.domains.length === 0) {
    return (
      <Card className="mt-3">
        <p className="text-sm text-ink-soft">
          {insights.reason ?? "No sending domains are configured on this Resend account."}
        </p>
      </Card>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      {insights.domains.map((d) => (
        <Card key={d.id} className="!p-0 overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
            <Globe className="h-4 w-4 text-ink-faint" />
            <span className="font-mono text-sm text-ink">{d.name}</span>
            <Chip tone={d.status === "verified" ? "ok" : d.status.includes("fail") ? "bad" : "warn"}>
              {d.status.replace(/_/g, " ")}
            </Chip>
            <Chip tone="muted">{d.region}</Chip>
            <Chip tone={d.openTracking ? "ok" : "warn"} title="Injects the tracking pixel">
              open tracking {d.openTracking === null ? "?" : d.openTracking ? "on" : "off"}
            </Chip>
            <Chip tone={d.clickTracking ? "ok" : "warn"} title="Rewrites links to measure clicks">
              click tracking{" "}
              {d.clickTracking === null ? "?" : d.clickTracking ? "on" : "off"}
            </Chip>
            {d.sending && (
              <Chip tone={d.sending === "enabled" ? "ok" : "muted"}>
                sending {d.sending}
              </Chip>
            )}
            <span className="ml-auto text-[11px] text-ink-faint">
              added <LocalTime value={d.created_at} mode="date" />
            </span>
          </div>
          {d.records.length === 0 ? (
            <EmptyNote>
              {d.recordsFetched
                ? "Resend returned no DNS records for this domain."
                : "Verified, so the DNS records weren't fetched — they're only worth a round trip when one of them is failing. They stay available in the Resend dashboard."}
            </EmptyNote>
          ) : (
            <TableShell
              head={
                <>
                  <th className="px-5 py-2.5">Record</th>
                  <th className="px-5 py-2.5">Type</th>
                  <th className="px-5 py-2.5">Name</th>
                  <th className="px-5 py-2.5">Status</th>
                </>
              }
            >
              {d.records.map((r, i) => (
                <tr key={`${r.record}-${r.name}-${i}`} className="border-b border-line last:border-0">
                  <td className="px-5 py-2.5 text-ink">{r.record}</td>
                  <td className="px-5 py-2.5 font-mono text-xs text-ink-faint">{r.type}</td>
                  <td
                    className="max-w-[320px] truncate px-5 py-2.5 font-mono text-xs text-ink-soft"
                    title={`${r.name} → ${r.value}`}
                  >
                    {r.name || "@"}
                  </td>
                  <td className="px-5 py-2.5">
                    <Chip tone={RECORD_TONE(r.status)}>{r.status.replace(/_/g, " ")}</Chip>
                  </td>
                </tr>
              ))}
            </TableShell>
          )}
        </Card>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Webhooks
 * ------------------------------------------------------------------------- */

export async function WebhooksPanel() {
  const insights = await getResendInsights();
  const all = [...REQUIRED_WEBHOOK_EVENTS, ...OPTIONAL_WEBHOOK_EVENTS];

  if (insights.webhooks.length === 0) {
    return (
      <Card className="mt-3">
        <p className="text-sm text-ink-soft">
          {insights.available
            ? "No webhooks are configured on this Resend account, so nothing feeds the engagement numbers on this page."
            : (insights.reason ?? "The webhook list couldn't be read from Resend.")}
        </p>
      </Card>
    );
  }

  return (
    <Card className="mt-3 !p-0 overflow-hidden">
      {insights.webhooks.map((w) => {
        const subscribed = new Set(w.events);
        return (
          <div key={w.id} className="border-b border-line px-5 py-4 last:border-0">
            <div className="flex flex-wrap items-center gap-2">
              <Radio className="h-4 w-4 text-ink-faint" />
              <span
                className="max-w-full truncate font-mono text-xs text-ink"
                title={w.endpoint}
              >
                {w.endpoint}
              </span>
              <Chip tone={w.status === "enabled" ? "ok" : "bad"}>{w.status}</Chip>
              {w.isOurs ? (
                <Chip tone="ok">this site</Chip>
              ) : (
                <Chip tone="muted">elsewhere</Chip>
              )}
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {all.map((e) => (
                <Chip
                  key={e}
                  tone={subscribed.has(e) ? "ok" : "muted"}
                  title={subscribed.has(e) ? "Subscribed" : "Not subscribed"}
                >
                  {e.replace("email.", "")}
                </Chip>
              ))}
              {/* Anything subscribed that this page doesn't consume — contact
                  and domain events, usually. Shown so the list is the whole
                  truth rather than the part we happen to care about. */}
              {w.events
                .filter((e) => !all.includes(e as any))
                .map((e) => (
                  <Chip key={e} tone="default">
                    {e}
                  </Chip>
                ))}
            </div>
          </div>
        );
      })}
    </Card>
  );
}

/* ------------------------------------------------------------------------- *
 * Broadcasts
 * ------------------------------------------------------------------------- */

export async function BroadcastsPanel({
  engagement,
}: {
  /** Webhook-derived stats keyed by Resend broadcast id. */
  engagement: Map<string, { sent: number; opened: number; clicked: number }>;
}) {
  const insights = await getResendInsights();
  if (insights.broadcasts.length === 0) {
    return (
      <Card className="mt-3">
        <p className="text-sm text-ink-soft">
          No Resend broadcasts on this account. Blasts sent from{" "}
          <Link href="/admin/email/blast" className="underline">
            /admin/email/blast
          </Link>{" "}
          go out as ordinary batched sends, not broadcasts, so they appear in the
          template table above instead.
        </p>
      </Card>
    );
  }

  return (
    <Card className="mt-3 !p-0 overflow-hidden">
      <TableShell
        head={
          <>
            <th className="px-5 py-3">Broadcast</th>
            <th className="px-5 py-3">Status</th>
            <th className="px-5 py-3">Sent</th>
            <th className="px-5 py-3 text-right">Messages</th>
            <th className="px-5 py-3 text-right">Opened</th>
            <th className="px-5 py-3 text-right">Clicked</th>
          </>
        }
      >
        {insights.broadcasts.slice(0, 20).map((b) => {
          const e = engagement.get(b.id);
          return (
            <tr key={b.id} className="border-b border-line last:border-0">
              <td className="px-5 py-3 text-ink">
                <Megaphone className="mr-1.5 inline h-3.5 w-3.5 text-ink-faint" />
                {b.name}
              </td>
              <td className="px-5 py-3">
                <Chip tone={b.status === "sent" ? "ok" : b.status === "queued" ? "warn" : "muted"}>
                  {b.status}
                </Chip>
              </td>
              <td className="px-5 py-3 text-xs text-ink-soft">
                <LocalTime
                  value={b.sentAt ?? b.scheduledAt ?? b.createdAt}
                  mode="datetime-short"
                />
              </td>
              <td className="px-5 py-3 text-right tabular-nums text-ink-soft">
                {e ? e.sent.toLocaleString() : "—"}
              </td>
              <td className="px-5 py-3 text-right tabular-nums text-ink-soft">
                {e ? e.opened.toLocaleString() : "—"}
              </td>
              <td className="px-5 py-3 text-right tabular-nums text-ink-soft">
                {e ? e.clicked.toLocaleString() : "—"}
              </td>
            </tr>
          );
        })}
      </TableShell>
      <p className="border-t border-line px-5 py-2.5 text-[11px] text-ink-faint">
        Message counts come from our webhook events, matched on the broadcast id
        Resend stamps on each one — a dash means no events for that broadcast
        have reached us.
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------------- *
 * Audiences
 * ------------------------------------------------------------------------- */

export async function AudiencesPanel() {
  const insights = await getResendInsights();
  if (insights.segments.length === 0) return null;
  return (
    <>
      <SectionHeading
        title="Audiences"
        hint="Contact lists held in Resend. The app's own recipient lists are built from Supabase, so these are only populated if someone imported contacts. Sizes live in the Resend dashboard — counting them here cost a request per segment to render a capped number."
      />
      <Card className="!p-0 overflow-hidden">
        <TableShell
          head={
            <>
              <th className="px-5 py-3">Segment</th>
              <th className="px-5 py-3">Created</th>
            </>
          }
        >
          {insights.segments.map((s) => (
            <tr key={s.id} className="border-b border-line last:border-0">
              <td className="px-5 py-3 text-ink">
                <Users className="mr-1.5 inline h-3.5 w-3.5 text-ink-faint" />
                {s.name}
              </td>
              <td className="px-5 py-3 text-xs text-ink-soft">
                <LocalTime value={s.createdAt} mode="date" />
              </td>
            </tr>
          ))}
        </TableShell>
      </Card>
    </>
  );
}

/* ------------------------------------------------------------------------- *
 * API health
 * ------------------------------------------------------------------------- */

/**
 * Resend's own log of the API calls this app made.
 *
 * A send that Resend rejected outright never produces a webhook event, so it is
 * invisible everywhere else on this page — the mail simply isn't there, and an
 * absence doesn't draw a bar. A 422 on a bad address or a 429 from the rate
 * limiter shows up here and nowhere else.
 */
export async function ApiHealthPanel() {
  const insights = await getResendInsights();
  if (insights.apiCalls.length === 0) {
    return (
      <Card className="mt-3">
        <p className="text-sm text-ink-soft">
          {insights.available
            ? "Resend returned no recent API calls. The Logs API isn't available on every plan."
            : (insights.reason ?? "API logs couldn't be read from Resend.")}
        </p>
      </Card>
    );
  }

  const calls = insights.apiCalls;
  const failures = calls.filter((c) => c.status >= 400);
  const rateLimited = calls.filter((c) => c.status === 429).length;
  const byEndpoint = new Map<string, { total: number; failed: number }>();
  for (const c of calls) {
    const key = `${c.method} ${c.endpoint}`;
    const e = byEndpoint.get(key) ?? { total: 0, failed: 0 };
    e.total++;
    if (c.status >= 400) e.failed++;
    byEndpoint.set(key, e);
  }
  const endpoints = Array.from(byEndpoint.entries())
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.failed - a.failed || b.total - a.total)
    .slice(0, 8);

  return (
    <div className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Tile
          icon={Activity}
          label="Recent API calls"
          value={calls.length.toLocaleString()}
          hint={
            <>
              since <LocalTime value={calls[calls.length - 1].created_at} mode="datetime-short" />
            </>
          }
        />
        <Tile
          icon={AlertTriangle}
          label="Errors"
          value={String(failures.length)}
          tone={failures.length > 0 ? "warn" : "ok"}
          hint={`${((failures.length / calls.length) * 100).toFixed(0)}% of calls returned 4xx/5xx`}
        />
        <Tile
          icon={AlertTriangle}
          label="Rate limited"
          value={String(rateLimited)}
          tone={rateLimited > 0 ? "bad" : "ok"}
          hint={
            rateLimited > 0
              ? "429s mean sends were refused outright — slow the blast down"
              : "No 429s"
          }
        />
      </div>

      <Card className="!p-0 overflow-hidden">
        <TableShell
          head={
            <>
              <th className="px-5 py-3">Endpoint</th>
              <th className="px-5 py-3 text-right">Calls</th>
              <th className="px-5 py-3 text-right">Errors</th>
            </>
          }
        >
          {endpoints.map((e) => (
            <tr key={e.key} className="border-b border-line last:border-0">
              <td className="px-5 py-2.5 font-mono text-xs text-ink-soft">{e.key}</td>
              <td className="px-5 py-2.5 text-right tabular-nums text-ink-soft">{e.total}</td>
              <td className="px-5 py-2.5 text-right tabular-nums">
                <span className={e.failed > 0 ? TONE_TEXT.bad : "text-ink-faint"}>
                  {e.failed}
                </span>
              </td>
            </tr>
          ))}
        </TableShell>
      </Card>

      {failures.length > 0 && (
        <Card className="!p-0 overflow-hidden">
          <div className="border-b border-line px-5 py-2.5 text-xs uppercase tracking-wider text-ink-faint">
            Most recent failures
          </div>
          <TableShell
            head={
              <>
                <th className="px-5 py-2.5">When</th>
                <th className="px-5 py-2.5">Call</th>
                <th className="px-5 py-2.5 text-right">Status</th>
              </>
            }
          >
            {failures.slice(0, 10).map((c) => (
              <tr key={c.id} className="border-b border-line last:border-0">
                <td className="px-5 py-2.5 text-xs text-ink-soft">
                  <LocalTime value={c.created_at} mode="datetime-short" />
                </td>
                <td className="px-5 py-2.5 font-mono text-xs text-ink-soft">
                  {c.method} {c.endpoint}
                </td>
                <td className={`px-5 py-2.5 text-right tabular-nums ${TONE_TEXT.bad}`}>
                  {c.status}
                </td>
              </tr>
            ))}
          </TableShell>
        </Card>
      )}
    </div>
  );
}
