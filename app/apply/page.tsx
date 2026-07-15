import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import { canBypassClosedApplications } from "@/lib/founder-pass";
import { ApplicationForm } from "./application-form";
import { getCountryFromHeaders, getRegionalPrice } from "@/lib/pricing";
import { getApplicationQuestions } from "@/lib/application-questions";

export const metadata = {
  title: "Apply · batch0",
  description:
    "Apply to batch0 — the live, online startup accelerator for U.S. high schoolers. Free to apply; tuition charged only if accepted. Rolling review.",
  openGraph: {
    title: "Apply to batch0",
    description:
      "Four build sprints, a company of your own, and a live demo day. Free to apply; tuition charged only if accepted. Rolling review.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Apply to batch0",
    description:
      "Four build sprints, a company of your own, and a live demo day. Free to apply; tuition charged only if accepted.",
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

  const [
    { data: existing },
    { data: settingsRows },
    { data: openCohorts },
    questions,
  ] = await Promise.all([
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
    getApplicationQuestions(),
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

  // A founder pass can carry its holder past a closed gate, but only while the
  // admin has the early-access window open — see canBypassClosedApplications().
  // Checked only when the gate is actually shut, so the common path costs no
  // extra queries.
  const applicationsOpen =
    settings.applications_open !== false ||
    (await canBypassClosedApplications(createAdminClient(), user.id));
  if (!applicationsOpen) {
    return (
      <div className="min-h-screen bg-paper">
        <div className="relative mx-auto max-w-2xl px-5 sm:px-6 py-24">
          <Link
            href="/dashboard"
            className="text-sm text-ink-soft hover:text-ink"
          >
            ← Dashboard
          </Link>
          <div className="mt-8 rounded-2xl border border-amber-400/40 bg-wash p-6">
            <h1 className="font-display text-2xl font-bold tracking-[-0.02em] text-ink">
              Applications are closed
            </h1>
            <p className="mt-3 text-sm text-ink-soft">
              {settings.applications_closed_message ??
                "Applications are currently closed. Check back soon for the next cohort."}
            </p>
          </div>
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
  const country = getCountryFromHeaders(headers());
  const regional = getRegionalPrice(selected?.price_cents ?? 13000, country);
  const priceDollars = (regional.amountCents / 100).toFixed(0);
  const hasMultiple = cohorts.length > 1;

  return (
    <div className="min-h-screen bg-paper">
      <div className="relative mx-auto max-w-3xl px-5 sm:px-6 py-10 sm:py-16">
        <div className="mb-6 sm:mb-8 flex items-center justify-between">
          <Link href="/dashboard" className="text-sm text-ink-soft hover:text-ink">
            ← Dashboard
          </Link>
          {existing?.status === "draft" && (
            <Link
              href="/dashboard/application"
              className="text-xs text-ink-faint hover:text-ink"
            >
              View draft summary
            </Link>
          )}
        </div>
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-phosphor-ink">
          {reapplying ? "Reapply" : "Apply"}
        </p>
        <h1 className="mt-3 font-display text-[30px] sm:text-4xl font-bold tracking-[-0.02em] text-ink leading-[1.1]">
          Apply to batch0
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] sm:text-base text-ink-soft leading-[1.55]">
          {cohortName} is capped at {capacity} students. Applications are
          reviewed on a rolling basis. After your application is accepted,
          you'll pay ${priceDollars} to lock in your seat.
        </p>

        {hasMultiple && (
          <div className="mt-6 rounded-xl border border-line bg-wash px-4 py-3">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-ink-faint">
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
                        ? "border-phosphor bg-phosphor/10 text-phosphor-ink"
                        : "border-line text-ink-soft hover:border-ink/30"
                    }`}
                  >
                    {c.name}
                    {c.starts_on && (
                      <span
                        className={active ? "text-phosphor-ink" : "text-ink-faint"}
                      >
                        · {c.starts_on}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-ink-soft">
              Your application is tied to the cohort you pick. You can
              switch at any time before submitting.
            </p>
          </div>
        )}

        {reapplying && (
          <div className="mt-6 flex items-start gap-3 rounded-xl border border-amber-400/40 bg-wash p-4 text-sm">
            <div>
              <p className="font-medium text-ink">
                Starting a fresh application
              </p>
              <p className="mt-1 text-ink-soft">
                {existing!.status === "rejected"
                  ? "Your last application wasn't accepted. You can apply again to a different cohort below."
                  : "You withdrew from a previous application. You can reapply to the cohort below."}
              </p>
            </div>
          </div>
        )}

        {existing?.status === "draft" && (
          <div className="mt-6 flex items-start gap-3 rounded-xl border border-phosphor/40 bg-phosphor/5 p-4 text-sm">
            <div>
              <p className="font-medium text-phosphor-ink">
                Picking up where you left off
              </p>
              <p className="mt-1 text-ink-soft">
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
            questions={questions}
          />
        </div>
        <div className="mt-10">
          <Link
            href="/dashboard"
            className="text-sm text-ink-soft hover:text-ink"
          >
            Save and return later →
          </Link>
        </div>
      </div>
    </div>
  );
}
