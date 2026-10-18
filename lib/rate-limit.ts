import { createAdminClient } from "@/lib/supabase/admin";

export type RateLimitResult = { ok: boolean; count: number; limit: number };

/**
 * Atomically check + increment a counter keyed by (kind, identifier).
 * Backed by Postgres for serverless-safety. Returns ok=false once the
 * count exceeds `limit` within the rolling window.
 *
 * Failure mode: if the DB call errors, we *fail open* so a transient
 * Supabase outage doesn't lock all users out of login.
 */
export async function checkRateLimit(args: {
  kind: string;
  identifier: string;
  limit: number;
  windowSeconds: number;
}): Promise<RateLimitResult> {
  const key = rateLimitKey(args.kind, args.identifier);
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("rate_limit_check", {
      p_key: key,
      p_window_seconds: args.windowSeconds,
    });
    if (error) {
      console.error("[rate-limit] rpc error", error);
      return { ok: true, count: 0, limit: args.limit };
    }
    const count = (data as number) ?? 0;
    return { ok: count <= args.limit, count, limit: args.limit };
  } catch (err) {
    console.error("[rate-limit] failed", err);
    return { ok: true, count: 0, limit: args.limit };
  }
}

function rateLimitKey(kind: string, identifier: string): string {
  return `${kind}:${identifier}`.slice(0, 200);
}

/**
 * Forget a counter, so the next checkRateLimit for it starts again at one.
 *
 * With `limit: 1` the pair is a lease: the check that comes back ok holds it,
 * every other check in the window is refused, and clearing it hands it back
 * early. The window is the lease's ceiling — a holder that dies without
 * clearing (a function killed mid-request) frees it when the window ends.
 * Never throws: a lease that fails to clear just runs out.
 */
export async function clearRateLimit(args: { kind: string; identifier: string }): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("rate_limits")
      .delete()
      .eq("key", rateLimitKey(args.kind, args.identifier));
    if (error) console.error("[rate-limit] clear failed", error.message);
  } catch (err) {
    console.error("[rate-limit] clear failed", err);
  }
}

export function clientIp(req: Request): string {
  return clientIpFrom(req.headers);
}

/**
 * The same answer from a bare header list, for server actions, which get
 * `headers()` rather than a Request. The first x-forwarded-for hop is the one
 * Vercel's edge sets; x-real-ip covers other proxies. Both are
 * client-settable, so a limit keyed on this is a speed bump for a script,
 * not an identity.
 */
export function clientIpFrom(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  const first = fwd?.split(",")[0].trim();
  if (first) return first;
  return headers.get("x-real-ip")?.trim() || "unknown";
}
