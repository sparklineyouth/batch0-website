import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { ApplicationForm } from "./application-form";
import { getCountryFromHeaders, getRegionalPrice, DEFAULT_PRICE_CENTS } from "@/lib/pricing";
import { getApplicationQuestions } from "@/lib/application-questions";
import { getSiteConfig } from "@/lib/site-config";
import { StatusBar } from "@/components/status-bar";
import { ZeroThread } from "@/components/zero-thread";
import { FlagIcon } from "@/components/icons/pixel-icon";

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

/**
 * The apply surface in the broadsheet system, tuned TRANSACTIONAL: plain,
 * calm, zero motion, parent-legible. No PixelField, no cursor block, no
 * glitch targets — the only icon on the page is the flag beside the title
 * (the apply gate). Same anatomy as the marketing pages (status bar,
 * command head, shared container + 12-column grid), quieter volume.
 */
export default async function ApplyPage({
  searchParams,
}: {
  searchParams: { cohort?: string };
}) {
  const user = await requireUser();
  const supabase = createClient();
  const country = getCountryFromHeaders(headers());

  const [
    { data: existing },
    { data: settingsRows },
    { data: openCohorts },
    questions,
    siteConfig,
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
    getSiteConfig({ countryCode: country }),
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
      <div className="min-h-screen bg-paper">
        <StatusBar config={siteConfig} />
        <div className="mx-auto max-w-[1100px] px-5 py-14 sm:px-6 md:py-20">
          <Link
            href="/dashboard"
            className="t-small lowercase text-ink-soft hover:text-ink"
          >
            ← Dashboard
          </Link>
          <div className="mt-8 grid grid-cols-12 gap-x-6">
            <div className="col-span-12 md:col-span-8">
              <p className="cmdline font-mono">
                <b>cat apply.txt</b>{" "}
                <span className="mtime">· modified 2026-07-14</span>
              </p>
              <h1 className="t-head mt-4 text-ink">
                applications are closed
              </h1>
              <p className="t-body mt-3 max-w-[58ch] text-ink-soft">
                {settings.applications_closed_message ??
                  "Applications are currently closed. Check back soon for the next cohort."}
              </p>
            </div>
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
  const regional = getRegionalPrice(selected?.price_cents ?? DEFAULT_PRICE_CENTS, country);
  const priceDollars = (regional.amountCents / 100).toFixed(0);
  const hasMultiple = cohorts.length > 1;

  return (
    <div className="min-h-screen bg-paper">
      <StatusBar config={siteConfig} />
      <div className="mx-auto max-w-[1100px] px-5 py-10 sm:px-6 sm:py-14 md:py-20">
        <div className="grid grid-cols-12 gap-x-6">
          <div className="col-span-12 md:col-span-8">
            <div className="mb-6 flex items-center justify-between sm:mb-8">
              <Link
                href="/dashboard"
                className="t-small lowercase text-ink-soft hover:text-ink"
              >
                ← Dashboard
              </Link>
              {existing?.status === "draft" && (
                <Link
                  href="/dashboard/application"
                  className="t-small lowercase text-ink-faint hover:text-ink"
                >
                  View draft summary
                </Link>
              )}
            </div>

            <p className="cmdline font-mono">
              <b>cat {reapplying ? "reapply" : "apply"}.txt</b>{" "}
              <span className="mtime">· modified 2026-07-14</span>
            </p>
            {/* the page's ONE icon: the flag, the apply gate */}
            <div className="mt-4 flex items-center gap-3.5">
              <FlagIcon size={5} />
              <h1 className="t-head text-ink">
                apply to <ZeroThread>batch0</ZeroThread>
              </h1>
            </div>
            <p className="t-body mt-3 max-w-[58ch] text-ink-soft">
              {cohortName} is capped at {capacity} students. Applications are
              reviewed on a rolling basis. After your application is accepted,
              you&apos;ll pay ${priceDollars} to lock in your seat.
            </p>
            <p className="aside-note mt-3">
              <ZeroThread>$0 to apply</ZeroThread>
            </p>

            {hasMultiple && (
              <div className="mt-6 border border-line px-4 py-3">
                <p className="t-small font-mono lowercase tracking-[0.06em] text-phosphor/60">
                  Choose a cohort
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {cohorts.map((c) => {
                    const active = c.id === selectedId;
                    return (
                      <Link
                        key={c.id}
                        href={`/apply?cohort=${c.id}`}
                        className={`press inline-flex items-center gap-2 border px-3 py-1.5 text-xs lowercase ${
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
                <p className="t-small mt-2 text-ink-soft">
                  Your application is tied to the cohort you pick. You can
                  switch at any time before submitting.
                </p>
              </div>
            )}

            {reapplying && (
              <div className="t-small mt-6 flex items-start gap-3 border border-phosphor/25 p-4">
                <div>
                  <p className="font-medium lowercase text-ink">
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
              <div className="t-small mt-6 flex items-start gap-3 border border-phosphor/25 p-4">
                <div>
                  <p className="font-medium lowercase text-phosphor-ink">
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
                className="t-small lowercase text-ink-soft hover:text-ink"
              >
                Save and return later →
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
