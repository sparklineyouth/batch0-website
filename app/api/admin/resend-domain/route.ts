import { NextResponse } from "next/server";
import { Resend } from "resend";
import { getProfile } from "@/lib/auth";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Admin utility: manage the Resend sending domain without touching the
 * Resend dashboard. The API key never leaves the server — this route
 * exists because the key is stored write-only in Vercel, so domain
 * setup has to happen where the key is available.
 *
 *   GET  /api/admin/resend-domain            → list domains + status
 *   POST /api/admin/resend-domain            → { action: "create", name }
 *                                              { action: "verify", id }
 *
 * Safe to keep deployed: admin-gated, and it can only configure the
 * domain of the Resend account the key belongs to.
 */

async function guard() {
  const actor = await getProfile();
  if (actor?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!env.resendApiKey) {
    return NextResponse.json(
      { error: "RESEND_API_KEY is not configured" },
      { status: 503 },
    );
  }
  return null;
}

export async function GET() {
  const denied = await guard();
  if (denied) return denied;
  const resend = new Resend(env.resendApiKey);
  const { data, error } = await resend.domains.list();
  if (error) return NextResponse.json({ error: error.message }, { status: 502 });

  // Include per-domain DNS records so a pending domain's records can be
  // re-fetched at any time.
  const domains = [];
  for (const d of data?.data ?? []) {
    const detail = await resend.domains.get(d.id);
    domains.push(detail.data ?? d);
  }
  return NextResponse.json({ domains });
}

export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  const resend = new Resend(env.resendApiKey);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.action === "create") {
    const name = String(body.name ?? "").trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(name)) {
      return NextResponse.json({ error: "Invalid domain" }, { status: 400 });
    }
    const { data, error } = await resend.domains.create({ name });
    if (error)
      return NextResponse.json({ error: error.message }, { status: 502 });
    return NextResponse.json({ domain: data });
  }

  if (body.action === "verify") {
    const id = String(body.id ?? "");
    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
    const { error } = await resend.domains.verify(id);
    if (error)
      return NextResponse.json({ error: error.message }, { status: 502 });
    const detail = await resend.domains.get(id);
    return NextResponse.json({ domain: detail.data });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
