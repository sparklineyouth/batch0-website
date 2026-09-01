import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import { canBypassClosedApplications, getPassForUser } from "@/lib/founder-pass";
import { grantAutoAdmits } from "@/lib/founder-pass-tiers";
import {
  planReapply,
  reviewerOverrodePass,
  selectCohortId,
} from "@/lib/reapply";
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

  const admin = createAdminClient();

  const [
    { data: history },
    pass,
    { data: settingsRows },
    { data: openCohorts },
    questions,
  ] = await Promise.all([
    // EVERY application, newest first — not just the latest. The newest row is
    // what decides which form to show, but the whole history is what decides
    // which cohorts are still open to this user: someone declined from spring
    // and then from summer has to stay blocked from both. See lib/reapply.ts.
    supabase
      .from("applications")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    // Read once, used three times below — the closed-gate bypass, the
    // reapply rules, and the auto-admit banner. Through the service-role
    // client for the reason app/pass/page.tsx documents: the anon client
    // returns null indistinguishably for "no pass" and "RLS said no".
    getPassForUser(admin, user.id),
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

  const applications = history ?? [];
  const existing = applications[0] ?? null;

  // Which form we're rendering: a fresh one, a draft to continue, a reapply
  // after a decline/withdrawal, or none at all because the application is in
  // review or already decided. lib/reapply.ts owns the classification so the
  // submit action can reach the same verdict from the same inputs.
  const plan = planReapply({
    cohorts: openCohorts ?? [],
    history: applications,
    latestStatus: existing?.status ?? null,
    holdsPass: pass !== null,
  });
  const reapplying = plan.stage === "reapply";
  // Decided by the SAME predicate the submit action applies, so the banner
  // below can't promise a seat the action then withholds. A reviewer who
  // declined this holder after they redeemed the pass has overridden the
  // automatic admission — see reviewerOverrodePass() in lib/reapply.ts.
  const willAutoAdmit =
    pass !== null &&
    grantAutoAdmits(pass.grant) &&
    !reviewerOverrodePass(applications as any[], pass.redeemedAt);
  if (plan.stage === "locked") {
    redirect("/dashboard/application");
  }

  // A founder pass can carry its holder past a closed gate, but only while the
  // admin has the early-access window open — see canBypassClosedApplications().
  // Checked only when the gate is actually shut, so the common path costs no
  // extra queries.
  const applicationsOpen =
    settings.applications_open !== false ||
    (await canBypassClosedApplications(admin, user.id));
  if (!applicationsOpen) {
    return (
      // The page's own root doubles as the skip-link target — same element,
      // same classes, just promoted from <div> to <main> so "Skip to content"
      // has somewhere to land. tabIndex={-1} makes it focusable.
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-paper">
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
      </main>
    );
  }

  // Only the cohorts still open to THIS user. A decline shuts the cohort that
  // issued it (lib/reapply.ts), so the picker below must not offer it and the
  // default selection must not land on it — the old chain ended at
  // `cohorts[0]`, which meant a student declined from the soonest cohort was
  // silently pointed straight back at it.
  const cohorts = plan.allowed;
  const pinnedId =
    typeof settings.active_cohort_id === "string"
      ? settings.active_cohort_id
      : null;
  // Cohort selection order: explicit ?cohort= → user's existing draft
  // → admin-pinned active → most upcoming still open to them.
  const queryCohort =
    typeof searchParams.cohort === "string" ? searchParams.cohort : null;
  const draftCohortId =
    existing && !reapplying ? (existing as any).cohort_id ?? null : null;
  const selectedId = selectCohortId(cohorts, [
    queryCohort,
    draftCohortId,
    pinnedId,
  ]);
  const selected = cohorts.find((c) => c.id === selectedId) ?? null;

  // Nothing left to apply to. Two shapes, and they need different words: the
  // cohort that declined them is the only one open (come back next season), or
  // no cohort is open at all (the ordinary between-cohorts lull). Rendering an
  // empty picker and a live submit button, which is what the old code did, sent
  // the application to whatever getActiveCohortId() happened to return.
  if (!selected) {
    const declinedFromOnly = plan.blocked.length > 0;
    return (
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-paper">
        <div className="relative mx-auto max-w-2xl px-5 sm:px-6 py-24">
          <Link href="/dashboard" className="text-sm text-ink-soft hover:text-ink">
            ← Dashboard
          </Link>
          <div className="mt-8 rounded-2xl border border-line bg-wash p-6">
            <h1 className="font-display text-2xl font-bold tracking-[-0.02em] text-ink">
              {declinedFromOnly
                ? "No other cohort is open yet"
                : "No cohort is open right now"}
            </h1>
            <p className="mt-3 text-sm text-ink-soft">
              {declinedFromOnly
                ? `You've already had a decision on ${plan.blocked
                    .map((c) => c.name)
                    .join(" and ")}, so applying again means a different cohort — and there isn't one open yet. We'll email you when the next one opens; your answers stay on file.`
                : "Applications reopen when the next cohort is announced. We'll email you then."}
            </p>
            {declinedFromOnly && (
              <p className="mt-3 text-sm text-ink-soft">
                A Founder Pass reopens the current cohort for another run —{" "}
                <Link href="/pass" className="text-phosphor-ink hover:underline">
                  see what it carries
                </Link>
                .
              </p>
            )}
            <Link
              href="/dashboard/application"
              className="press mt-6 inline-flex items-center gap-2 rounded-md border border-line px-4 py-2 text-sm text-ink-soft hover:border-ink/30"
            >
              View your last application
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const cohortName =
    selected?.name ?? settings.active_cohort_name ?? "the next cohort";
  const capacity = selected?.capacity ?? 24;
  const country = getCountryFromHeaders(headers());
  const regional = getRegionalPrice(selected?.price_cents ?? 13000, country);
  const priceDollars = (regional.amountCents / 100).toFixed(0);
  const hasMultiple = cohorts.length > 1;

  return (
    // Skip-link target (see the closed-applications branch above).
    <main id="main-content" tabIndex={-1} className="min-h-screen bg-paper">
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
              {plan.blocked.length > 0 &&
                ` ${plan.blocked
                  .map((c) => c.name)
                  .join(" and ")} isn't listed — you've already had a decision there.`}
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
                {existing!.status !== "rejected"
                  ? "You withdrew from a previous application. You can reapply to the cohort below."
                  : plan.passReopened
                    ? `Your last application wasn't accepted. Your Founder Pass reopens ${cohortName} — you can go straight back at it below.`
                    : "Your last application wasn't accepted. You can apply again, to a cohort you haven't been decided on."}
              </p>
            </div>
          </div>
        )}

        {/* The auto-admit perk, said before they start rather than after they
            submit. A holder who doesn't know the outcome is guaranteed writes
            the whole form braced for a wait that isn't coming. */}
        {willAutoAdmit && (
          <div className="mt-6 flex items-start gap-3 rounded-xl border border-phosphor/40 bg-phosphor/5 p-4 text-sm">
            <div>
              <p className="font-medium text-phosphor-ink">
                Your Founder Pass carries a seat
              </p>
              <p className="mt-1 text-ink-soft">
                Submit this and you&apos;re admitted to {cohortName} on the spot —
                no review queue, no wait. Fill it in properly anyway: it&apos;s
                what your mentors read first.
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
    </main>
  );
}
