import Link from "next/link";
import { cohortEligibility } from "@/lib/cohort-eligibility";
import { formatUsd } from "@/lib/offer-format";
import { loadPromoConfig } from "@/lib/promo-settings";
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
import { formatDateSentence } from "@/lib/seo-meta";
import { FORM_KEYS } from "@/lib/apply-flow";
import { ApplyFlow, type CohortOption } from "./apply-flow";
import { ApplyMessage } from "./apply-message";
import { getCountryFromHeaders, getRegionalPrice } from "@/lib/pricing";
import { getApplicationForm } from "@/lib/application-questions";
import { getScholarshipInterestQuestions } from "@/lib/scholarships";
import { listPriceCents, promoPriceCents } from "@/lib/promo";

export const metadata = {
  title: "Apply · batch0",
  description:
    "Apply to batch0 — the live, online startup accelerator for high schoolers. Free to apply; tuition charged only if accepted. Rolling review.",
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

/** A stored instant as the Eastern calendar day it falls on: "Dec 12". */
function easternDay(iso: string | null | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

function weeksBetween(startsOn: string | null, endsOn: string | null): number | null {
  if (!startsOn || !endsOn) return null;
  const days = (Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(days) && days > 0 ? Math.round(days / 7) : null;
}

export default async function ApplyPage(
  props: {
    searchParams: Promise<{ cohort?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  const supabase = await createClient();

  const admin = createAdminClient();

  const [
    { data: history },
    pass,
    { data: settingsRows },
    { data: openCohorts },
    form,
    scholarshipQuestions,
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
      .select("*")
      .in("status", ["upcoming", "active"])
      .order("starts_on", { ascending: true }),
    getApplicationForm(),
    getScholarshipInterestQuestions(),
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
    cohorts: (openCohorts ?? []).filter(cohort => cohortEligibility(cohort).eligible),
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
      <ApplyMessage eyebrow="Applications" title="Applications are closed.">
        <p>
          {settings.applications_closed_message ??
            "Applications are currently closed. Check back soon for the next cohort."}
        </p>
      </ApplyMessage>
    );
  }

  // Only the cohorts still open to THIS user. A decline shuts the cohort that
  // issued it (lib/reapply.ts), so the chooser must not offer it and the
  // default selection must not land on it.
  const cohorts = plan.allowed;
  const pinnedId =
    typeof settings.active_cohort_id === "string"
      ? settings.active_cohort_id
      : null;
  // Cohort selection order: explicit ?cohort= → user's existing draft
  // → admin-pinned active → most upcoming still open to them — the same chain
  // the submit action resolves. Used here to decide whether anything is open;
  // what the chooser starts on is `initialCohortId` below.
  const queryCohort =
    typeof searchParams.cohort === "string" ? searchParams.cohort : null;
  const draftCohortId =
    existing && !reapplying ? (existing as any).cohort_id ?? null : null;
  const selectedId = selectCohortId(cohorts, [
    queryCohort,
    draftCohortId,
    pinnedId,
  ]);

  // Nothing left to apply to. Two shapes, and they need different words: the
  // cohort that declined them is the only one open (come back next season), or
  // no cohort is open at all (the ordinary between-cohorts lull).
  if (!selectedId) {
    const declinedFromOnly = plan.blocked.length > 0;
    return (
      <ApplyMessage
        eyebrow="Applications"
        title={declinedFromOnly ? "No other cohort is open yet." : "No cohort is open right now."}
        actions={
          <Link
            href="/dashboard/application"
            className="press inline-flex h-11 items-center rounded-md border border-line px-5 text-sm text-ink hover:border-ink/30 hover:bg-wash"
          >
            View your last application
          </Link>
        }
      >
        <p>
          {declinedFromOnly
            ? `You've already had a decision on ${plan.blocked
                .map((c) => c.name)
                .join(" and ")}, so applying again means a different cohort — and there isn't one open yet. We'll email you when the next one opens; your answers stay on file.`
            : "Applications reopen when the next cohort is announced. We'll email you then."}
        </p>
        {declinedFromOnly && (
          <p>
            A Founder Pass reopens the current cohort for another run —{" "}
            <Link href="/pass" className="link-ink">
              see what it carries
            </Link>
            .
          </p>
        )}
      </ApplyMessage>
    );
  }

  // Every open cohort as a card: the same regional + promo price chain the
  // single-cohort page always quoted, applied per cohort, because cohorts can
  // carry different tuition.
  const country = getCountryFromHeaders(await headers());
  const promo = await loadPromoConfig();
  const now = new Date();
  const cohortOptions: CohortOption[] = cohorts.map((c: any) => {
    const eligibility = cohortEligibility(c, now);
    const regional = getRegionalPrice(listPriceCents(c.price_cents ?? 13000), country);
    const lateEntry = eligibility.mode === "late_entry";
    const deadline = easternDay(eligibility.deadline);
    return {
      id: c.id,
      name: c.name,
      dates: formatDateSentence(c.starts_on, c.ends_on) || "Dates coming soon",
      weeks: weeksBetween(c.starts_on, c.ends_on),
      priceLabel: formatUsd(promoPriceCents(regional.amountCents, now, promo)),
      lateEntry,
      deadlineLabel: deadline
        ? lateEntry
          ? `Late entry ends ${deadline}`
          : `Applications close ${deadline}`
        : "",
      catchUpPlan: lateEntry ? c.catch_up_plan ?? null : null,
      capacity: c.capacity ?? 24,
    };
  });
  const selected = cohortOptions.find((c) => c.id === selectedId) ?? cohortOptions[0];
  // What the chooser starts on. One open cohort: that one, and the question
  // is never asked. Several: only a preference the applicant (or an admin pin)
  // actually expressed — never the bare "soonest" fallback, which can be a
  // cohort already weeks into late entry. Picking is the whole point of the
  // question, so an unexpressed choice starts unselected.
  // A draft's cohort counts only if the draft holds a real answer: blank rows
  // created by a referral link (before that stopped attaching a cohort) carry
  // the server's soonest-cohort fallback, not anything the applicant picked.
  const draftHasAnswers =
    !!existing &&
    FORM_KEYS.some((key) => {
      const value = (existing as Record<string, unknown>)[key];
      return value !== null && value !== undefined && value !== 0 && String(value).trim() !== "";
    });
  const expressed = [queryCohort, draftHasAnswers ? draftCohortId : null, pinnedId].find(
    (id) => !!id && cohortOptions.some((c) => c.id === id),
  );
  const initialCohortId = cohortOptions.length === 1 ? cohortOptions[0].id : expressed ?? null;

  const notices: { tone: "accent" | "neutral"; title: string; body: string }[] = [];
  if (reapplying) {
    notices.push({
      tone: "neutral",
      title: "Starting a fresh application",
      body:
        existing!.status !== "rejected"
          ? "You withdrew from a previous application, so you can apply again — including to the same cohort."
          : plan.passReopened
            ? `Your last application wasn't accepted. Your Founder Pass reopens ${selected.name} — you can go straight back at it.`
            : "Your last application wasn't accepted. You can apply again, to a cohort you haven't been decided on.",
    });
  }
  // The auto-admit perk, said before they start rather than after they
  // submit. A holder who doesn't know the outcome is guaranteed writes the
  // whole form braced for a wait that isn't coming.
  if (willAutoAdmit) {
    notices.push({
      tone: "accent",
      title: "Your Founder Pass carries a seat",
      body: `Submit this and you're admitted on the spot — no review queue, no wait. Fill it in properly anyway: it's what your mentors read first.`,
    });
  }

  const suggestedName =
    typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name.trim() : "";

  return (
    <ApplyFlow
      // A reapply starts blank; a draft continues where it stopped.
      mode={reapplying ? "reapply" : existing?.status === "draft" ? "draft" : "new"}
      email={user.email ?? ""}
      defaults={reapplying ? null : existing ?? null}
      suggestedName={suggestedName}
      questions={form.builtins}
      customQuestions={form.custom}
      scholarshipQuestions={scholarshipQuestions}
      cohorts={cohortOptions}
      initialCohortId={initialCohortId}
      notices={notices}
      blockedCohortNames={plan.blocked.map((c) => c.name)}
      parentGuideHref={`/parents?cohort=${selected.id}`}
    />
  );
}
