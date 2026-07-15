import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { nextBatchDefaults } from "@/lib/founder-pass-batch";
import { onshapeConfigFromEnv } from "@/lib/onshape";
import { PassesPanel, type PassRow, type BatchSummary } from "./passes-panel";

export const metadata = { title: "Founder passes · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminPassesPage() {
  const admin = createAdminClient();

  const { data } = await admin
    .from("founder_passes")
    .select("serial, batch, redeemed_by, redeemed_at, revoked_at, note")
    .order("serial", { ascending: true });

  const raw = (data ?? []) as Array<{
    serial: number;
    batch: string;
    redeemed_by: string | null;
    redeemed_at: string | null;
    revoked_at: string | null;
    note: string | null;
  }>;

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

  const next = await nextBatchDefaults(admin);

  // Whether THIS environment can mint. On Vercel that means the Onshape keys
  // are present; locally it means .env.local has them. Checked server-side so
  // the button can explain itself instead of failing on click.
  const canMint = onshapeConfigFromEnv() !== null && !!process.env.FOUNDER_PASS_PEPPER;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-8">
        <h1 className="font-display text-3xl text-ink">Founder passes</h1>
        <p className="mt-2 text-sm text-ink-soft">
          Each row is one 3D-printed card. Minting generates the code and
          embosses it into the STL in the same step — the database only ever
          stores a peppered hash, so a code exists in exactly two places: the
          plastic, and the manifest.csv inside your download.
        </p>
      </div>

      <PassesPanel
        rows={rows}
        batches={batches}
        nextSerial={next.start}
        nextBatch={next.batch}
        canMint={canMint}
      />

      <Card className="mt-8">
        <h2 className="text-sm font-semibold text-ink">If a code list leaks</h2>
        <p className="mt-2 text-sm text-ink-soft">
          Revoke the batch. Codes are printed on physical objects and can never
          be rotated, so a leaked list means those cards are finished — revoking
          kills them without touching any other print run. Revoked passes stay
          listed as a record that the serial was issued; the serial is never
          reused, because a card bearing that number still exists somewhere.
        </p>
      </Card>
    </div>
  );
}
