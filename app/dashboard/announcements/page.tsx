import { createClient } from "@/lib/supabase/server";
import { requireUser, getProfile } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { LockedFeature } from "@/components/dashboard/locked-feature";
import { Megaphone } from "lucide-react";

export const metadata = { title: "Announcements · batch0" };
export const dynamic = "force-dynamic";

export default async function AnnouncementsPage() {
  await requireUser();
  const profile = await getProfile();
  const access = await getStudentAccess(profile?.role ?? "student");

  // The sidebar hides this from an unenrolled applicant, but hiding a link
  // is not a gate — typing the URL used to land on a page whose RLS could
  // only ever return nothing, which looks identical to "no news yet". Say
  // what's actually true instead. Staff resolve as enrolled (lib/access.ts)
  // so they keep their preview.
  if (!access.enrolled) {
    return (
      <LockedFeature
        title="Announcements"
        applicationStatus={access.applicationStatus}
      />
    );
  }

  const supabase = await createClient();

  // RLS already gates which announcements the user can read; this
  // query intentionally has no .eq("cohort_id", ...) so admin sees all
  // and a student sees their cohort's + global ones.
  const { data: anns } = await supabase
    .from("announcements")
    .select(
      "id, cohort_id, title, body, created_at, cohort:cohorts(name, cohort_number)",
    )
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Announcements</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Updates from the batch0 team.
          </p>
        </div>
        {/* access.staff, not `role === "admin"`: roles are data since
            migration 0048, so a custom admin-area role gets the composer
            link too (lib/access.ts resolves it from the permission). */}
        {access.staff && (
          <a
            href="/admin/announcements"
            className="text-xs text-phosphor-ink hover:underline"
          >
            Send announcement →
          </a>
        )}
      </div>

      {(anns?.length ?? 0) === 0 ? (
        <Card className="mt-6 text-center">
          <Megaphone className="mx-auto h-6 w-6 text-ink-faint" />
          <p className="mt-3 text-sm text-ink-soft">No announcements yet.</p>
        </Card>
      ) : (
        <ul className="mt-6 space-y-4">
          {(anns ?? []).map((a: any) => {
            const cohort = Array.isArray(a.cohort) ? a.cohort[0] : a.cohort;
            return (
              <li
                id={`a-${a.id}`}
                key={a.id}
                className="scroll-mt-24 rounded-xl border border-line bg-wash p-5"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-lg font-semibold text-ink">
                    {a.title}
                  </h2>
                  <span className="shrink-0 text-xs text-ink-faint">
                    <LocalTime value={a.created_at} mode="datetime-short" />
                  </span>
                </div>
                {cohort && (
                  <p className="mt-1 text-[11px] uppercase tracking-wider text-ink-faint">
                    {cohort.cohort_number != null
                      ? `Cohort ${cohort.cohort_number} · ${cohort.name}`
                      : cohort.name}
                  </p>
                )}
                <p className="mt-3 whitespace-pre-wrap break-words text-sm text-ink-soft">
                  {a.body}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
