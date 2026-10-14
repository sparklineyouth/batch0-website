import { createAdminClient } from "@/lib/supabase/admin";
import { nextBatchDefaults } from "@/lib/founder-pass-batch";
import { onshapeConfigFromEnv } from "@/lib/onshape";
import { env } from "@/lib/env";
import { transportStatus } from "@/lib/email/send";
import { passTier, normalizeDiscountCents } from "@/lib/founder-pass-tiers";
import { PassesPanel, type PassRow, type BatchSummary } from "./passes-panel";

export const metadata = { title: "Founder passes · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminPassesPage() {
  const admin = createAdminClient();

  // Independent of the row/holder reads below, so it runs alongside them.
  // Kept as the shared helper (not derived from the rows fetched here): its
  // order-desc/limit-1 max is immune to PostgREST's row cap, so it stays the
  // one source of truth the CLI also uses.
  const nextPromise = nextBatchDefaults(admin);
  // The virtual side numbers its own runs (virtual-NN) off the same serial
  // sequence — see lib/founder-pass-batch.ts.
  const nextVirtualPromise = nextBatchDefaults(admin, "virtual");

  // select("*") rather than a column list on purpose. This repo's migrations
  // are applied by hand in the Supabase SQL editor (see PRODUCTION_READINESS),
  // so this page can deploy before 0054 has run. Naming kind/issued_to_email
  // explicitly would turn that gap into a 500 on the whole passes admin; with
  // a star select the columns are simply absent and the mapping below defaults
  // them, exactly the way lib/founder-pass.ts tolerates 0041.
  const { data } = await admin
    .from("founder_passes")
    .select("*")
    .order("serial", { ascending: true });

  const raw = ((data ?? []) as Array<{
    serial: number;
    batch: string;
    redeemed_by: string | null;
    redeemed_at: string | null;
    revoked_at: string | null;
    note: string | null;
    // Migration 0054. Optional so the shape still matches a database where it
    // hasn't been applied.
    kind?: string | null;
    issued_to_email?: string | null;
    issued_at?: string | null;
    // Migration 0055, optional for the same reason.
    tier?: string | null;
    recipient_name?: string | null;
    // Migration 0056.
    discount_cents?: number | null;
  }>);

  // Resolve holder names in one query rather than per row — same batching the
  // applications queue uses for referrers.
  const holderIds = Array.from(
    new Set(raw.map((r) => r.redeemed_by).filter(Boolean) as string[]),
  );
  const nameById = new Map<string, string>();
  if (holderIds.length) {
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, full_name, email")
      .in("id", holderIds);
    for (const p of (profiles ?? []) as Array<{
      id: string;
      full_name: string | null;
      email: string | null;
    }>) {
      nameById.set(p.id, p.full_name || p.email || "Unknown");
    }
  }

  const rows: PassRow[] = raw.map((r) => ({
    serial: r.serial,
    batch: r.batch,
    holder: r.redeemed_by ? nameById.get(r.redeemed_by) ?? "Unknown" : null,
    redeemedAt: r.redeemed_at,
    revoked: !!r.revoked_at,
    // Every pre-0054 row was printed, so "card" is the right read for a
    // missing column, not a guess — same reasoning as the column default.
    kind: r.kind === "virtual" ? "virtual" : "card",
    issuedTo: r.issued_to_email ?? null,
    recipientName: r.recipient_name ?? null,
    // passTier() resolves an absent or unrecognised key to standard, which is
    // exactly what a pre-0055 row is.
    tier: passTier(r.tier).key,
    // The hand-set override (0056). It belongs in the ledger for the same
    // reason the tier does: it is money off someone's tuition that nobody can
    // reconstruct later — the admin's screen at issue time was the only place
    // it was ever shown, and that screen is gone on refresh.
    discountCents: normalizeDiscountCents(r.discount_cents),
  }));

  const batches: BatchSummary[] = Array.from(
    rows.reduce((map, r) => {
      const b = map.get(r.batch) ?? {
        batch: r.batch,
        total: 0,
        redeemed: 0,
        revoked: 0,
      };
      b.total++;
      if (r.holder) b.redeemed++;
      if (r.revoked) b.revoked++;
      map.set(r.batch, b);
      return map;
    }, new Map<string, BatchSummary>()),
  ).map(([, v]) => v);

  const [next, nextVirtual] = await Promise.all([nextPromise, nextVirtualPromise]);

  // Whether THIS environment can mint. On Vercel that means the Onshape keys
  // are present; locally it means .env.local has them. Checked server-side so
  // the button can explain itself instead of failing on click.
  const canMint = onshapeConfigFromEnv() !== null && !!process.env.FOUNDER_PASS_PEPPER;

  // The same self-explanation for the virtual side. Emailing a pass needs no
  // Onshape at all — just a mailer and the pepper — which is exactly why it
  // works in environments where minting cards doesn't.
  //
  // Through transportStatus(), NOT process.env.RESEND_API_KEY.
  //
  // Which mailer is live is a DATABASE setting an admin picks at
  // /admin/email/settings, not an environment variable. Reading the Resend key
  // asks the wrong source: it happens to agree while that setting says
  // "resend", and stops agreeing the moment someone switches to SMTP — which
  // the product exists to support, and which the settings page recommends when
  // a domain isn't verified. On that install the button would switch itself
  // off with the whole mail path working, and blame a key that changes
  // nothing. transportStatus() is the one function that knows, it actually
  // connects to SMTP before answering, and it is what /admin/email/settings
  // reports from — so the two pages can't disagree about whether email works.
  const transport = await transportStatus();
  const hasPepper = !!process.env.FOUNDER_PASS_PEPPER;
  const canEmail = transport.ok && hasPepper;
  const emailDetail = !hasPepper
    ? "FOUNDER_PASS_PEPPER isn't set in this environment, so no code can be hashed here."
    : transport.ok
      ? transport.detail
      : `${transport.detail} Fix it at /admin/email/settings.`;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-8">
        <h1 className="font-display text-3xl text-ink">Founder passes</h1>
        <p className="mt-2 text-sm text-ink-soft">
          One row per pass. Leaked codes? Revoke the batch.
        </p>
      </div>

      <PassesPanel
        rows={rows}
        batches={batches}
        nextSerial={next.start}
        nextBatch={next.batch}
        nextVirtualBatch={nextVirtual.batch}
        canMint={canMint}
        canEmail={canEmail}
        emailDetail={emailDetail}
        contactEmail={env.contactEmail}
      />
    </div>
  );
}
