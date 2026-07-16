import { requireMentor } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { FileText, ExternalLink, Download } from "lucide-react";

export const metadata = { title: "Resources · Mentor" };

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

export default async function MentorResourcesPage() {
  // RLS on `resources` already grants read to staff (mentor + admin), so
  // the user-scoped supabase client is fine.
  await requireMentor();
  const supabase = createClient();
  const { data: resources } = await supabase
    .from("resources")
    .select("*, cohort:cohorts(name)")
    .order("created_at", { ascending: false });

  const admin = createAdminClient();
  const paths = (resources ?? [])
    .map((r: any) => r.storage_path)
    .filter(Boolean) as string[];
  const signed = new Map<string, string>();
  if (paths.length > 0) {
    const { data } = await admin.storage
      .from("resources")
      .createSignedUrls(paths, 60 * 60);
    for (const item of data ?? []) {
      if (item.path && item.signedUrl) signed.set(item.path, item.signedUrl);
    }
  }

  const byCategory = new Map<string, any[]>();
  for (const r of resources ?? []) {
    const cat = (r as any).category || "general";
    const arr = byCategory.get(cat) ?? [];
    arr.push(r);
    byCategory.set(cat, arr);
  }
  const categories = Array.from(byCategory.keys()).sort();

  return (
    <div className="mx-auto max-w-4xl">
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-phosphor-ink">
        Resources
      </p>
      <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        Materials curated for the cohort
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        Same library students see — useful when prepping a check-in reply
        or pointing a team at a template.
      </p>

      {(resources?.length ?? 0) === 0 ? (
        <Card className="mt-8">
          <p className="text-sm text-ink-soft">
            Nothing here yet — staff haven't uploaded any resources.
          </p>
        </Card>
      ) : (
        <div className="mt-8 space-y-8">
          {categories.map((cat) => (
            <div key={cat}>
              <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
                {cat}
              </h2>
              <ul className="space-y-3">
                {(byCategory.get(cat) ?? []).map((r: any) => {
                  const cohort = Array.isArray(r.cohort)
                    ? r.cohort[0]
                    : r.cohort;
                  const url = r.storage_path
                    ? signed.get(r.storage_path) ?? null
                    : r.external_url;
                  return (
                    <li key={r.id}>
                      <Card>
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div className="min-w-0 flex-1">
                            <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-ink">
                              {r.title}
                            </h3>
                            {r.description && (
                              <p className="mt-1 text-sm text-ink-soft">
                                {r.description}
                              </p>
                            )}
                            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-faint">
                              {cohort?.name && <span>{cohort.name}</span>}
                              {r.size_bytes && (
                                <span>{fmtBytes(r.size_bytes)}</span>
                              )}
                              <span>
                                Added{" "}
                                <LocalTime value={r.created_at} mode="date" />
                              </span>
                            </div>
                          </div>
                          {url ? (
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="press inline-flex shrink-0 items-center gap-1.5 rounded-md bg-phosphor-fill px-3 py-2 text-xs font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-fill-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
