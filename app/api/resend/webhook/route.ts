import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { verifySvixSignature, isFreshTimestamp } from "@/lib/svix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resend → batch0 email-event ingest.
 *
 * Resend delivers via Svix; verify the signature with the shared
 * secret, then persist the event into `email_events`. The PK is the
 * Svix message id so retries are naturally idempotent (the duplicate
 * insert returns a 23505 we swallow).
 *
 * The table is a raw delivery record. Nothing in the app reads it; query
 * it in the Supabase SQL editor (e.g. to trace a bounce).
 *
 * To configure: in the Resend dashboard create a webhook pointing at
 * `<site>/api/resend/webhook`, copy the signing secret into the
 * `RESEND_WEBHOOK_SECRET` env var, and subscribe to email.sent,
 * email.delivered, email.bounced, email.complained, email.opened,
 * email.clicked, email.failed, email.delivery_delayed and
 * email.suppressed. Without the last three, a message that never left
 * Resend leaves no row at all.
 */
export async function POST(req: Request) {
  const secret = env.resendWebhookSecret;
  if (!secret) {
    return NextResponse.json(
      { error: "Webhook not configured" },
      { status: 503 },
    );
  }

  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json(
      { error: "Missing Svix headers" },
      { status: 400 },
    );
  }

  // Body must be read as raw text — HMAC is computed over the exact
  // bytes Resend sent, so any JSON re-serialization would invalidate
  // the signature.
  const rawBody = await req.text();

  // Verification lives in lib/svix.ts so it can be tested — see
  // lib/svix.test.ts, which signs payloads the way Svix does rather than the
  // way we do, so the two constructions have to agree independently.
  if (
    !verifySvixSignature({
      secret,
      headers: { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
      rawBody,
    })
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // A signature stays valid forever, so a captured request could otherwise be
  // replayed indefinitely.
  if (!isFreshTimestamp(svixTimestamp)) {
    return NextResponse.json({ error: "Stale timestamp" }, { status: 400 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Resend payload shape (simplified):
  //   { type: "email.opened", created_at, data: { email_id, to, subject, ... } }
  const eventType = event?.type ?? "unknown";
  const data = event?.data ?? {};
  const recipient = Array.isArray(data.to) ? data.to[0] : data.to ?? null;
  const subject = typeof data.subject === "string" ? data.subject : null;
  const emailId =
    typeof data.email_id === "string"
      ? data.email_id
      : typeof data.id === "string"
        ? data.id
        : null;
  const occurredAt =
    typeof event.created_at === "string"
      ? event.created_at
      : new Date().toISOString();

  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v : null;

  // The event-specific sub-objects. Each only appears on its own event type,
  // so these are all null on an ordinary delivered/opened event.
  const bounce = data.bounce ?? {};
  const click = data.click ?? {};
  const tags =
    data.tags && typeof data.tags === "object" && !Array.isArray(data.tags)
      ? (data.tags as Record<string, unknown>)
      : null;

  // Everything worth querying, lifted out of the payload into columns. The
  // payload is still stored whole; these just make SQL queries easy.
  const detail = {
    broadcast_id: str(data.broadcast_id),
    // Set by lib/email/send.ts on every send it makes, so each event maps to
    // its template exactly.
    template_key: str(tags?.template) ?? str(tags?.template_key),
    bounce_type: str(bounce.type),
    bounce_subtype: str(bounce.subType),
    bounce_message: str(bounce.message),
    click_link: str(click.link),
    // Opens carry no sub-object, so the user agent has to be read from the
    // click for clicks and from the top level for opens — Resend puts it in
    // different places depending on the event.
    user_agent: str(click.userAgent) ?? str(data.user_agent) ?? str(data.userAgent),
    ip_address: str(click.ipAddress) ?? str(data.ip_address) ?? str(data.ipAddress),
    failure_reason: str(data.failed?.reason) ?? str(data.suppressed?.message),
    tags,
  };

  const base = {
    svix_id: svixId,
    event_type: eventType,
    resend_email_id: emailId,
    recipient,
    subject,
    payload: event,
    occurred_at: occurredAt,
  };

  const admin = createAdminClient();
  let { error } = await admin.from("email_events").insert({ ...base, ...detail });

  // A deploy can land before `supabase db push` does, and for those few minutes
  // the detail columns don't exist yet. Losing the event entirely over that
  // would be the wrong trade — Resend retries a handful of times and then drops
  // it for good, so the data would be gone permanently to save a column that
  // arrives an hour later. Retry with the 0024 column set and keep the payload,
  // which migration 0057 backfills from.
  if (error && isUnknownColumn(error)) {
    console.warn(
      "[resend webhook] detail columns missing — run migration 0057; storing base row",
    );
    ({ error } = await admin.from("email_events").insert(base));
  }

  if (error) {
    // 23505 = unique violation = duplicate delivery. That's expected
    // and means we've already processed this event; ack so Resend
    // doesn't retry forever.
    if ((error as any).code === "23505") {
      return NextResponse.json({ received: true, deduped: true });
    }
    console.error("[resend webhook] insert failed", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

/**
 * PostgREST rejects an unknown column with PGRST204 before the statement ever
 * reaches Postgres; 42703 is the raw Postgres code for the same thing, which is
 * what surfaces when the schema cache is warm but the column isn't there.
 */
function isUnknownColumn(error: unknown): boolean {
  const code = (error as any)?.code;
  if (code === "PGRST204" || code === "42703") return true;
  return /column .* does not exist|could not find the .* column/i.test(
    (error as any)?.message ?? "",
  );
}
