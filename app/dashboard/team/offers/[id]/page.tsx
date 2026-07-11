import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { OfferActions } from "./offer-actions";

export const metadata = { title: "SAFE offer · Team" };

export default async function TeamOfferPage({
  params,
}: {
  params: { id: string };
}) {
  const user = await requireUser();
  const admin = createAdminClient();

  const { data: offer } = await admin
    .from("safe_offers")
    .select(
      "*, investor:profiles(full_name, email), team:teams(id, name)",
    )
    .eq("id", params.id)
    .maybeSingle();
  if (!offer) notFound();

  const { data: membership } = await admin
    .from("team_members")
    .select("user_id")
    .eq("team_id", offer.team_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) notFound();

  const investor = Array.isArray((offer as any).investor)
    ? (offer as any).investor[0]
    : (offer as any).investor;
  const team = Array.isArray((offer as any).team)
    ? (offer as any).team[0]
    : (offer as any).team;

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/dashboard/team/offers"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Offers
      </Link>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">
        SAFE — ${(offer.amount_cents / 100).toLocaleString()}
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        From {investor?.full_name ?? investor?.email ?? "investor"} · status{" "}
        <strong className="text-ink">{offer.status}</strong>
      </p>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
          Terms
        </h2>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Field
            label="Amount"
            value={`$${(offer.amount_cents / 100).toLocaleString()}`}
          />
          {offer.valuation_cap_cents != null && (
            <Field
              label="Cap"
              value={`$${(offer.valuation_cap_cents / 100).toLocaleString()}`}
            />
          )}
          {offer.discount_pct != null && (
            <Field label="Discount" value={`${offer.discount_pct}%`} />
          )}
          <Field label="MFN" value={offer.mfn ? "Yes" : "No"} />
          <Field label="Pro-rata" value={offer.pro_rata ? "Yes" : "No"} />
        </div>
      </Card>

      {offer.document_md && (
        <Card className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
            Memo
          </h2>
          <pre className="mt-4 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-paper p-4 text-xs leading-relaxed text-ink-soft">
            {offer.document_md}
          </pre>
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
          Signatures
        </h2>
        <ul className="mt-4 space-y-3 text-sm">
          <li>
            <span className="text-xs uppercase tracking-wider text-ink-faint">
              Investor
            </span>
            {offer.investor_signed_at ? (
              <p className="mt-0.5">
                <strong>{offer.investor_signature_name ?? "Signed"}</strong>{" "}
                <span className="text-ink-faint">
                  · <LocalTime value={offer.investor_signed_at} />
                </span>
              </p>
            ) : (
              <p className="mt-0.5 text-ink-faint">Not signed</p>
            )}
          </li>
          <li>
            <span className="text-xs uppercase tracking-wider text-ink-faint">
              Team
            </span>
            {offer.team_signed_at ? (
              <p className="mt-0.5">
                <strong>{offer.team_signature_name ?? "Signed"}</strong>{" "}
                <span className="text-ink-faint">
                  · <LocalTime value={offer.team_signed_at} />
                </span>
              </p>
            ) : (
              <p className="mt-0.5 text-ink-faint">Awaiting counter-signature</p>
            )}
          </li>
        </ul>
      </Card>

      {offer.status === "sent" && (
        <Card className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
            Take action
          </h2>
          <OfferActions offerId={offer.id} />
        </Card>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-ink-faint">
        {label}
      </p>
      <p className="mt-0.5 text-ink">{value}</p>
    </div>
  );
}
