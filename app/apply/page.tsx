import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { ApplicationForm } from "./application-form";
import { Card } from "@/components/ui/card";

export const metadata = {
  title: "Apply · SparkLine Youth",
  description:
    "Apply to SparkLine Youth — the 4-week, fully virtual startup accelerator for U.S. high schoolers. Rolling admissions; $97 once accepted.",
  openGraph: {
    title: "Apply to SparkLine Youth",
    description:
      "Take your idea from raw concept to investor-ready pitch in 4 weeks. Rolling admissions. $97 once accepted.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Apply to SparkLine Youth",
    description:
      "The 4-week, fully virtual startup accelerator for U.S. high schoolers. Rolling admissions. $97.",
  },
  // Application is gated and the form mutates server state — keep search
  // engines out even though middleware also redirects unauthed crawlers.
  robots: { index: false, follow: false },
};

export default async function ApplyPage({
  searchParams,
}: {
  searchParams: { cohort?: string };
}) {
  const user = await requireUser();
  const supabase = createClient();

  const [{ data: existing }, { data: settingsRows }, { data: openCohorts }] =
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
        .select("id, name, capacity, price_cents, starts_on")
        .in("status", ["upcoming", "active"])
        .order("starts_on", { ascending: true }),
    ]);

  const settings: Record<string, any> = {};
  for (const r of settingsRows ?? []) settings[r.key] = r.value;

  // Determine whether we're starting a NEW application (after a rejection
  // or withdrawal, applying to a different cohort) or continuing the
  // existing one.
  const reapplying =
    !!existing &&
    (existing.status === "rejected" || existing.status === "withdrawn");
  if (existing && !reapplying && existing.status !== "draft") {
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

  const cohorts = openCohorts ?? [];
  const pinnedId =
    typeof settings.active_cohort_id === "string"
      ? settings.active_cohort_id
      : null;
  // Cohort selection order: explicit ?cohort= → user's existing draft
  // → admin-pinned active → first available.
  const queryCohort =
    typeof searchParams.cohort === "string" ? searchParams.cohort : null;
  const draftCohortId =
    existing && !reapplying ? (existing as any).cohort_id ?? null : null;
  const selectedId =
    cohorts.find((c) => c.id === queryCohort)?.id ??
    cohorts.find((c) => c.id === draftCohortId)?.id ??
    cohorts.find((c) => c.id === pinnedId)?.id ??
    cohorts[0]?.id ??
    null;
  const selected = cohorts.find((c) => c.id === selectedId) ?? null;

  const cohortName =
    selected?.name ?? settings.active_cohort_name ?? "the next cohort";
  const capacity = selected?.capacity ?? 24;
  const priceDollars = ((selected?.price_cents ?? 9700) / 100).toFixed(0);
  const hasMultiple = cohorts.length > 1;

  return (
    <div className="min-h-screen bg-black">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[40rem] bg-spark-radial opacity-50"
      />
      <div className="relative mx-auto max-w-3xl px-5 sm:px-6 py-10 sm:py-16">
        <div className="mb-6 sm:mb-8 flex items-center justify-between">
          <Link href="/dashboard" className="text-sm text-white/55 hover:text-white">
            ← Dashboard
          </Link>
          {existing?.status === "draft" && (
            <Link
              href="/dashboard/application"
              className="text-xs text-white/45 hover:text-white"
            >
              View draft summary
            </Link>
          )}
        </div>
        <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-spark">
          {reapplying ? "Reapply" : "Apply"}
        </p>
        <h1 className="mt-3 text-[30px] sm:text-4xl font-bold tracking-tight text-white leading-[1.1]">
          Apply to SparkLine Youth
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] sm:text-base text-white/75 leading-[1.55]">
          {cohortName} is capped at {capacity} students. Applications are
          reviewed on a rolling basis. After your application is accepted,
          you'll pay ${priceDollars} to lock in your seat.
        </p>

        {hasMultiple && (
          <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/55">
              Choose a cohort
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {cohorts.map((c) => {
                const active = c.id === selectedId;
                return (
                  <Link
                    key={c.id}
                    href={`/apply?cohort=${c.id}`}
                    className={`press inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs ${
                      active
                        ? "border-spark/50 bg-spark/10 text-spark"
                        : "border-white/10 bg-white/[0.02] text-white/75 hover:border-white/25"
                    }`}
                  >
                    {c.name}
                    {c.starts_on && (
                      <span
                        className={
                          active ? "text-spark/80" : "text-white/45"
                        }
                      >
                        · {c.starts_on}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-white/55">
              Your application is tied to the cohort you pick. You can
              switch at any time before submitting.
            </p>
          </div>
        )}

        {reapplying && (
          <div className="mt-6 flex items-start gap-3 rounded-xl border border-amber-300/30 bg-amber-300/5 p-4 text-sm">
            <div>
              <p className="font-medium text-amber-200">
                Starting a fresh application
              </p>
              <p className="mt-1 text-white/75">
                {existing!.status === "rejected"
                  ? "Your last application wasn't accepted. You can apply again to a different cohort below."
                  : "You withdrew from a previous application. You can reapply to the cohort below."}
              </p>
            </div>
          </div>
        )}

        {existing?.status === "draft" && (
          <div className="mt-6 flex items-start gap-3 rounded-xl border border-spark/30 bg-spark/5 p-4 text-sm">
            <div>
              <p className="font-medium text-spark">
                Picking up where you left off
              </p>
              <p className="mt-1 text-white/70">
                We loaded your saved draft. Edits autosave as you type.
              </p>
            </div>
          </div>
        )}

        <div className="mt-10">
          <ApplicationForm
            defaults={reapplying ? null : existing ?? null}
            email={user.email ?? ""}
            priceLabel={`$${priceDollars}`}
            cohortId={selectedId}
          />
        </div>
        <div className="mt-10">
          <Link
            href="/dashboard"
            className="text-sm text-white/55 hover:text-white"
          >
            Save and return later →
          </Link>
        </div>
      </div>
    </div>
  );
}
