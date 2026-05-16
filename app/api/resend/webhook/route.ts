import { NextResponse } from "next/server";
import crypto from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resend → SparkLine Youth email-event ingest.
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

  if (!verifySvixSignature({
    secret,
    svixId,
    svixTimestamp,
    svixSignature,
    rawBody,
  })) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Reject timestamps more than 5 minutes off — Svix's recommendation
  // to prevent replay if a signature ever leaks.
  const tsSeconds = Number(svixTimestamp);
  if (
    !Number.isFinite(tsSeconds) ||
    Math.abs(Date.now() / 1000 - tsSeconds) > 5 * 60
  ) {
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

/**
 * Svix signature verification.
 *
 * Spec: HMAC-SHA256 of `${svixId}.${svixTimestamp}.${rawBody}` using
 * the secret (base64-decoded after stripping the `whsec_` prefix).
 * The header may contain multiple signatures separated by spaces, each
 * prefixed with `v1,`. Match against any of them in constant time.
 */
function verifySvixSignature(args: {
  secret: string;
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
  rawBody: string;
}): boolean {
  const cleanSecret = args.secret.startsWith("whsec_")
    ? args.secret.slice("whsec_".length)
    : args.secret;
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(cleanSecret, "base64");
  } catch {
    return false;
  }
  const preimage = `${args.svixId}.${args.svixTimestamp}.${args.rawBody}`;
  const expected = crypto
    .createHmac("sha256", secretBytes)
    .update(preimage)
    .digest("base64");

  const expectedBuf = Buffer.from(expected, "utf8");
  for (const part of args.svixSignature.split(" ")) {
    const [, sig] = part.split(",");
    if (!sig) continue;
    const candidateBuf = Buffer.from(sig, "utf8");
    if (
      candidateBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(candidateBuf, expectedBuf)
    ) {
      return true;
    }
  }
  return false;
}
