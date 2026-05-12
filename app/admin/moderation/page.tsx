import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { ModerationRow } from "./moderation-row";

export const metadata = { title: "Moderation · Admin" };

export default async function ModerationPage() {
  const admin = createAdminClient();
  const { data: pending } = await admin
    .from("teams")
    .select("id, name, slug, logo_url, logo_rejected_reason, updated_at, cohort:cohorts(name)")
    .eq("logo_status", "pending")
    .not("logo_url", "is", null)
    .order("updated_at", { ascending: false });

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-3xl font-bold tracking-tight">Moderation</h1>
      <p className="mt-1 text-sm text-white/55">
        Team logos awaiting review. Reject anything that wouldn't be safe in a
        high-school setting.
      </p>

      {(pending?.length ?? 0) === 0 ? (
        <Card className="mt-8 text-center">
          <p className="text-sm text-white/50">No logos pending review.</p>
        </Card>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {(pending ?? []).map((t: any) => (
            <ModerationRow key={t.id} team={t} />
          ))}
        </div>
      )}
    </div>
  );
}
