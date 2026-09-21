/** Runs before page scripts: the bearer invitation never stays in the URL. */
export const PAYMENT_FRAGMENT_SCRIPT = `(function(){if(location.pathname.replace(/\\/$/,'')==='/pay'){window['ga-disable-G-C51DMRB6YE']=true;var token=new URLSearchParams(location.hash.slice(1)).get('token');if(token&&/^[A-Za-z0-9_-]{43}$/.test(token)){window.__batch0PayerToken=token;}var session=new URLSearchParams(location.hash.slice(1)).get('session_id');if(session&&/^cs_(?:test|live)_[A-Za-z0-9]+$/.test(session)){window.__batch0CheckoutSession=session;}if(location.hash){history.replaceState(history.state,'',location.pathname+location.search);}}})();`;

export function isPrivatePaymentPath(path: string | null): boolean {
  return path === "/pay" || !!path?.startsWith("/pay/");
}

/** Query strings can describe navigation, never authorize confirmation. */
export function payerReturnStatus(value: string | null): "canceled" | "pending" | "" {
  return value === "canceled" ? "canceled" : value === "complete" ? "pending" : "";
}
