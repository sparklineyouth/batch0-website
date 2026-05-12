import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { IntroRow } from "./intro-row";

export const metadata = { title: "Intros · Admin" };

export default async function AdminIntrosPage() {
  await requireAdmin();
  const admin = createAdminClient();

  const { data: rows } = await admin
    .from("intro_requests")
    .select(
      "id, status, message, admin_notes, created_at, updated_at, investor:profiles!intro_requests_investor_id_fkey(full_name, email), team:teams(id, name)",
    )
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-3xl font-bold tracking-tight">Investor intros</h1>
      <p className="mt-1 text-sm text-white/55">
        Funnel from intro request → meeting → committed → wired.
      </p>

      <div className="mt-6 space-y-3">
        {(rows ?? []).length === 0 && (
          <Card>
            <p className="text-sm text-white/50">
              No intro requests yet.
            </p>
          </Card>
        )}
        {(rows ?? []).map((r: any) => (
          <IntroRow key={r.id} row={r} />
        ))}
      </div>
    </div>
  );
}
