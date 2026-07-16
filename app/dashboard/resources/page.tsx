import { requireUser, getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { FileText, ExternalLink, Download, Sparkles } from "lucide-react";
import { getStudentAccess } from "@/lib/access";
import { fmtDateOnly, isAcceptedStatus } from "@/lib/pre-cohort";
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
  await requireUser();
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
  const { data: resources } = await query;

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

      <div className="mt-8 space-y-8">
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
