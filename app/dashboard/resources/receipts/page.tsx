import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStudentAccess } from "@/lib/access";
import { isAcceptedStatus } from "@/lib/pre-cohort";
import {
  earnedBadges,
  receiptKindLabel,
  type ReceiptKind,
} from "@/lib/receipts";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { ReceiptForm, DeleteReceiptButton } from "./receipt-form";
import { Award, ExternalLink } from "lucide-react";

export const metadata = { title: "Build receipts · batch0" };

export default async function BuildReceiptsPage() {
  const user = await requireUser();
  const profile = await getProfile();
  const role = profile?.role ?? "student";
  const access = await getStudentAccess(role);
  const accepted = isAcceptedStatus(access.applicationStatus);
  const fullAccess = access.enrolled && !access.preCohort;
  if (!fullAccess && !accepted) redirect("/dashboard/resources");

  const isAdmin = role === "admin";
  const admin = createAdminClient();

  // The viewer's cohorts decide which receipts they see (staff see all).
  const [{ data: enrollments }, { data: app }] = await Promise.all([
    admin.from("enrollments").select("cohort_id").eq("user_id", user.id),
    admin
      .from("applications")
      .select("cohort_id")
      .eq("user_id", user.id)
      .in("status", ["accepted", "paid", "enrolled"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const cohortIds = Array.from(
    new Set(
      [...(enrollments ?? []).map((e: any) => e.cohort_id), app?.cohort_id]
        .filter(Boolean) as string[],
    ),
  );

  let feedQuery = admin
    .from("build_receipts")
    .select("*, author:profiles(full_name, email)")
    .order("created_at", { ascending: false })
    .limit(100);
  if (!isAdmin && role !== "mentor") {
    feedQuery = cohortIds.length
      ? feedQuery.or(
          `user_id.eq.${user.id},cohort_id.in.(${cohortIds.join(",")})`,
        )
      : feedQuery.eq("user_id", user.id);
  }
  const { data: receipts } = await feedQuery;

  // Badges come from the viewer's own receipts.
  const counts: Partial<Record<ReceiptKind, number>> = {};
  for (const r of receipts ?? []) {
    if (r.user_id !== user.id) continue;
    counts[r.kind as ReceiptKind] = (counts[r.kind as ReceiptKind] ?? 0) + 1;
  }
  const badges = earnedBadges(counts);

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/dashboard/resources"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Resources
      </Link>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">
        Build receipts
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        Proof of work, visible to your cohort. Post what you actually did —
        interviews, landing pages, experiments, killed ideas. Credibility here
        comes from evidence, not likes.
      </p>

      {badges.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-2">
          {badges.map((b) => (
            <span
              key={b.id}
              title={b.hint}
              className="inline-flex items-center gap-1.5 rounded-full border border-phosphor/30 bg-phosphor/[0.08] px-3 py-1 text-xs font-medium text-phosphor-ink"
            >
              <Award className="h-3.5 w-3.5" /> {b.label}
            </span>
          ))}
        </div>
      )}

      <div className="mt-6">
        <ReceiptForm />
      </div>

      <ul className="mt-8 space-y-3">
        {(receipts ?? []).map((r: any) => {
          const author = Array.isArray(r.author) ? r.author[0] : r.author;
          const name = author?.full_name ?? author?.email ?? "A founder";
          const canDelete = isAdmin || r.user_id === user.id;
          return (
            <li key={r.id}>
              <Card>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-ink">{name}</p>
                      <span className="rounded-full bg-phosphor/15 px-2 py-0.5 text-[10px] font-mono font-semibold uppercase tracking-wider text-phosphor-ink">
                        {receiptKindLabel(r.kind)}
                      </span>
                      <span className="text-xs text-ink-faint">
                        <LocalTime value={r.created_at} mode="date" />
                      </span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-ink-soft">
                      {r.body}
                    </p>
                    {r.link_url && (
                      <a
                        href={r.link_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 inline-flex items-center gap-1 text-xs text-phosphor-ink hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {r.link_url}
                      </a>
                    )}
                  </div>
                  {canDelete && <DeleteReceiptButton id={r.id} />}
                </div>
              </Card>
            </li>
          );
        })}
        {(receipts?.length ?? 0) === 0 && (
          <Card>
            <p className="text-sm text-ink-soft">
              No receipts yet. Be the first — post the interview you did, the
              page you shipped, or the idea you killed.
            </p>
          </Card>
        )}
      </ul>
    </div>
  );
}
