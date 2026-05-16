import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";

export const metadata = { title: "SAFE offers · Team" };

const STATUS_TONE: Record<string, string> = {
  sent: "bg-spark/10 text-spark border-spark/30",
  accepted: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30",
  declined: "bg-zinc-500/10 text-zinc-300 border-zinc-500/30",
  withdrawn: "bg-zinc-500/10 text-zinc-400 border-zinc-500/30",
  countersigned: "bg-spark/10 text-spark border-spark/30",
  draft: "bg-zinc-500/10 text-zinc-300 border-zinc-500/30",
};

export default async function TeamOffersPage() {
  const user = await requireUser();
  const admin = createAdminClient();
  const { data: members } = await admin
    .from("team_members")
    .select("team_id, team:teams(id, name)")
    .eq("user_id", user.id);
  if (!members || members.length === 0) {
    redirect("/dashboard/team");
  }
  const teamIds = members.map((m: any) => m.team_id);

  const { data: offers } = await admin
    .from("safe_offers")
    .select(
      "id, team_id, status, amount_cents, valuation_cap_cents, discount_pct, sent_at, created_at, investor:profiles(full_name, email), team:teams(name)",
    )
    .in("team_id", teamIds)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/dashboard/team"
        className="text-sm text-white/55 hover:text-white"
      >
        ← Team
      </Link>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">SAFE offers</h1>
      <p className="mt-1 text-sm text-white/55">
        Every investor offer routed through SparkLine Youth. Review carefully — these
        are real legal commitments once counter-signed.
      </p>

      {(offers?.length ?? 0) === 0 ? (
        <Card className="mt-6">
          <p className="text-sm text-white/55">
            No offers yet. When an investor sends a SAFE, it shows up here and
            we'll email every team member.
          </p>
        </Card>
      ) : (
        <ul className="mt-6 space-y-3">
          {(offers ?? []).map((o: any) => {
            const inv = Array.isArray(o.investor) ? o.investor[0] : o.investor;
            return (
              <li key={o.id}>
                <Link href={`/dashboard/team/offers/${o.id}`}>
                  <Card className="transition hover:border-white/20">
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <div>
                        <p className="text-base font-semibold text-white">
                          ${(o.amount_cents / 100).toLocaleString()}
                          {o.valuation_cap_cents != null && (
                            <span className="ml-1 text-sm font-normal text-white/55">
                              · cap $
                              {(o.valuation_cap_cents / 100).toLocaleString()}
                            </span>
                          )}
                          {o.discount_pct != null && (
                            <span className="ml-1 text-sm font-normal text-white/55">
                              · {o.discount_pct}% disc
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 text-xs text-white/55">
                          From <strong>{inv?.full_name ?? inv?.email ?? "investor"}</strong>
                          {o.sent_at && (
                            <>
                              {" "}
                              · sent{" "}
                              <LocalTime value={o.sent_at} mode="date" />
                            </>
                          )}
                        </p>
                      </div>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_TONE[o.status] ?? ""}`}
                      >
                        {o.status}
                      </span>
                    </div>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
