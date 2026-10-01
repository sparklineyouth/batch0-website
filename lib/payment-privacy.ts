/** Runs before page scripts: the bearer invitation never stays in the URL. */
export const PAYMENT_FRAGMENT_SCRIPT = `(function(){if(location.pathname.replace(/\\/$/,'')==='/pay'){window['ga-disable-G-C51DMRB6YE']=true;var token=new URLSearchParams(location.hash.slice(1)).get('token');if(token&&/^[A-Za-z0-9_-]{43}$/.test(token)){window.__batch0PayerToken=token;}var session=new URLSearchParams(location.hash.slice(1)).get('session_id');if(session&&/^cs_(?:test|live)_[A-Za-z0-9]+$/.test(session)){window.__batch0CheckoutSession=session;}if(location.hash){history.replaceState(history.state,'',location.pathname+location.search);}}})();`;

export function isPrivatePaymentPath(path: string | null): boolean {
  return path === "/pay" || !!path?.startsWith("/pay/");
}

/**
 * Paths where the URL *is* the credential, so the URL itself must never be
 * recorded anywhere.
 *
 * /support/t/<token> authorizes on possession of the token alone — there is no
 * session behind it, exactly as with a Demo Day ticket link. That makes the
 * pathname a bearer secret, and an analytics pageview is a copy of the
 * pathname sent to a third party. A GA or Vercel Analytics event from one of
 * these pages hands a stranger's support thread to anyone who can read the
 * analytics dashboard, and neither `noindex` nor the RLS policies do anything
 * about it.
 *
 * Kept separate from isPrivatePaymentPath rather than folded into it: that
 * predicate answers "is this a payment surface" and lib/payment-privacy.test.ts
 * pins /payments and /parents as deliberately NOT private. Widening it would
 * change an answer two other call sites rely on.
 */
export function isSecretUrlPath(path: string | null): boolean {
  return (
    !!path?.startsWith("/support/t/") ||
    // Same shape, same exposure, and it predates the support form: a Demo Day
    // ticket page authorizes on the token in its path too, and it gates a live
    // Stripe payment. Included here because the rule is "the URL is the
    // credential", and that was already true of this route.
    !!path?.startsWith("/demo-day/ticket/")
  );
}

/**
 * Every path analytics must be blind to. The union of the two rules above, so
 * a new secret-URL surface is excluded by adding it in one place.
 */
export function isAnalyticsBlockedPath(path: string | null): boolean {
  return isPrivatePaymentPath(path) || isSecretUrlPath(path);
}

/**
 * Runs before page scripts, beside PAYMENT_FRAGMENT_SCRIPT: GA is switched off
 * for the whole document on a secret-URL page before any GA code can load.
 * SiteAnalytics renders no GA on these pages, but rendering nothing can't
 * unload gtag once a client-side navigation away has loaded it, and GA4 counts
 * history changes on its own — Back to the token page would send its URL.
 * Mirrors isSecretUrlPath; lib/payment-privacy.test.ts runs both over the same
 * paths.
 */
export const SECRET_URL_ANALYTICS_SCRIPT = `(function(){var p=location.pathname;if(p.indexOf('/support/t/')===0||p.indexOf('/demo-day/ticket/')===0){window['ga-disable-G-C51DMRB6YE']=true;}})();`;

// A secret-URL prefix and the token after it, wherever it sits in a string — a
// full URL, "GET /support/t/…", a log line — and not anchored to the end, so
// /support/t/<token>/files/<id> loses its token too. The separators may be
// percent-encoded, which is how a path travels inside a ?from= or ?next= value.
// Both kinds of token are base64url, so [\w-]+ always takes all of one.
const SECRET_URL_TOKEN =
  /((?:\/|%2F)(?:support(?:\/|%2F)t|demo-day(?:\/|%2F)ticket)(?:\/|%2F))[\w-]+/gi;

/**
 * Rewrites every secret-URL token in a string, or in the strings of a plain
 * object or array, to the route pattern: /support/t/[token]. Built for Sentry's
 * beforeSend / beforeSendTransaction / beforeBreadcrumb, where a URL can turn
 * up in the request, the transaction name, a span or a breadcrumb.
 *
 * Copy-on-write, never in place: breadcrumb data can hold the app's own live
 * objects (console arguments), so only the containers along a changed path are
 * copied, and an input with nothing to scrub comes back as the same object.
 * Class instances (SDK internals riding on the event) are left alone; the
 * event that reaches beforeSend has already been normalized to plain data.
 */
export function redactSecretUrls<T>(value: T): T {
  return redact(value, 32, new WeakMap()) as T;
}

function redact(value: unknown, depth: number, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return value.replace(SECRET_URL_TOKEN, "$1[token]");
  if (typeof value !== "object" || value === null || depth === 0) return value;
  if (seen.has(value)) return seen.get(value);
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return value;
  // Shared references resolve to one result; a cycle back to an object still
  // being walked gets the original, and terminates.
  seen.set(value, value);
  const source = value as Record<string, unknown>;
  let copy: Record<string, unknown> | null = null;
  for (const key of Object.keys(source)) {
    const next = redact(source[key], depth - 1, seen);
    if (next === source[key]) continue;
    copy ??= (Array.isArray(value) ? [...value] : { ...source }) as Record<string, unknown>;
    copy[key] = next;
  }
  seen.set(value, copy ?? value);
  return copy ?? value;
}

/** Query strings can describe navigation, never authorize confirmation. */
export function payerReturnStatus(value: string | null): "canceled" | "pending" | "" {
  return value === "canceled" ? "canceled" : value === "complete" ? "pending" : "";
}
