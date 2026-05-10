import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { AnnouncementForm } from "./announcement-form";

export const metadata = { title: "Announcements · Admin" };

export default async function AdminAnnouncementsPage() {
  const admin = createAdminClient();
  const { data: cohorts } = await admin
    .from("cohorts")
    .select("id, name")
    .order("starts_on");

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">Announcements</h1>
      <p className="mt-1 text-sm text-white/55">
        Broadcast to enrolled students. Optionally cross-post to your
        Discord announcements channel.
      </p>
      <Card className="mt-6">
        <AnnouncementForm cohorts={(cohorts ?? []) as any} />
      </Card>
    </div>
  );
}
