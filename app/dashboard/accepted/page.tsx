import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser, getProfile } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { Card } from "@/components/ui/card";
import { getCountryFromHeaders, getRegionalPrice } from "@/lib/pricing";
import {
  passDiscountCentsForUser,
} from "@/lib/founder-pass";
import { fmtDateOnly, isAcceptedStatus } from "@/lib/pre-cohort";
import { PayButton } from "../application/pay-button";
import {
  CalendarDays,
  FolderArchive,
  MessagesSquare,
  PartyPopper,
  Rocket,
  Zap,
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
  const supabase = createClient();
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

  // Mirror the checkout math exactly (regional price, then the founder-pass
  // discount) so the number here is the number Stripe charges.
  const basePriceCents = app.cohort?.price_cents ?? 13000;
  const country = getCountryFromHeaders(headers());
  const regionalCents = getRegionalPrice(basePriceCents, country).amountCents;
  // The discount is read off the holder's own tier and resolved against the
  // regional amount — the same call checkout makes, so this page and Stripe
  // can't disagree about what they owe.
  const passDiscountCents = await passDiscountCentsForUser(
    supabase,
    user.id,
    regionalCents,
  );
  const priceCents = Math.max(0, regionalCents - passDiscountCents);
  const price = `$${(priceCents / 100).toFixed(0)}`;

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
          We read every application ourselves, and yours earned a seat in{" "}
          <span className="font-medium text-ink">{cohortName}</span>. That is
          the hard part — and it's done.
        </p>
      </div>

      <Card className="mt-8 border-phosphor/40 bg-phosphor/5">
        <h2 className="text-lg font-semibold text-phosphor-ink">
          Lock in your seat
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          A one-time {price} tuition holds your place
          {startLabel ? ` in the cohort starting ${startLabel}` : ""}. Seats are
          finite — an accepted seat isn't yours until it's paid for.
        </p>
        {passDiscountCents > 0 && (
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-phosphor-ink">
            <Zap className="h-3.5 w-3.5" />
            Founder pass applied — $
            {(passDiscountCents / 100).toFixed(0)} off tuition.
          </p>
        )}
        <div className="mt-5">
          <PayButton applicationId={app.id} />
        </div>
      </Card>

      <section className="mt-10">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.22em] text-ink-faint">
          What paying opens today
        </h2>
        <div className="mt-4 border-t border-line">
          <Perk
            icon={CalendarDays}
            title="Your kickoff page"
            body={`Everything about day one${startLabel ? ` on ${startLabel}` : ""} — what unlocks, and how to arrive ready.`}
          />
          <Perk
            icon={MessagesSquare}
            title="The Discord"
            body="Meet the founders you'll be building alongside before the cohort even starts."
          />
          <Perk
            icon={Rocket}
            title="Your team page"
            body="Start a team and line up co-founders early. You don't have to wait for kickoff."
          />
          <Perk
            icon={FolderArchive}
            title="Before One"
            body="The pre-cohort flows — the work you do before your company becomes real."
          />
        </div>
        <p className="mt-6 text-sm text-ink-soft">
          The full program — course, check-ins, office hours, events — opens
          at kickoff{startLabel ? ` on ${startLabel}` : ""}.
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
        — nothing here expires today.
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
