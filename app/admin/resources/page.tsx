import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { Plus, FileText, ExternalLink } from "lucide-react";

export const metadata = { title: "Resources · Admin" };

function fmtBytes(n: number | null) {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export default async function AdminResourcesPage() {
  const admin = createAdminClient();
  const [{ data: resources }, { data: cohorts }] = await Promise.all([
    admin
      .from("resources")
      .select("*, cohort:cohorts(name)")
      .order("created_at", { ascending: false }),
    admin.from("cohorts").select("id, name").order("starts_on"),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Resources</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Shared decks, templates, guides — visible to enrolled students in
            the chosen cohort (or everyone, if left global).
          </p>
        </div>
        <Link
          href="/admin/resources/new"
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-phosphor px-4 text-sm font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        >
          <Plus className="h-4 w-4" /> New resource
        </Link>
      </div>

      <Card className="mt-6 !p-0 overflow-hidden">
        {(resources?.length ?? 0) === 0 ? (
          <p className="p-6 text-sm text-ink-soft">
            Nothing here yet. Upload your first resource — try cohort
            templates, kickoff decks, or recommended reading.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-faint">
                <th className="px-5 py-3">Title</th>
                <th className="px-5 py-3">Category</th>
                <th className="px-5 py-3">Cohort</th>
                <th className="px-5 py-3">Source</th>
                <th className="px-5 py-3">Size</th>
                <th className="px-5 py-3">Added</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {(resources ?? []).map((r: any) => {
                const cohort = Array.isArray(r.cohort)
                  ? r.cohort[0]
                  : r.cohort;
                return (
                  <tr
                    key={r.id}
                    className="border-b border-line last:border-0 hover:bg-wash"
                  >
                    <td className="px-5 py-3 text-ink">{r.title}</td>
                    <td className="px-5 py-3 text-ink-soft capitalize">
                      {r.category}
                    </td>
                    <td className="px-5 py-3 text-ink-soft">
                      {cohort?.name ?? <span className="text-ink-faint">All</span>}
                    </td>
                    <td className="px-5 py-3 text-ink-soft">
                      {r.storage_path ? (
                        <span className="inline-flex items-center gap-1">
                          <FileText className="h-3.5 w-3.5" /> File
                        </span>
                      ) : r.external_url ? (
                        <span className="inline-flex items-center gap-1">
                          <ExternalLink className="h-3.5 w-3.5" /> Link
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-5 py-3 text-ink-soft">
                      {fmtBytes(r.size_bytes)}
                    </td>
                    <td className="px-5 py-3 text-ink-faint">
                      <LocalTime value={r.created_at} mode="date" />
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Link
                        href={`/admin/resources/${r.id}`}
                        className="text-xs text-phosphor-ink hover:underline"
                      >
                        Edit →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <p className="mt-6 text-xs text-ink-faint">
        Tip: leave Cohort empty to make a resource visible to every enrolled
        student, regardless of cohort.
      </p>
      <div className="hidden">{cohorts?.length}</div>
    </div>
  );
}
