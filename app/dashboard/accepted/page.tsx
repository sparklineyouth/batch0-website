import Link from "next/link";
import { cohortEligibility } from "@/lib/cohort-eligibility";
import { easternDeadline, formatUsd } from "@/lib/offer-format";
import { ParentPaymentLink } from "./parent-payment-link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser, getProfile } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { Card } from "@/components/ui/card";
import { getCountryFromHeaders } from "@/lib/pricing";
import { applicationQuote, type CheckoutApplication } from "@/lib/checkout-service";
import type { TuitionQuote } from "@/lib/tuition-quote";
import { createAdminClient } from "@/lib/supabase/admin";
import { fmtDateOnly, isAcceptedStatus } from "@/lib/pre-cohort";
import { PayButton } from "../application/pay-button";
import {
  CalendarDays,
  FolderArchive,
  MessagesSquare,
  PartyPopper,
  Rocket,
  Zap,
  GraduationCap,
} from "lucide-react";

export const metadata = { title: "You're in · batch0" };

/**
 * The congratulations moment. An acceptance used to be a status badge on
 * the application page next to a form full of the answers they already
 * wrote — this gives the decision a page of its own, and makes the one
 * thing that matters next (locking in the seat) the only call to action.
 */
export default async function AcceptedPage() {
  const user = await requireUser();
  const supabase = await createClient();
  const profile = await getProfile();
  const access = await getStudentAccess(profile?.role ?? "student");

  const { data: app } = await supabase
    .from("applications")
    .select("*, cohort:cohorts(*)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Already paid? This page is about a decision they've moved past — send
  // them to the enrollment confirmation instead. The status check matters
  // on its own: isAcceptedStatus() counts "paid" and "enrolled" too, and
  // getStudentAccess is request-cached, so it can still read false on the
  // very render where the payment landed.
  if (
    access.enrolled ||
    app?.status === "paid" ||
    app?.status === "enrolled"
  ) {
    redirect("/dashboard/enrolled");
  }
  if (!app || !isAcceptedStatus(app.status)) redirect("/dashboard");

  // Checkout and the parent invitation share this quote, including any active
  // reservation. Failed discount reads must never display a full-price bill.
  let quote: TuitionQuote | null = null;
  try {
    if (app.cohort) quote = await applicationQuote(
      createAdminClient(), app as CheckoutApplication,
      getCountryFromHeaders(await headers()),
    );
  } catch {
    // The page remains useful while tuition is unavailable; payment stays off.
  }
  const price = quote ? formatUsd(quote.amountCents) : "temporarily unavailable";
  const passDiscountCents = quote?.passDiscountCents ?? 0;
  const scholarshipDiscountCents = quote?.scholarshipDiscountCents ?? 0;
  const admission = app.cohort ? cohortEligibility(app.cohort) : null;
  const started = admission?.mode === "late_entry" || !!(app.cohort?.starts_on && new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()) >= app.cohort.starts_on);
  const parentInfoHref = `/parents?cohort=${encodeURIComponent(app.cohort_id ?? "")}`;

  const cohortName = app.cohort?.name ?? "batch0";
  const startLabel = fmtDateOnly(
    app.cohort?.starts_on ?? access.cohortStartsOn,
  );
  const firstName = profile?.full_name?.split(" ")[0] ?? null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="border-b border-line pb-8">
        <p className="inline-flex items-center gap-2 rounded-full border border-phosphor/30 bg-phosphor/[0.08] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-phosphor-ink">
          <PartyPopper className="h-3.5 w-3.5" />
          {cohortName} · Accepted
        </p>
        <h1 className="mt-5 text-4xl font-bold tracking-[-0.02em] text-ink md:text-6xl">
          You're in{firstName ? `, ${firstName}` : ""}.
        </h1>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-soft">
          Your application to <span className="font-medium text-ink">{cohortName}</span> is accepted. Review the schedule and tuition below before confirming enrollment.
        </p>
      </div>

      <Card className="mt-8 border-phosphor/40 bg-phosphor/5">
        <h2 className="text-lg font-semibold text-phosphor-ink">
          {admission?.eligible ? "Confirm your enrollment" : "Enrollment is closed for this cohort"}
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          {admission?.eligible
            ? !quote ? "We could not verify your current tuition. Refresh this page before paying; your acceptance has not changed."
              : started
              ? `This cohort is underway. One-time tuition is ${price}; late entry is available until ${easternDeadline(admission.deadline)}.`
              : `One-time tuition is ${price}${startLabel ? ` for the cohort starting ${startLabel}` : ""}. Payment confirms enrollment, subject to available capacity.`
            : admission?.reason ?? "Contact the team to confirm the cohort details before paying."}
        </p>
        {admission?.mode === "late_entry" && <p className="mt-3 text-sm leading-relaxed text-ink-soft">{app.cohort?.catch_up_plan}</p>}
        <p className="mt-3 text-sm"><Link href={parentInfoHref} className="link-ink">Review the exact calendar and parent guide →</Link></p>
        {passDiscountCents > 0 && (
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-phosphor-ink">
            <Zap className="h-3.5 w-3.5" />
            Founder pass applied — {formatUsd(passDiscountCents)} off tuition.
          </p>
        )}
        {scholarshipDiscountCents > 0 && (
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-phosphor-ink">
            <GraduationCap className="h-3.5 w-3.5" />
            Scholarship applied — {formatUsd(scholarshipDiscountCents)} off tuition. Nothing
            to enter; it's already in the price above.
          </p>
        )}
        {admission?.eligible && quote ? <>
          <p className="mt-4 text-xs text-ink-soft">Review the <Link href="/refund-policy" className="link-ink">refund policy</Link> before paying.</p>
          <div className="mt-5"><PayButton applicationId={app.id} /></div>
          <ParentPaymentLink applicationId={app.id} parentInfoHref={parentInfoHref} />
        </> : !admission?.eligible ? <p className="mt-5 text-sm"><Link href="/apply" className="link-ink">See available cohorts</Link> or <a href="mailto:hello@batch0.org" className="link-ink">ask the team for help</a>.</p> : <p className="mt-5 text-sm"><a href="mailto:hello@batch0.org" className="link-ink">Contact the team if tuition remains unavailable.</a></p>}
      </Card>

      <section className="mt-10">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.22em] text-ink-faint">
          {started ? "Your first steps after enrollment" : "What enrollment opens now"}
        </h2>
        <div className="mt-4 border-t border-line">
          <Perk
            icon={CalendarDays}
            title={started ? "Your course and calendar" : "Your kickoff page"}
            body={started ? "Open Course for the lessons and workbooks. Events holds your live session links and calendar downloads." : `Get ready for day one${startLabel ? ` on ${startLabel}` : ""}. Review your kickoff instructions and available preparation materials.`}
          />
          <Perk
            icon={MessagesSquare}
            title="The Discord"
            body="Meet the students you will build alongside in the moderated community."
          />
          <Perk
            icon={Rocket}
            title="Your team page"
            body="Set up your project and find teammates. You can begin with an idea or work through discovery exercises."
          />
          <Perk
            icon={FolderArchive}
            title={started ? "Catch up with support" : "Before One"}
            body={started ? "Complete the kickoff project brief and bring your questions to office hours. Ask the team which work to prioritize." : "Start with the preparation resources while you wait for the live cohort."}
          />
        </div>
        <p className="mt-6 text-sm text-ink-soft">
          {started ? "The cohort has started. After enrollment, course materials, check-ins and scheduled live sessions are available in your dashboard." : `The full program opens at kickoff${startLabel ? ` on ${startLabel}` : ""}.`}
        </p>
      </section>

      <p className="mt-10 text-xs text-ink-faint">
        Need more time or have a question first?{" "}
        <Link
          href="/dashboard/application"
          className="underline underline-offset-2 hover:text-ink-soft"
        >
          Review your application
        </Link>{" "}
        . {admission?.deadline ? `The enrollment deadline is ${easternDeadline(admission.deadline)}.` : "Contact the team if you need help deciding."}
      </p>
    </div>
  );
}

function Perk({
  icon: Icon,
  title,
  body,
}: {
  icon: any;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-4 border-b border-line py-4">
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-phosphor-ink" />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium text-ink">{title}</p>
        <p className="mt-0.5 text-sm leading-relaxed text-ink-soft">{body}</p>
      </div>
    </div>
  );
}
