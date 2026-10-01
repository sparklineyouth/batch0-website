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

/** Query strings can describe navigation, never authorize confirmation. */
export function payerReturnStatus(value: string | null): "canceled" | "pending" | "" {
  return value === "canceled" ? "canceled" : value === "complete" ? "pending" : "";
}
