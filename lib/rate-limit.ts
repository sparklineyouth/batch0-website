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
  const key = `${args.kind}:${args.identifier}`.slice(0, 200);
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

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
