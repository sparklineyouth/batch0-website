import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";

export const metadata = { title: "Students · Admin" };

export default async function AdminStudentsPage() {
  const admin = createAdminClient();

  // Pull every profile + their enrollments
  const { data: profiles } = await admin
    .from("profiles")
    .select(
      "id, email, full_name, role, created_at, applications(status), enrollments(cohort_id, cohort:cohorts(name))",
    )
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-3xl font-bold tracking-tight">Students</h1>
      <p className="mt-1 text-sm text-white/50">
        Everyone with an account.
      </p>

      <Card className="mt-6 !p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-white/40">
              <th className="px-5 py-3">Name</th>
              <th className="px-5 py-3">Email</th>
              <th className="px-5 py-3">Role</th>
              <th className="px-5 py-3">Application</th>
              <th className="px-5 py-3">Enrolled</th>
              <th className="px-5 py-3">Joined</th>
            </tr>
          </thead>
          <tbody>
            {(profiles ?? []).map((p: any) => {
              const latestApp = (p.applications ?? [])[0];
              const enrollment = (p.enrollments ?? [])[0];
              return (
                <tr
                  key={p.id}
                  className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]"
                >
                  <td className="px-5 py-3 text-white">{p.full_name || "—"}</td>
                  <td className="px-5 py-3 text-white/70">{p.email}</td>
                  <td className="px-5 py-3">
                    <span className="text-xs uppercase tracking-wider text-white/60">
                      {p.role}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    {latestApp ? <StatusBadge status={latestApp.status} /> : <span className="text-white/30">—</span>}
                  </td>
                  <td className="px-5 py-3 text-white/70">
                    {enrollment?.cohort?.name ?? <span className="text-white/30">—</span>}
                  </td>
                  <td className="px-5 py-3 text-white/50">
                    {new Date(p.created_at).toLocaleDateString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {(profiles?.length ?? 0) === 0 && (
          <p className="p-6 text-sm text-white/50">No students yet.</p>
        )}
      </Card>
    </div>
  );
}
