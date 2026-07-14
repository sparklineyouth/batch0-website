import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { ApplicationsBulkList } from "./bulk-list";
import { Sparkles } from "lucide-react";

export const metadata = { title: "Applications · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminApplicationsPage({
  searchParams,
}: {
  searchParams: { status?: string; sort?: string };
}) {
  const admin = createAdminClient();
  const status = searchParams.status;
  const sort = searchParams.sort === "score" ? "score" : "recent";

  let q = admin
    .from("applications")
    .select(
      "id, full_name, age, status, created_at, submitted_at, why_join, ai_score, ai_reviewed_at, profile:profiles!applications_user_id_fkey(email)",
    );
  if (sort === "score") {
    // Highest score first, unscored last. Supabase's PostgREST treats
    // NULLs as "less than" by default in descending order, which is what
    // we want — top scores rise to the top, unscored applications sink.
    q = q
      .order("ai_score", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });
  } else {
    q = q.order("created_at", { ascending: false });
  }
  if (status && status !== "all") q = q.eq("status", status);
  const { data: apps } = await q;

  const filters = ["all", "submitted", "accepted", "rejected", "paid", "draft"];
  const sortParam = (s: string) => {
    const params = new URLSearchParams();
    if (status && status !== "all") params.set("status", status);
    if (s !== "recent") params.set("sort", s);
    const qs = params.toString();
    return qs ? `/admin/applications?${qs}` : "/admin/applications";
  };

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Applications</h1>
          <p className="mt-1 text-sm text-ink-faint">
            Review and decide on applications.
          </p>
        </div>
        <a
          href="/api/admin/export/applications"
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-wash px-3 py-1.5 text-xs font-medium text-ink hover:border-ink/30 hover:bg-wash"
        >
          Export CSV
        </a>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {filters.map((f) => {
          const active = (status ?? "all") === f;
          const params = new URLSearchParams();
          if (f !== "all") params.set("status", f);
          if (sort === "score") params.set("sort", "score");
          const qs = params.toString();
          const href = qs ? `/admin/applications?${qs}` : "/admin/applications";
          return (
            <Link
              key={f}
              href={href}
              className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
                active
                  ? "border-phosphor/30 bg-phosphor/10 text-phosphor-ink"
                  : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
              }`}
            >
              {f}
            </Link>
          );
        })}
        <span className="ml-2 h-4 w-px bg-line" aria-hidden />
        <span className="text-[10px] font-mono uppercase tracking-wider text-ink-faint">
          Sort
        </span>
        <Link
          href={sortParam("recent")}
          className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
            sort === "recent"
              ? "border-phosphor/30 bg-phosphor/10 text-phosphor-ink"
              : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
          }`}
        >
          Newest
        </Link>
        <Link
          href={sortParam("score")}
          className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs uppercase tracking-wider transition ${
            sort === "score"
              ? "border-phosphor/30 bg-phosphor/10 text-phosphor-ink"
              : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
          }`}
        >
          <Sparkles className="h-3 w-3" />
          AI score
        </Link>
      </div>

      <Card className="mt-6 !p-0 overflow-hidden">
        <ApplicationsBulkList
          apps={(apps ?? []).map((a: any) => ({
            id: a.id,
            full_name: a.full_name,
            age: a.age,
            status: a.status,
            submitted_at: a.submitted_at,
            ai_score: a.ai_score,
            ai_reviewed_at: a.ai_reviewed_at,
            profile: a.profile ?? null,
          }))}
        />
      </Card>
    </div>
  );
}
