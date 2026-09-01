import { Resend } from "resend";
import { env } from "@/lib/env";
import { stopPaging } from "@/lib/email/paging";

/**
 * Everything the Resend API will tell us about this account.
 *
 * The webhook table (`email_events`) only knows what happened *after* someone
 * pointed Resend at our endpoint, and only for the event types that endpoint is
 * subscribed to. That leaves the two most common questions on the metrics page
 * unanswerable from the database alone:
 *
 *   - "Is anything actually being delivered?" — answered here by the provider's
 *     own `last_event` per message, which exists whether or not a webhook does.
 *   - "Why are all the numbers zero?" — answered here by reading the domain's
 *     tracking flags and the webhook's subscribed events as *facts* instead of
 *     inferring them from an absence of rows.
 *
 * Every call is optional. A missing key, a plan that doesn't expose an
 * endpoint, a network blip — each degrades to an entry in `errors` and the rest
 * of the page renders. Nothing in here is allowed to take the metrics page down;
 * it is a dashboard, not a checkout.
 *
 * ---------------------------------------------------------------------------
 * On call volume
 *
 * The first cut of this fanned out sixteen-odd requests per cold render, which
 * is a lot to spend on a page an admin refreshes while watching a blast go out.
 * Four things bring it to six, and usually fewer:
 *
 *   1. Two cache tiers instead of one. Domains, webhooks and segments change a
 *      few times a year; mail and API logs change by the minute. Holding both
 *      to the same 60s TTL meant re-asking for the domain list every single
 *      minute to learn what it said last time.
 *   2. `domains.list()` already carries the tracking flags. The per-domain
 *      `get()` is only needed for DNS records, which only matter when a domain
 *      isn't verified — so it's now conditional on there being something wrong.
 *   3. Paging `emails.list()` stops once a page contributes nothing inside the
 *      window, rather than always walking to the page cap.
 *   4. The per-segment contact head-count is gone. It cost one request per
 *      segment to render "100+", which nobody acts on.
 */

/** Volatile: mail and API traffic. */
const ACTIVITY_TTL_MS = 3 * 60_000;
/** Near-static: domains, webhooks, segments. Changes a few times a year. */
const CONFIG_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 8_000;

/** 100 per page is the API maximum; the cap only binds on a very busy account. */
const EMAIL_PAGE_SIZE = 100;
const EMAIL_MAX_PAGES = 10;
/** How far back the funnel can see. Shown to the reader when it's the binding limit. */
export const EMAIL_PAGE_CAP = EMAIL_PAGE_SIZE * EMAIL_MAX_PAGES;
/**
 * Paging stops at this age. A day wider than the 30 the page displays, so a
 * boundary message can't fall out of the funnel because of clock skew between
 * us and Resend.
 */
const EMAIL_WINDOW_DAYS = 31;
/** Enough domains and segments for any real account; a bound, not a feature. */
const MAX_DOMAINS = 5;
const MAX_SEGMENTS = 10;

export type ProviderEmail = {
  id: string;
  created_at: string;
  from: string;
  to: string[];
  subject: string;
  last_event: string;
  scheduled_at: string | null;
};

export type DomainInsight = {
  id: string;
  name: string;
  status: string;
  region: string;
  created_at: string;
  openTracking: boolean | null;
  clickTracking: boolean | null;
  trackingSubdomain: string | null;
  sending: string | null;
  receiving: string | null;
  /** Empty when the domain is verified — we don't pay for records we won't show. */
  records: {
    record: string;
    name: string;
    type: string;
    status: string;
    value: string;
    priority?: number;
  }[];
  /** False when `records` is empty only because we didn't ask for them. */
  recordsFetched: boolean;
};

export type WebhookInsight = {
  id: string;
  endpoint: string;
  status: string;
  events: string[];
  createdAt: string;
  /** True when this endpoint points back at this deployment. */
  isOurs: boolean;
};

export type BroadcastInsight = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  scheduledAt: string | null;
  sentAt: string | null;
};

export type ApiCallInsight = {
  id: string;
  created_at: string;
  endpoint: string;
  method: string;
  status: number;
};

export type SegmentInsight = { id: string; name: string; createdAt: string };

export type InsightError = { source: string; message: string };

export type ResendInsights = {
  available: boolean;
  /** Why there is no data, when there isn't any. */
  reason: string | null;
  /** When the volatile half was last read. */
  fetchedAt: string;
  /** When the near-static half was last read — up to ten minutes older. */
  configFetchedAt: string;
  domains: DomainInsight[];
  webhooks: WebhookInsight[];
  emails: ProviderEmail[];
  /** True when the account has more mail than we paged through. */
  emailsTruncated: boolean;
  broadcasts: BroadcastInsight[];
  apiCalls: ApiCallInsight[];
  segments: SegmentInsight[];
  errors: InsightError[];
};

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)),
        TIMEOUT_MS,
      ),
    ),
  ]);
}

function message(err: unknown): string {
  if (err && typeof err === "object" && "message" in err)
    return String((err as any).message);
  return String(err);
}

/**
 * The Resend SDK returns `{ data, error }` for API-level failures and throws
 * for transport ones. Collapse both into "value or a recorded error" so a
 * single dead endpoint can't reject the whole `Promise.all`.
 */
async function attempt<T>(
  source: string,
  errors: InsightError[],
  run: () => Promise<{ data: T | null; error: { message: string } | null }>,
): Promise<T | null> {
  try {
    const { data, error } = await withTimeout(run(), source);
    if (error) {
      errors.push({ source, message: error.message });
      return null;
    }
    return data;
  } catch (err) {
    errors.push({ source, message: message(err) });
    return null;
  }
}

/**
 * A TTL cache with in-flight dedupe.
 *
 * The dedupe is what stops the metrics page's half-dozen independent Suspense
 * boundaries from all missing the cache in the same tick and each firing its
 * own fan-out — which is both slow and a good way to meet Resend's rate
 * limiter.
 */
function tier<T>(ttlMs: number, load: () => Promise<T>) {
  let cache: { at: number; value: T } | null = null;
  let pending: Promise<T> | null = null;
  return {
    get(): Promise<T> {
      if (cache && Date.now() - cache.at < ttlMs) return Promise.resolve(cache.value);
      if (pending) return pending;
      pending = load()
        .then((value) => {
          cache = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
    at(): number | null {
      return cache?.at ?? null;
    },
    clear() {
      cache = null;
    },
  };
}

function client(): Resend | null {
  return env.resendApiKey ? new Resend(env.resendApiKey) : null;
}

/* -------------------------------------------------------------------------- *
 * Near-static tier: domains, webhooks, segments
 * -------------------------------------------------------------------------- */

type ConfigSnapshot = {
  domains: DomainInsight[];
  webhooks: WebhookInsight[];
  segments: SegmentInsight[];
  errors: InsightError[];
};

const configTier = tier<ConfigSnapshot>(CONFIG_TTL_MS, loadConfig);

async function loadConfig(): Promise<ConfigSnapshot> {
  const resend = client();
  if (!resend) return { domains: [], webhooks: [], segments: [], errors: [] };
  const errors: InsightError[] = [];

  const [domainList, webhookList, segmentList] = await Promise.all([
    attempt<any>("domains", errors, () => resend.domains.list() as any),
    attempt<any>("webhooks", errors, () => resend.webhooks.list() as any),
    attempt<any>("segments", errors, () => resend.segments.list() as any),
  ]);

  const domains: DomainInsight[] = [];
  for (const d of (domainList?.data ?? []).slice(0, MAX_DOMAINS)) {
    // The list payload already carries status and the two tracking flags —
    // which is everything the diagnostics need when a domain is healthy. Only
    // the DNS records require a second request, and the only time we render
    // them is when something is unverified. A verified domain therefore costs
    // one request for the whole list rather than one request each.
    //
    // The flags are optional in the API's own type, so a response that omits
    // them still falls through to the detail fetch rather than silently
    // reporting "tracking unknown" — the single most valuable thing here.
    const flagsMissing = d.open_tracking == null || d.click_tracking == null;
    const needsRecords = d.status !== "verified";
    const detail =
      flagsMissing || needsRecords
        ? await attempt<any>(`domain:${d.name}`, errors, () =>
            resend.domains.get(d.id) as any,
          )
        : null;

    const src: any = detail ?? d;
    domains.push({
      id: src.id,
      name: src.name,
      status: src.status,
      region: src.region,
      created_at: src.created_at,
      openTracking: src.open_tracking ?? null,
      clickTracking: src.click_tracking ?? null,
      trackingSubdomain: src.tracking_subdomain ?? null,
      sending: src.capabilities?.sending ?? null,
      receiving: src.capabilities?.receiving ?? null,
      records: (src.records ?? []).map((r: any) => ({
        record: r.record,
        name: r.name,
        type: r.type,
        status: r.status,
        value: r.value,
        priority: r.priority,
      })),
      recordsFetched: detail !== null,
    });
  }

  // Match on host rather than the full URL: preview deployments and the custom
  // domain are the same endpoint as far as "is this ours" goes, and a trailing
  // slash shouldn't decide whether the page says the webhook is wired up.
  let ourHost = "";
  try {
    ourHost = new URL(env.siteUrl).host;
  } catch {
    /* siteUrl is misconfigured; every webhook simply reads as third-party */
  }

  const webhooks: WebhookInsight[] = (webhookList?.data ?? []).map((w: any) => {
    let host = "";
    try {
      host = new URL(w.endpoint).host;
    } catch {
      /* leave blank; a webhook with an unparseable endpoint isn't ours */
    }
    return {
      id: w.id,
      endpoint: w.endpoint,
      status: w.status,
      events: w.events ?? [],
      createdAt: w.created_at,
      isOurs: Boolean(host) && host === ourHost,
    };
  });

  // Names and creation dates only. Sizing each segment meant one extra request
  // per segment to render a number capped at "100+" — the worst value-per-call
  // on the page. The Resend dashboard shows exact counts.
  const segments: SegmentInsight[] = (segmentList?.data ?? [])
    .slice(0, MAX_SEGMENTS)
    .map((s: any) => ({ id: s.id, name: s.name, createdAt: s.created_at }));

  return { domains, webhooks, segments, errors };
}

/* -------------------------------------------------------------------------- *
 * Volatile tier: mail, broadcasts, API logs
 * -------------------------------------------------------------------------- */

type ActivitySnapshot = {
  emails: ProviderEmail[];
  emailsTruncated: boolean;
  broadcasts: BroadcastInsight[];
  apiCalls: ApiCallInsight[];
  errors: InsightError[];
};

const activityTier = tier<ActivitySnapshot>(ACTIVITY_TTL_MS, loadActivity);

async function loadActivity(): Promise<ActivitySnapshot> {
  const resend = client();
  if (!resend)
    return { emails: [], emailsTruncated: false, broadcasts: [], apiCalls: [], errors: [] };
  const errors: InsightError[] = [];

  const [emails, broadcastList, logList] = await Promise.all([
    listRecentEmails(resend, errors),
    attempt<any>("broadcasts", errors, () => resend.broadcasts.list() as any),
    attempt<any>("logs", errors, () => resend.logs.list({ limit: 100 }) as any),
  ]);

  const broadcasts: BroadcastInsight[] = (broadcastList?.data ?? [])
    .map((b: any) => ({
      id: b.id,
      name: b.name,
      status: b.status,
      createdAt: b.created_at,
      scheduledAt: b.scheduled_at ?? null,
      sentAt: b.sent_at ?? null,
    }))
    .sort((a: BroadcastInsight, b: BroadcastInsight) =>
      (b.sentAt ?? b.createdAt).localeCompare(a.sentAt ?? a.createdAt),
    );

  const apiCalls: ApiCallInsight[] = (logList?.data ?? []).map((l: any) => ({
    id: l.id,
    created_at: l.created_at,
    endpoint: l.endpoint,
    method: l.method,
    status: l.response_status,
  }));

  return { ...emails, broadcasts, apiCalls, errors };
}

/**
 * Pages through `emails.list()` until it has the window the page displays.
 *
 * The endpoint takes no date filter, so trimming is ours to do — but paging all
 * the way to the cap to fetch mail the page will then discard is pure waste on
 * any account with history. It stops after a page that contributed nothing
 * inside the window.
 *
 * That test deliberately doesn't assume an ordering. If the endpoint returns
 * newest-first it fires on the page just past the boundary, which is the win we
 * want. If it ever returns oldest-first, the leading pages are all outside the
 * window and `seenInWindow` is still zero, so the guard holds and it keeps
 * paging — slower, but correct. An early exit that silently truncated the
 * funnel would be much worse than one that never fires.
 */
async function listRecentEmails(
  resend: Resend,
  errors: InsightError[],
): Promise<{ emails: ProviderEmail[]; emailsTruncated: boolean }> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - EMAIL_WINDOW_DAYS);
  const cutoffIso = cutoff.toISOString();

  const emails: ProviderEmail[] = [];
  let after: string | undefined;
  let seenInWindow = 0;
  let emailsTruncated = false;

  for (let page = 0; page < EMAIL_MAX_PAGES; page++) {
    const data = await attempt<any>(
      page === 0 ? "emails" : `emails:page${page + 1}`,
      errors,
      () =>
        resend.emails.list(
          after ? { limit: EMAIL_PAGE_SIZE, after } : { limit: EMAIL_PAGE_SIZE },
        ) as any,
    );
    // Keep the pages that did come back rather than losing them to one failure.
    if (!data) break;

    const batch = data.data ?? [];
    let inWindowThisPage = 0;
    for (const e of batch) {
      if (e.created_at >= cutoffIso) inWindowThisPage++;
      emails.push({
        id: e.id,
        created_at: e.created_at,
        from: e.from,
        to: e.to ?? [],
        subject: e.subject,
        last_event: e.last_event,
        scheduled_at: e.scheduled_at ?? null,
      });
    }
    seenInWindow += inWindowThisPage;

    if (
      stopPaging({
        hasMore: Boolean(data.has_more),
        batchSize: batch.length,
        seenInWindow,
        inWindowThisPage,
      })
    )
      break;

    after = batch[batch.length - 1]?.id;
    if (!after) break;
    if (page === EMAIL_MAX_PAGES - 1) emailsTruncated = true;
  }

  return { emails, emailsTruncated };
}

/* -------------------------------------------------------------------------- *
 * Composition
 * -------------------------------------------------------------------------- */

/** Drop both caches — the next read goes back to the provider. */
export function invalidateResendInsights() {
  configTier.clear();
  activityTier.clear();
}

export async function getResendInsights(): Promise<ResendInsights> {
  if (!env.resendApiKey) {
    const now = new Date().toISOString();
    return {
      available: false,
      reason:
        "RESEND_API_KEY isn't set in this environment, so nothing can be read back from the provider.",
      fetchedAt: now,
      configFetchedAt: now,
      domains: [],
      webhooks: [],
      emails: [],
      emailsTruncated: false,
      broadcasts: [],
      apiCalls: [],
      segments: [],
      errors: [],
    };
  }

  const [config, activity] = await Promise.all([configTier.get(), activityTier.get()]);
  const errors = [...config.errors, ...activity.errors];
  const nothing =
    config.domains.length === 0 &&
    config.webhooks.length === 0 &&
    activity.emails.length === 0;

  return {
    // "Available" means we got a usable answer out of the provider — not that
    // every endpoint worked. An account on a plan without the Logs API should
    // still see its domains and its delivery funnel.
    available: !nothing,
    reason: nothing
      ? (errors[0]?.message ??
        "The API key is set, but this account has no domains, webhooks, or sent mail.")
      : null,
    fetchedAt: new Date(activityTier.at() ?? Date.now()).toISOString(),
    configFetchedAt: new Date(configTier.at() ?? Date.now()).toISOString(),
    domains: config.domains,
    webhooks: config.webhooks,
    segments: config.segments,
    emails: activity.emails,
    emailsTruncated: activity.emailsTruncated,
    broadcasts: activity.broadcasts,
    apiCalls: activity.apiCalls,
    errors,
  };
}

/**
 * The provider-side funnel: how many messages are currently in each state,
 * according to Resend rather than according to our webhook.
 *
 * `last_event` is a single current status, not a history — a message that was
 * delivered and then opened reports only "opened". So the funnel is cumulative:
 * anything opened was also delivered, anything delivered was also sent.
 */
export type ProviderFunnel = {
  total: number;
  byStatus: { status: string; count: number }[];
  queued: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  problems: number;
  windowStart: string | null;
};

const DOWNSTREAM_OF_DELIVERED = new Set(["delivered", "opened", "clicked", "complained"]);
const PROBLEM_STATES = new Set([
  "bounced",
  "failed",
  "complained",
  "suppressed",
  "canceled",
]);

export function providerFunnel(
  emails: ProviderEmail[],
  sinceIso?: string,
): ProviderFunnel {
  const rows = sinceIso
    ? emails.filter((e) => e.created_at >= sinceIso)
    : emails;

  const counts = new Map<string, number>();
  let queued = 0,
    delivered = 0,
    opened = 0,
    clicked = 0,
    problems = 0;

  for (const e of rows) {
    counts.set(e.last_event, (counts.get(e.last_event) ?? 0) + 1);
    if (e.last_event === "queued" || e.last_event === "scheduled") queued++;
    if (DOWNSTREAM_OF_DELIVERED.has(e.last_event)) delivered++;
    if (e.last_event === "opened" || e.last_event === "clicked") opened++;
    if (e.last_event === "clicked") clicked++;
    if (PROBLEM_STATES.has(e.last_event)) problems++;
  }

  return {
    total: rows.length,
    byStatus: Array.from(counts.entries())
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count),
    queued,
    // "Left Resend" excludes everything that never reached a mail server:
    // still waiting (queued/scheduled), cancelled before it went, rejected by
    // Resend (failed), or blocked by the suppression list. A bounce, by
    // contrast, *was* sent — the receiving server rejected it afterwards.
    sent: rows.filter(
      (e) =>
        !["queued", "scheduled", "canceled", "failed", "suppressed"].includes(
          e.last_event,
        ),
    ).length,
    delivered,
    opened,
    clicked,
    problems,
    windowStart: rows.length
      ? rows.reduce((min, e) => (e.created_at < min ? e.created_at : min), rows[0].created_at)
      : null,
  };
}

/** The event types this page's numbers depend on. */
export const REQUIRED_WEBHOOK_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
] as const;

/** Nice to have — they power the failure and delay panels. */
export const OPTIONAL_WEBHOOK_EVENTS = [
  "email.failed",
  "email.delivery_delayed",
  "email.suppressed",
] as const;
