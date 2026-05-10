import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { Card, StatusBadge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default async function DashboardHome() {
  const user = await requireUser();
  const supabase = createClient();

  const [{ data: profile }, { data: app }, { data: enrollment }] =
    await Promise.all([
      supabase.from("profiles").select("*").eq("id", user.id).single(),
      supabase
        .from("applications")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("enrollments")
        .select("*, cohort:cohorts(*)")
        .eq("user_id", user.id)
        .maybeSingle(),
    ]);

  const greeting = profile?.full_name?.split(" ")[0] || "there";

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-3xl font-bold tracking-tight">
        Welcome, {greeting}.
      </h1>
      <p className="mt-1 text-sm text-white/50">
        Here's where your SparkLine journey lives.
      </p>

      <div className="mt-10 grid gap-5 md:grid-cols-2">
        {/* Application card */}
        <Card>
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-sm font-medium uppercase tracking-wider text-white/50">
                Application
              </h3>
              <p className="mt-2 text-2xl font-semibold">
                {app ? app.status[0].toUpperCase() + app.status.slice(1) : "Not started"}
              </p>
            </div>
            {app && <StatusBadge status={app.status} />}
          </div>
          <div className="mt-5">
            {!app && (
              <Link href="/apply">
                <Button>Start application</Button>
              </Link>
            )}
            {app?.status === "draft" && (
              <Link href="/apply">
                <Button>Continue application</Button>
              </Link>
            )}
            {app?.status === "submitted" && (
              <p className="text-sm text-white/60">
                We're reviewing your application. We'll email you when there's a
                decision.
              </p>
            )}
            {app?.status === "accepted" && (
              <Link href="/dashboard/application">
                <Button>Pay $97 to enroll</Button>
              </Link>
            )}
            {app?.status === "rejected" && (
              <p className="text-sm text-white/60">
                Thanks for applying. Unfortunately you weren't selected for this cohort. You're welcome to apply for the next one.
              </p>
            )}
            {(app?.status === "paid" || app?.status === "enrolled") && (
              <p className="text-sm text-emerald-300">
                You're enrolled. See you in the cohort!
              </p>
            )}
          </div>
        </Card>

        {/* Enrollment / Course card */}
        <Card>
          <h3 className="text-sm font-medium uppercase tracking-wider text-white/50">
            Course access
          </h3>
          {enrollment ? (
            <>
              <p className="mt-2 text-2xl font-semibold">
                {enrollment.cohort?.name ?? "Cohort"}
              </p>
              <p className="mt-1 text-sm text-white/50">
                {enrollment.cohort?.starts_on} → {enrollment.cohort?.ends_on}
              </p>
              <Link href="/dashboard/course" className="mt-5 inline-block">
                <Button>Open course</Button>
              </Link>
            </>
          ) : (
            <>
              <p className="mt-2 text-2xl font-semibold text-white/40">
                Locked
              </p>
              <p className="mt-1 text-sm text-white/50">
                Course content unlocks once you're enrolled.
              </p>
            </>
          )}
        </Card>
      </div>

      <div className="mt-10">
        <h2 className="text-lg font-semibold">Quick links</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href="/dashboard/application">
            <Button variant="secondary" size="sm">View application</Button>
          </Link>
          <Link href="/dashboard/billing">
            <Button variant="secondary" size="sm">Billing</Button>
          </Link>
          <Link href="/dashboard/settings">
            <Button variant="secondary" size="sm">Settings</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
