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
 * The aggregate admin page at /admin/email reads this table to compute
 * delivered/opened/clicked rates per template (grouped by subject
 * prefix, since the existing transactional sends don't tag).
 *
 * To configure: in the Resend dashboard create a webhook pointing at
 * `<site>/api/resend/webhook`, copy the signing secret into the
 * `RESEND_WEBHOOK_SECRET` env var, and subscribe to email.sent,
 * email.delivered, email.bounced, email.complained, email.opened,
 * email.clicked.
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

  const admin = createAdminClient();
  const { error } = await admin.from("email_events").insert({
    svix_id: svixId,
    event_type: eventType,
    resend_email_id: emailId,
    recipient,
    subject,
    payload: event,
    occurred_at: occurredAt,
  });

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
