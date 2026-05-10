import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { ApplicationForm } from "./application-form";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Apply · SparkLine" };

export default async function ApplyPage() {
  const user = await requireUser();
  const supabase = createClient();

  const [{ data: existing }, { data: settingsRows }, { data: cohort }] =
    await Promise.all([
      supabase
        .from("applications")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("site_settings")
        .select("key, value")
        .in("key", [
          "applications_open",
          "applications_closed_message",
          "active_cohort_id",
          "active_cohort_name",
        ]),
      supabase
        .from("cohorts")
        .select("name, capacity, price_cents, starts_on")
        .in("status", ["upcoming", "active"])
        .order("starts_on", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

  const settings: Record<string, any> = {};
  for (const r of settingsRows ?? []) settings[r.key] = r.value;

  if (existing && existing.status !== "draft") {
    redirect("/dashboard/application");
  }

  const applicationsOpen = settings.applications_open !== false;
  if (!applicationsOpen) {
    return (
      <div className="min-h-screen bg-black">
        <div className="relative mx-auto max-w-2xl px-6 py-24">
          <Link
            href="/dashboard"
            className="text-sm text-white/50 hover:text-white"
          >
            ← Dashboard
          </Link>
          <Card className="mt-8 border-amber-300/30 bg-amber-300/5">
            <h1 className="text-2xl font-bold text-white">
              Applications are closed
            </h1>
            <p className="mt-3 text-sm text-white/70">
              {settings.applications_closed_message ??
                "Applications are currently closed. Check back soon for the next cohort."}
            </p>
          </Card>
        </div>
      </div>
    );
  }

  const cohortName = cohort?.name ?? settings.active_cohort_name ?? "the next cohort";
  const capacity = cohort?.capacity ?? 24;
  const priceDollars = ((cohort?.price_cents ?? 9700) / 100).toFixed(0);

  return (
    <div className="min-h-screen bg-black">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[40rem] bg-spark-radial opacity-50"
      />
      <div className="relative mx-auto max-w-3xl px-6 py-16">
        <div className="mb-8 flex items-center justify-between">
          <Link href="/dashboard" className="text-sm text-white/50 hover:text-white">
            ← Dashboard
          </Link>
          {existing?.status === "draft" && (
            <Link
              href="/dashboard/application"
              className="text-xs text-white/40 hover:text-white"
            >
              View draft summary
            </Link>
          )}
        </div>
        <h1 className="text-4xl font-bold tracking-tight text-white">
          Apply to SparkLine
        </h1>
        <p className="mt-3 max-w-2xl text-white/60">
          {cohortName} is capped at {capacity} students. Applications are
          reviewed on a rolling basis. After your application is accepted,
          you'll pay ${priceDollars} to lock in your seat.
        </p>
        {existing?.status === "draft" && (
          <div className="mt-6 flex items-start gap-3 rounded-xl border border-spark/30 bg-spark/5 p-4 text-sm">
            <div>
              <p className="font-medium text-spark">
                Picking up where you left off
              </p>
              <p className="mt-1 text-white/60">
                We loaded your saved draft. Edits autosave as you type.
              </p>
            </div>
          </div>
        )}
        <div className="mt-10">
          <ApplicationForm
            defaults={existing ?? null}
            email={user.email ?? ""}
          />
        </div>
        <div className="mt-10">
          <Link
            href="/dashboard"
            className="text-sm text-white/50 hover:text-white"
          >
            Save and return later →
          </Link>
        </div>
      </div>
    </div>
  );
}
