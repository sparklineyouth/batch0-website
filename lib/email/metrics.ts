/**
 * Aggregation over the raw `email_events` table.
 *
 * Everything here is pure — rows in, numbers out — because the admin metrics
 * page is the one place in the app where a quietly wrong number is worse than
 * a crash: nobody double-checks a dashboard. Keeping the arithmetic out of the
 * JSX means it can be tested (see lib/email-metrics.test.ts) against the
 * awkward cases that actually occur in the table: an open whose send predates
 * the window, five opens of one message, a bounce with no email id.
 *
 * The organising idea is the MESSAGE, not the event. Resend fires many events
 * per email, and every rate on the page is "how many messages reached this
 * state", never "how many events of this type arrived". Counting events is how
 * you end up reporting a 300% open rate.
 */

export type EmailEventRow = {
  event_type: string;
  subject: string | null;
  recipient: string | null;
  resend_email_id: string | null;
  occurred_at: string;
  // All optional: added by migration 0057, so a database that hasn't run it
  // yet returns rows without them and every consumer below degrades to the
  // subject-prefix behaviour it had before.
  broadcast_id?: string | null;
  template_key?: string | null;
  bounce_type?: string | null;
  bounce_subtype?: string | null;
  bounce_message?: string | null;
  click_link?: string | null;
  user_agent?: string | null;
  failure_reason?: string | null;
};

/** One email, folded up from every event that mentioned it. */
export type Message = {
  id: string;
  subject: string | null;
  recipient: string | null;
  templateKey: string | null;
  broadcastId: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  firstOpenAt: string | null;
  firstClickAt: string | null;
  opens: number;
  clicks: number;
  bounced: boolean;
  bounceType: string | null;
  complained: boolean;
  failed: boolean;
  failureReason: string | null;
  suppressed: boolean;
  delayed: boolean;
  scheduled: boolean;
};

/**
 * Events that arrive without a `resend_email_id` can't be joined to anything,
 * so they become a message of their own rather than being dropped — dropping
 * them silently shrinks the denominator, which is the failure mode that makes
 * rates look better than they are.
 */
function messageKey(r: EmailEventRow, index: number): string {
  return r.resend_email_id ?? `anon:${index}:${r.occurred_at}`;
}

function earlier(a: string | null, b: string): string {
  return a === null || b < a ? b : a;
}

export function foldMessages(rows: EmailEventRow[]): Map<string, Message> {
  const out = new Map<string, Message>();
  rows.forEach((r, i) => {
    const key = messageKey(r, i);
    let m = out.get(key);
    if (!m) {
      m = {
        id: key,
        subject: r.subject,
        recipient: r.recipient,
        templateKey: r.template_key ?? null,
        broadcastId: r.broadcast_id ?? null,
        sentAt: null,
        deliveredAt: null,
        firstOpenAt: null,
        firstClickAt: null,
        opens: 0,
        clicks: 0,
        bounced: false,
        bounceType: null,
        complained: false,
        failed: false,
        failureReason: null,
        suppressed: false,
        delayed: false,
        scheduled: false,
      };
      out.set(key, m);
    }
    // Later events carry the same subject/recipient; the first non-null wins so
    // an event type that omits one (some do) can't blank it out.
    m.subject ??= r.subject;
    m.recipient ??= r.recipient;
    m.templateKey ??= r.template_key ?? null;
    m.broadcastId ??= r.broadcast_id ?? null;

    switch (r.event_type) {
      case "email.sent":
        m.sentAt = earlier(m.sentAt, r.occurred_at);
        break;
      case "email.delivered":
        m.deliveredAt = earlier(m.deliveredAt, r.occurred_at);
        break;
      case "email.opened":
        m.opens++;
        m.firstOpenAt = earlier(m.firstOpenAt, r.occurred_at);
        break;
      case "email.clicked":
        m.clicks++;
        m.firstClickAt = earlier(m.firstClickAt, r.occurred_at);
        break;
      case "email.bounced":
        m.bounced = true;
        m.bounceType ??= r.bounce_type ?? null;
        break;
      case "email.complained":
        m.complained = true;
        break;
      case "email.failed":
        m.failed = true;
        m.failureReason ??= r.failure_reason ?? null;
        break;
      case "email.suppressed":
        m.suppressed = true;
        break;
      case "email.delivery_delayed":
        m.delayed = true;
        break;
      case "email.scheduled":
        m.scheduled = true;
        break;
    }
  });
  return out;
}

export type Summary = {
  /** Messages that were actually pushed out in the window. */
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  hardBounced: number;
  softBounced: number;
  complained: number;
  failed: number;
  suppressed: number;
  delayed: number;
  /** Raw event totals, for the "N opens across M messages" hints. */
  totalOpens: number;
  totalClicks: number;
  /** Denominator every engagement rate divides by. */
  denom: number;
  deliveryRate: number | null;
  openRate: number | null;
  clickRate: number | null;
  /** Clicks per opener — the number that says whether the body works. */
  clickToOpenRate: number | null;
  bounceRate: number | null;
  complaintRate: number | null;
};

export function summarize(messages: Iterable<Message>): Summary {
  let sent = 0,
    delivered = 0,
    opened = 0,
    clicked = 0,
    bounced = 0,
    hardBounced = 0,
    softBounced = 0,
    complained = 0,
    failed = 0,
    suppressed = 0,
    delayed = 0,
    totalOpens = 0,
    totalClicks = 0;

  for (const m of messages) {
    // A message we only ever saw an *open* for was sent before the window
    // opened. Counting it as sent would credit this window with a send it
    // didn't make; counting its open is still right, which is why opened is
    // tallied unconditionally and sent is not.
    if (m.sentAt || m.deliveredAt || m.bounced || m.failed) sent++;
    if (m.deliveredAt) delivered++;
    if (m.opens > 0) opened++;
    if (m.clicks > 0) clicked++;
    if (m.bounced) {
      bounced++;
      // Resend reports Permanent / Transient / Undetermined. A permanent
      // bounce is an address that must never be mailed again; a transient one
      // is a full mailbox and will probably clear. Averaging the two together
      // hides the only one you have to act on.
      if (/permanent|hard/i.test(m.bounceType ?? "")) hardBounced++;
      else softBounced++;
    }
    if (m.complained) complained++;
    if (m.failed) failed++;
    if (m.suppressed) suppressed++;
    if (m.delayed) delayed++;
    totalOpens += m.opens;
    totalClicks += m.clicks;
  }

  const denom = delivered || sent;
  const rate = (num: number, d: number) => (d > 0 ? num / d : null);

  return {
    sent,
    delivered,
    opened,
    clicked,
    bounced,
    hardBounced,
    softBounced,
    complained,
    failed,
    suppressed,
    delayed,
    totalOpens,
    totalClicks,
    denom,
    deliveryRate: rate(delivered, sent),
    openRate: rate(opened, denom),
    clickRate: rate(clicked, denom),
    clickToOpenRate: rate(clicked, opened),
    bounceRate: rate(bounced, sent),
    complaintRate: rate(complained, denom),
  };
}

/**
 * Per-day series. Every series counts MESSAGES, once, on the day the state was
 * reached — an open on Tuesday of a mail sent Monday is a Tuesday open, which
 * is why this walks events rather than the folded messages.
 */
export type DayPoint = {
  key: string;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
};

export function dailySeries(
  rows: EmailEventRow[],
  days: number,
  now = new Date(),
): DayPoint[] {
  const series: DayPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    series.push({
      key: d.toISOString().slice(0, 10),
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
    });
  }
  const idx = new Map(series.map((d, i) => [d.key, i] as const));
  const seen = new Set<string>();

  rows.forEach((r, i) => {
    const day = r.occurred_at.slice(0, 10);
    const at = idx.get(day);
    if (at == null) return;
    const id = messageKey(r, i);
    const bump = (field: keyof Omit<DayPoint, "key">) => {
      const k = `${field}:${day}:${id}`;
      if (seen.has(k)) return;
      seen.add(k);
      series[at][field]++;
    };
    // `sent` is the volume line, and a message fires both email.sent and
    // email.delivered — the dedupe key is per-field so those collapse to one.
    if (r.event_type === "email.sent" || r.event_type === "email.delivered")
      bump("sent");
    if (r.event_type === "email.delivered") bump("delivered");
    else if (r.event_type === "email.opened") bump("opened");
    else if (r.event_type === "email.clicked") bump("clicked");
    else if (r.event_type === "email.bounced") bump("bounced");
  });
  return series;
}

/**
 * Bucket label for the per-template table.
 *
 * Prefers the `template` tag we now stamp on every send (see lib/email/send.ts)
 * because it is exact. Falls back to a normalized subject for mail sent before
 * tagging existed, or sent over SMTP where there are no Resend tags at all —
 * dynamic tails ("— Jane Doe", "for cohort 3") are stripped so one template
 * doesn't split into forty rows.
 */
export function normalizeSubject(s: string | null): string {
  if (!s) return "(unknown)";
  return (
    s
      .replace(/\s[—·–-]\s.*$/, "")
      .replace(/\s(for|to)\s.+$/i, "")
      .trim()
      .slice(0, 80) || "(unknown)"
  );
}

export type TemplateStats = Summary & {
  label: string;
  /** True when the grouping came from a tag rather than a guessed subject. */
  exact: boolean;
  lastSentAt: string | null;
};

export function byTemplate(messages: Iterable<Message>): TemplateStats[] {
  const groups = new Map<string, { exact: boolean; items: Message[] }>();
  for (const m of messages) {
    const exact = Boolean(m.templateKey);
    const label = m.templateKey ?? normalizeSubject(m.subject);
    const g = groups.get(label) ?? { exact, items: [] };
    // A group is only "exact" if every message in it came from a tag.
    g.exact = g.exact && exact;
    g.items.push(m);
    groups.set(label, g);
  }
  return Array.from(groups.entries())
    .map(([label, g]) => {
      const s = summarize(g.items);
      const lastSentAt = g.items.reduce<string | null>((acc, m) => {
        const t = m.sentAt ?? m.deliveredAt;
        return t && (acc === null || t > acc) ? t : acc;
      }, null);
      return { label, exact: g.exact, lastSentAt, ...s };
    })
    .filter((t) => t.sent > 0 || t.opened > 0)
    .sort((a, b) => b.sent - a.sent || b.opened - a.opened);
}

export type LinkStats = {
  url: string;
  clicks: number;
  /** Distinct messages whose recipient clicked this link. */
  messages: number;
};

export function topLinks(rows: EmailEventRow[], limit = 12): LinkStats[] {
  const map = new Map<string, { clicks: number; msgs: Set<string> }>();
  rows.forEach((r, i) => {
    if (r.event_type !== "email.clicked" || !r.click_link) return;
    const e = map.get(r.click_link) ?? { clicks: 0, msgs: new Set<string>() };
    e.clicks++;
    e.msgs.add(messageKey(r, i));
    map.set(r.click_link, e);
  });
  return Array.from(map.entries())
    .map(([url, e]) => ({ url, clicks: e.clicks, messages: e.msgs.size }))
    .sort((a, b) => b.clicks - a.clicks || b.messages - a.messages)
    .slice(0, limit);
}

/**
 * Which mail client opened it.
 *
 * Worth the regex zoo for one reason: Apple Mail Privacy Protection and
 * Gmail's image proxy pre-fetch the tracking pixel whether or not a human ever
 * looked at the message. A high open rate that is 80% proxy traffic is not a
 * high open rate, and the only way to see that from here is the user agent.
 */
export function classifyClient(ua: string | null | undefined): {
  client: string;
  proxied: boolean;
} {
  const s = ua ?? "";
  if (!s.trim()) return { client: "Unknown", proxied: false };
  if (/GoogleImageProxy/i.test(s)) return { client: "Gmail (image proxy)", proxied: true };
  if (/YahooMailProxy/i.test(s)) return { client: "Yahoo Mail (proxy)", proxied: true };
  // Apple's relay fetches with a bare Mac Safari-ish agent and no Mail token.
  // It is indistinguishable from a real macOS browser open by UA alone, so it
  // is only flagged when the Mail client token is present.
  if (/\bMail\/\d/i.test(s) && /Macintosh|iPhone|iPad/i.test(s))
    return { client: "Apple Mail", proxied: true };
  if (/Outlook|MSOffice|Microsoft Office|Windows Mail/i.test(s))
    return { client: "Outlook", proxied: false };
  if (/Thunderbird/i.test(s)) return { client: "Thunderbird", proxied: false };
  if (/Superhuman/i.test(s)) return { client: "Superhuman", proxied: false };
  if (/Android/i.test(s)) return { client: "Android", proxied: false };
  if (/iPhone|iPad|iOS/i.test(s)) return { client: "iOS", proxied: false };
  if (/Macintosh|Mac OS X/i.test(s)) return { client: "macOS", proxied: false };
  if (/Windows/i.test(s)) return { client: "Windows", proxied: false };
  if (/Linux|X11/i.test(s)) return { client: "Linux", proxied: false };
  return { client: "Other", proxied: false };
}

export type ClientStats = { client: string; opens: number; proxied: boolean };

export function byClient(rows: EmailEventRow[]): ClientStats[] {
  const map = new Map<string, ClientStats>();
  for (const r of rows) {
    if (r.event_type !== "email.opened" && r.event_type !== "email.clicked")
      continue;
    const { client, proxied } = classifyClient(r.user_agent);
    const e = map.get(client) ?? { client, opens: 0, proxied };
    e.opens++;
    map.set(client, e);
  }
  return Array.from(map.values()).sort((a, b) => b.opens - a.opens);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export type Latency = {
  /** Milliseconds, median. Null when nothing in the window reached that state. */
  toDelivery: number | null;
  toOpen: number | null;
  toClick: number | null;
  sample: number;
};

export function latency(messages: Iterable<Message>): Latency {
  const del: number[] = [];
  const open: number[] = [];
  const click: number[] = [];
  let sample = 0;
  for (const m of messages) {
    if (m.sentAt && m.deliveredAt) {
      const d = Date.parse(m.deliveredAt) - Date.parse(m.sentAt);
      if (d >= 0) del.push(d);
    }
    const base = m.deliveredAt ?? m.sentAt;
    if (base && m.firstOpenAt) {
      const d = Date.parse(m.firstOpenAt) - Date.parse(base);
      if (d >= 0) open.push(d);
    }
    if (base && m.firstClickAt) {
      const d = Date.parse(m.firstClickAt) - Date.parse(base);
      if (d >= 0) click.push(d);
    }
    sample++;
  }
  return {
    toDelivery: median(del),
    toOpen: median(open),
    toClick: median(click),
    sample,
  };
}

export type ProblemRecipient = {
  email: string;
  kind: "bounced" | "complained" | "failed" | "suppressed";
  detail: string | null;
  at: string;
  subject: string | null;
};

/**
 * Addresses that hurt the sending reputation. Ordered worst-first — a spam
 * complaint costs more than a bounce, and a permanent bounce costs more than a
 * full mailbox.
 */
export function problemRecipients(
  rows: EmailEventRow[],
  limit = 40,
): ProblemRecipient[] {
  const RANK: Record<ProblemRecipient["kind"], number> = {
    complained: 0,
    bounced: 1,
    suppressed: 2,
    failed: 3,
  };
  const out: ProblemRecipient[] = [];
  for (const r of rows) {
    const kind =
      r.event_type === "email.bounced"
        ? "bounced"
        : r.event_type === "email.complained"
          ? "complained"
          : r.event_type === "email.failed"
            ? "failed"
            : r.event_type === "email.suppressed"
              ? "suppressed"
              : null;
    if (!kind || !r.recipient) continue;
    const detail =
      kind === "bounced"
        ? [r.bounce_type, r.bounce_subtype].filter(Boolean).join(" · ") ||
          r.bounce_message ||
          null
        : kind === "failed"
          ? // `?? null` because the column is optional on the row type, and
            // ProblemRecipient.detail is `string | null` — undefined would not
            // compile. Not part of the degraded-screens work; it was just the
            // one type error standing between this tree and a build.
            (r.failure_reason ?? null)
          : null;
    out.push({ email: r.recipient, kind, detail, at: r.occurred_at, subject: r.subject });
  }
  // One address can bounce repeatedly; keep only its worst, most recent entry.
  const best = new Map<string, ProblemRecipient>();
  for (const p of out) {
    const prev = best.get(p.email);
    if (!prev || RANK[p.kind] < RANK[prev.kind] || (RANK[p.kind] === RANK[prev.kind] && p.at > prev.at))
      best.set(p.email, p);
  }
  return Array.from(best.values())
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.at.localeCompare(a.at))
    .slice(0, limit);
}

/** Engagement rolled up per Resend broadcast id, for the broadcasts panel. */
export function byBroadcast(messages: Iterable<Message>): Map<string, Summary> {
  const groups = new Map<string, Message[]>();
  for (const m of messages) {
    if (!m.broadcastId) continue;
    const g = groups.get(m.broadcastId) ?? [];
    g.push(m);
    groups.set(m.broadcastId, g);
  }
  return new Map(
    Array.from(groups.entries()).map(([id, items]) => [id, summarize(items)]),
  );
}

/** Every distinct event type seen, newest activity first — the raw feed. */
export function recentActivity(rows: EmailEventRow[], limit = 50) {
  return [...rows]
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
    .slice(0, limit);
}

export function fmtPct(v: number | null, digits = 0): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = s / 60;
  if (m < 90) return `${m.toFixed(m < 10 ? 1 : 0)}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${(h / 24).toFixed(1)}d`;
}
