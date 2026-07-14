import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { AnnouncementForm } from "./announcement-form";
import { DeleteAnnouncementButton } from "./delete-button";
import { getDiscordSettings } from "@/lib/discord";
import type { Role } from "@/lib/types";

export const metadata = { title: "Announcements · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminAnnouncementsPage() {
  const admin = createAdminClient();
  const [{ data: cohorts }, { data: anns, error: annErr }, discord] =
    await Promise.all([
      admin.from("cohorts").select("id, name").order("starts_on"),
      admin
        .from("announcements")
        .select(
          "id, cohort_id, title, body, created_at, cohort:cohorts(name, cohort_number)",
        )
        .order("created_at", { ascending: false })
        .limit(100),
      getDiscordSettings(),
    ]);

  // Roles the admin can ping — only show options where the role ID is
  // actually configured, otherwise the ping silently no-ops.
  const ROLE_LABELS: { role: Role; label: string }[] = [
    { role: "student", label: "Students" },
    { role: "mentor", label: "Mentors" },
    { role: "investor", label: "Investors" },
    { role: "admin", label: "Admins" },
  ];
  const pingableRoles = ROLE_LABELS.filter(
    (r) => !!discord.roleIdByRole[r.role],
  );

  // Pre-0027 deployments will see an error referencing the missing
  // table. We still render the broadcast form (the broadcast action
  // degrades gracefully) but suppress the list to avoid noise.
  const announcementsTableMissing =
    !!annErr &&
    /relation .*announcements.* does not exist/i.test(annErr.message);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Announcements</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Broadcast to enrolled students. Optionally cross-post to your
        Discord announcements channel.
      </p>
      <Card className="mt-6">
        <AnnouncementForm
          cohorts={(cohorts ?? []) as any}
          pingableRoles={pingableRoles}
        />
      </Card>

      <h2 className="mt-10 text-sm font-semibold uppercase tracking-wider text-ink-soft">
        Past announcements
      </h2>
      {announcementsTableMissing ? (
        <Card className="mt-3">
          <p className="text-sm text-ink-soft">
            Announcements aren't enabled yet — apply migration{" "}
            <code className="font-mono text-phosphor-ink">
              0027_announcements_and_reactions.sql
            </code>
            .
          </p>
        </Card>
      ) : (anns?.length ?? 0) === 0 ? (
        <Card className="mt-3">
          <p className="text-sm text-ink-soft">No announcements sent yet.</p>
        </Card>
      ) : (
        <ul className="mt-3 space-y-3">
          {(anns ?? []).map((a: any) => {
            const cohort = Array.isArray(a.cohort) ? a.cohort[0] : a.cohort;
            return (
              <li
                key={a.id}
                className="rounded-xl border border-line bg-wash p-5"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-base font-semibold text-ink">
                    {a.title}
                  </h3>
                  <span className="shrink-0 text-xs text-ink-faint">
                    <LocalTime value={a.created_at} mode="datetime-short" />
                  </span>
                </div>
                <p className="mt-1 text-[11px] uppercase tracking-wider text-ink-faint">
                  {cohort
                    ? cohort.cohort_number != null
                      ? `Cohort ${cohort.cohort_number} · ${cohort.name}`
                      : cohort.name
                    : "All enrolled cohorts"}
                </p>
                <p className="mt-3 whitespace-pre-wrap break-words text-sm text-ink-soft">
                  {a.body}
                </p>
                <div className="mt-3 flex justify-end">
                  <DeleteAnnouncementButton id={a.id} title={a.title} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
