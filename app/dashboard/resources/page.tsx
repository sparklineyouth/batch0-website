import Link from "next/link";
import { requireUser, getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import {
  FileText,
  ExternalLink,
  Download,
  Sparkles,
  ArrowRight,
  CheckCircle,
  CircleDashed,
  Receipt,
} from "lucide-react";
import { getStudentAccess } from "@/lib/access";
import { fmtDateOnly, isAcceptedStatus } from "@/lib/pre-cohort";
import { FLOW_STAGES } from "@/lib/flows";
import { LockedFeature } from "@/components/dashboard/locked-feature";

export const metadata = { title: "Resources · batch0" };

function fmtBytes(n: number | null) {
  if (!n) return null;
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export default async function DashboardResourcesPage() {
  const user = await requireUser();
  const profile = await getProfile();
  const access = await getStudentAccess(profile?.role ?? "student");
  const accepted = isAcceptedStatus(access.applicationStatus);

  // Three views:
  //  - full: enrolled with a started cohort (admins report enrolled from
  //    getStudentAccess, so they preview this) — everything, with
  //    pre-cohort items grouped in their own section up top.
  //  - pre-cohort section only: accepted (or enrolled pre-kickoff).
  //    Acceptance alone keeps this section even after the cohort starts —
  //    an accepted-but-unpaid student must not watch materials vanish on
  //    kickoff day (the 0042 RLS policy has no date condition either).
  //  - locked: everyone else.
  const fullAccess = access.enrolled && !access.preCohort;
  if (!fullAccess && !accepted) {
    return (
      <LockedFeature
        title="Resources"
        applicationStatus={access.applicationStatus}
      />
    );
  }

  const supabase = createClient();
  let query = supabase
    .from("resources")
    .select("*, cohort:cohorts(name)")
    .order("created_at", { ascending: false });
  // Limited view only ever renders pre-cohort rows — don't fetch the rest.
  if (!fullAccess) query = query.eq("pre_cohort", true);
  const [{ data: resources }, { data: flowRows }, { data: progressRows }] =
    await Promise.all([
      query,
      // RLS scopes flows to the viewer (published + their cohort/global;
      // staff also see drafts — filtered to published below).
      supabase
        .from("flows")
        .select("id, slug, title, tagline, stage, status, est_minutes, sort_order")
        .order("sort_order")
        .order("title"),
      supabase
        .from("flow_progress")
        .select("flow_id, completed_at, current_step")
        .eq("user_id", user.id),
    ]);

  const flows = (flowRows ?? []).filter((f: any) => f.status === "published");
  const progressByFlow = new Map(
    (progressRows ?? []).map((p: any) => [p.flow_id, p]),
  );

  const preCohortRows = (resources ?? []).filter(
    (r: any) => r.pre_cohort === true,
  );
  const regularRows = (resources ?? []).filter(
    (r: any) => r.pre_cohort !== true,
  );

  // Mint short signed URLs for the storage-backed entries we actually
  // render (RLS already filtered reads; this keeps pre-cohort students
  // from getting URLs for anything outside their section).
  const admin = createAdminClient();
  const paths = (fullAccess ? resources ?? [] : preCohortRows)
    .map((r: any) => r.storage_path)
    .filter(Boolean) as string[];
  const signed = new Map<string, string>();
  if (paths.length > 0) {
    const { data } = await admin.storage
      .from("resources")
      .createSignedUrls(paths, 60 * 60); // 1 hour
    for (const item of data ?? []) {
      if (item.path && item.signedUrl) signed.set(item.path, item.signedUrl);
    }
  }

  const byCategory = new Map<string, any[]>();
  for (const r of regularRows) {
    const cat = (r as any).category || "general";
    const arr = byCategory.get(cat) ?? [];
    arr.push(r);
    byCategory.set(cat, arr);
  }
  const categories = Array.from(byCategory.keys()).sort();

  const startDate = fmtDateOnly(access.cohortStartsOn);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-3xl font-bold tracking-tight">Resources</h1>
      <p className="mt-1 text-sm text-ink-soft">
        {fullAccess
          ? "Templates, decks, guides, and tools curated by the batch0 team."
          : access.preCohort
            ? `A head start before ${access.cohortName ?? "your cohort"} kicks off${
                startDate ? ` on ${startDate}` : ""
              }. Everything else unlocks when the cohort begins.`
            : "Materials for accepted students. The full library unlocks when you enroll."}
      </p>

      {/* Before One — the interactive pre-cohort system. Flows are
          admin-curated in /admin/flows; progress is per-student. */}
      {flows.length > 0 && (
        <section className="mt-10">
          <div className="rounded-xl border border-phosphor/25 bg-phosphor/[0.04] p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-phosphor-ink">
              Before One
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              The work you complete before your company becomes real.
              Interactive, personalized, and saved as you go.
            </p>
          </div>

          <div className="mt-6 space-y-8">
            {FLOW_STAGES.map((stage) => {
              const inStage = flows.filter((f: any) => f.stage === stage.value);
              if (inStage.length === 0) return null;
              return (
                <div key={stage.value}>
                  <h2 className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
                    {stage.label}
                  </h2>
                  <p className="mb-3 text-xs text-ink-faint">{stage.blurb}</p>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {inStage.map((f: any) => {
                      const p = progressByFlow.get(f.id);
                      const state = p?.completed_at
                        ? "done"
                        : p?.current_step
                          ? "in-progress"
                          : "new";
                      return (
                        <li key={f.id}>
                          <Link
                            href={`/dashboard/resources/flow/${f.slug}`}
                            className="press group flex h-full flex-col rounded-xl border border-line bg-paper p-4 hover:border-ink/30 hover:bg-wash"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <p className="text-sm font-semibold text-ink">
                                {f.title}
                              </p>
                              {state === "done" ? (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                                  <CheckCircle className="h-3 w-3" /> Done
                                </span>
                              ) : state === "in-progress" ? (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                  <CircleDashed className="h-3 w-3" /> In
                                  progress
                                </span>
                              ) : null}
                            </div>
                            {f.tagline && (
                              <p className="mt-1 flex-1 text-xs text-ink-soft">
                                {f.tagline}
                              </p>
                            )}
                            <p className="mt-3 inline-flex items-center gap-1 text-xs text-ink-faint group-hover:text-ink-soft">
                              {f.est_minutes ? `~${f.est_minutes} min · ` : ""}
                              {state === "in-progress"
                                ? "Resume"
                                : state === "done"
                                  ? "Review"
                                  : "Start"}
                              <ArrowRight className="h-3 w-3" />
                            </p>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}

            {/* Build receipts — the proof-of-work feed across all stages. */}
            <Link
              href="/dashboard/resources/receipts"
              className="press group flex items-center gap-3 rounded-xl border border-line bg-paper px-4 py-3.5 hover:border-ink/30 hover:bg-wash"
            >
              <Receipt className="h-5 w-5 shrink-0 text-phosphor-ink" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-ink">
                  Build receipts
                </span>
                <span className="mt-0.5 block text-xs text-ink-soft">
                  The proof-of-work feed. Post interviews, landing pages,
                  experiments, and killed ideas — earn badges for evidence,
                  not likes.
                </span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-ink-faint group-hover:text-ink-soft" />
            </Link>
          </div>
        </section>
      )}

      <div className="mt-10 space-y-8">
        {/* Pre-cohort section — the only section pre-cohort students see,
            and a labeled subsection for everyone else. */}
        {(preCohortRows.length > 0 || !fullAccess) && (
          <div>
            <h2 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
              <Sparkles className="h-3.5 w-3.5" /> Pre-cohort resources
            </h2>
            {preCohortRows.length === 0 ? (
              <Card>
                <p className="text-sm text-ink-soft">
                  Nothing here yet — the team will add pre-cohort materials
                  before kickoff. Check back soon.
                </p>
              </Card>
            ) : (
              <ResourceList rows={preCohortRows} signed={signed} />
            )}
          </div>
        )}

        {fullAccess &&
          categories.map((cat) => (
            <div key={cat}>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
                {cat}
              </h2>
              <ResourceList rows={byCategory.get(cat) ?? []} signed={signed} />
            </div>
          ))}

        {fullAccess && (resources?.length ?? 0) === 0 && (
          <Card>
            <p className="text-sm text-ink-soft">
              Nothing here yet — staff haven't uploaded any resources.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}

function ResourceList({
  rows,
  signed,
}: {
  rows: any[];
  signed: Map<string, string>;
}) {
  return (
    <ul className="space-y-3">
      {rows.map((r: any) => {
        const cohort = Array.isArray(r.cohort) ? r.cohort[0] : r.cohort;
        const url = r.storage_path
          ? signed.get(r.storage_path) ?? null
          : r.external_url;
        return (
          <li key={r.id}>
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-semibold text-ink">
                    {r.title}
                  </h3>
                  {r.description && (
                    <p className="mt-1 text-sm text-ink-soft">
                      {r.description}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-faint">
                    {cohort?.name && <span>{cohort.name}</span>}
                    {!!r.size_bytes && <span>{fmtBytes(r.size_bytes)}</span>}
                    <span>
                      Added <LocalTime value={r.created_at} mode="date" />
                    </span>
                  </div>
                </div>
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-phosphor px-3 py-2 text-xs font-semibold text-on-phosphor hover:bg-phosphor-200"
                  >
                    {r.storage_path ? (
                      <>
                        <Download className="h-3.5 w-3.5" /> Download
                      </>
                    ) : (
                      <>
                        <ExternalLink className="h-3.5 w-3.5" /> Open
                      </>
                    )}
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs text-ink-faint">
                    <FileText className="h-3.5 w-3.5" /> No file
                  </span>
                )}
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
