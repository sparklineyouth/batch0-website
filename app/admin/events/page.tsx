import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { EventsManager } from "./events-manager";

export const metadata = { title: "Events · Admin" };

export default async function AdminEventsPage() {
  const admin = createAdminClient();
  const [{ data: events }, { data: cohorts }] = await Promise.all([
    admin.from("events").select("*").order("starts_at", { ascending: false }),
    admin.from("cohorts").select("id, name").order("starts_on"),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-3xl font-bold tracking-tight">Events</h1>
      <p className="mt-1 text-sm text-white/50">
        Demo Day, office hours, workshops. Enrolled students see them in
        their dashboard.
      </p>

      <Card className="mt-6">
        <EventsManager
          events={(events ?? []) as any}
          cohorts={(cohorts ?? []) as any}
        />
      </Card>
    </div>
  );
}
