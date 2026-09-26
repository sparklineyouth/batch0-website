import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { EventsManager } from "./events-manager";

export const metadata = { title: "Events · Admin" };

export default async function AdminEventsPage(props: {
  searchParams: Promise<{ edit?: string }>;
}) {
  // `?edit=<id>` opens that event's form directly. /admin/webinars links here
  // with it (its pencil used to drop an admin on the bare list and leave them
  // to find the row). An id that matches nothing just shows the list.
  const { edit } = await props.searchParams;
  const admin = createAdminClient();
  const [{ data: events }, { data: cohorts }] = await Promise.all([
    admin.from("events").select("*").order("starts_at", { ascending: false }),
    admin.from("cohorts").select("id, name").order("starts_on"),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">Events</h1>
      <p className="mt-1 text-sm text-ink-faint">
        Demo Day, office hours, workshops. Enrolled students see them in
        their dashboard.
      </p>

      <Card className="mt-6">
        <EventsManager
          events={(events ?? []) as any}
          cohorts={(cohorts ?? []) as any}
          initialEditId={typeof edit === "string" ? edit : null}
        />
      </Card>
    </div>
  );
}
