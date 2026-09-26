import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { getChallengeById, mergeQualifiedReferrals, shortName } from "@/lib/challenges";

export const metadata = { title: "Registrations · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Everyone who registered, who brought them, how many they've brought, and
 * where their entry stands. The referral column uses the same rule the submit
 * gate does (mergeQualifiedReferrals), so what an admin sees here is exactly
 * what the entrant is being held to.
 */
export default async function RegistrationsPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  await requirePermission("challenges.manage");
  const challenge = await getChallengeById(id);
  if (!challenge) notFound();
  const admin = createAdminClient();

  const [{ data: regs }, { data: subs }, { data: apps }] = await Promise.all([
    admin
      .from("challenge_registrations")
      .select("user_id, referral_code, created_at, profile:profiles!challenge_registrations_user_id_fkey(full_name, email, referral_code)")
      .eq("challenge_id", id)
      .order("created_at", { ascending: false })
      .limit(2000),
    admin.from("challenge_submissions").select("user_id, status").eq("challenge_id", id),
    admin
      .from("applications")
      .select("user_id, submitted_at, referral_code")
      .not("referral_code", "is", null)
      .neq("status", "draft")
      .gte("submitted_at", challenge.createdAt)
      .limit(5000),
  ]);

  const rows = (regs ?? []).map((r: any) => {
    const p = Array.isArray(r.profile) ? r.profile[0] : r.profile;
    return {
      userId: r.user_id as string,
      referralCode: (r.referral_code as string | null) ?? null,
      at: r.created_at as string,
      name: (p?.full_name as string | null) ?? null,
      email: (p?.email as string | null) ?? null,
      ownCode: ((p?.referral_code as string | null) ?? "").toLowerCase(),
    };
  });

  const byCode = new Map(rows.filter((r) => r.ownCode).map((r) => [r.ownCode, r]));
  const statusByUser = new Map((subs ?? []).map((s: any) => [s.user_id as string, s.status as string]));

  // Qualified referral count per registrant, computed in one pass.
  const regsByCode = new Map<string, { user_id: string; created_at: string }[]>();
  for (const r of rows) {
    if (!r.referralCode) continue;
    const k = r.referralCode.toLowerCase();
    regsByCode.set(k, [...(regsByCode.get(k) ?? []), { user_id: r.userId, created_at: r.at }]);
  }
  const appsByCode = new Map<string, { user_id: string; submitted_at: string | null }[]>();
  for (const a of (apps ?? []) as any[]) {
    const k = String(a.referral_code).toLowerCase();
    appsByCode.set(k, [...(appsByCode.get(k) ?? []), { user_id: a.user_id, submitted_at: a.submitted_at }]);
  }
  const referredCount = (r: (typeof rows)[number]) =>
    r.ownCode
      ? mergeQualifiedReferrals(
          { registrations: regsByCode.get(r.ownCode) ?? [], applications: appsByCode.get(r.ownCode) ?? [] },
          { referrerId: r.userId, since: challenge.createdAt },
        ).length
      : 0;

  const need = challenge.referralsRequired;

  return (
    <div>
      <p className="text-sm text-ink-faint">
        {rows.length} registered
        {need > 0 && ` · entrants need ${need} qualified referral${need === 1 ? "" : "s"} to submit`}
      </p>
      {rows.length === 0 ? (
        <Card className="mt-5">
          <p className="text-sm text-ink-soft">Nobody has registered yet. Share the page link to get it going.</p>
        </Card>
      ) : (
        <Card className="mt-5 !p-0 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-line font-mono text-[11px] uppercase tracking-wider text-ink-faint">
              <tr>
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-3 py-3 font-medium">Registered</th>
                <th className="px-3 py-3 font-medium">Referred by</th>
                <th className="px-3 py-3 font-medium">Referrals</th>
                <th className="px-5 py-3 font-medium">Entry</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => {
                const referrer = r.referralCode ? byCode.get(r.referralCode.toLowerCase()) : null;
                const n = referredCount(r);
                const status = statusByUser.get(r.userId);
                return (
                  <tr key={r.userId}>
                    <td className="px-5 py-3">
                      <p className="font-medium text-ink">{r.name ?? "—"}</p>
                      <p className="text-xs text-ink-faint">{r.email}</p>
                    </td>
                    <td className="px-3 py-3 text-xs text-ink-soft">
                      <LocalTime value={r.at} mode="datetime-short" />
                    </td>
                    <td className="px-3 py-3 text-xs text-ink-soft">
                      {referrer ? shortName(referrer.name) : r.referralCode ? <span className="font-mono">{r.referralCode}</span> : "—"}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs">
                      <span className={need > 0 && n >= need ? "text-phosphor-ink" : "text-ink-soft"}>
                        {n}
                        {need > 0 ? `/${need}` : ""}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      {status ? (
                        <StatusBadge status={status === "funded" ? "winner" : status} />
                      ) : (
                        <span className="text-xs text-ink-faint">not started</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      <p className="mt-3 text-xs text-ink-faint">
        Referral counts include friends who registered here or applied to a cohort through the entrant&apos;s
        link since this challenge was created. <Link href="/admin/referrals" className="underline">All referrals →</Link>
      </p>
    </div>
  );
}
