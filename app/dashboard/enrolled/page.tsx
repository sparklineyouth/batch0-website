import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser, getProfile } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { ButtonLink } from "@/components/ui/button";
import { PaymentResult } from "@/components/payment-result";
import { settleCheckoutSession } from "@/lib/settle-checkout";
import { fmtDateOnly } from "@/lib/pre-cohort";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle,
  FolderArchive,
  MessagesSquare,
  PlayCircle,
  Receipt,
  Rocket,
} from "lucide-react";

export const metadata = { title: "You're enrolled · batch0" };

/**
 * Where Stripe Checkout returns a student who just paid tuition.
 *
 * The session id rides in on the URL and is settled against Stripe before
 * anything renders, so the confirmation is true the instant they land
 * rather than whenever the webhook happens to arrive. The page is also
 * stable to revisit later — any enrolled student can open it.
 */
export default async function EnrolledPage({
  searchParams,
}: {
  searchParams: { session_id?: string };
}) {
  const user = await requireUser();
  const supabase = createClient();

  // Settle first: this is what turns "we'll get to it" into a confirmation
  // the student can trust, and it's what makes the enrolled-only gate
  // below pass on the very first render after paying.
  const payment = await settleCheckoutSession(searchParams.session_id, user.id);

  const profile = await getProfile();
  const access = await getStudentAccess(profile?.role ?? "student");

  const { data: app } = await supabase
    .from("applications")
    .select("status, cohort:cohorts(name, starts_on)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const paidUp =
    access.enrolled || app?.status === "paid" || app?.status === "enrolled";

  // Not enrolled and the payment is still clearing? Hold them here with
  // the processing banner rather than bouncing — being redirected away
  // seconds after paying is exactly the moment that breeds support email.
  if (!paidUp && payment?.state !== "processing") {
    redirect(app?.status === "accepted" ? "/dashboard/accepted" : "/dashboard");
  }

  const cohort = Array.isArray(app?.cohort) ? app?.cohort[0] : app?.cohort;
  const cohortName = cohort?.name ?? access.cohortName ?? "batch0";
  const startLabel = fmtDateOnly(cohort?.starts_on ?? access.cohortStartsOn);
  const firstName = profile?.full_name?.split(" ")[0] ?? null;
  const started = !access.preCohort;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="border-b border-line pb-8">
        <p className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-300">
          <CheckCircle className="h-3.5 w-3.5" />
          {cohortName} · Enrolled
        </p>
        <h1 className="mt-5 text-4xl font-bold tracking-[-0.02em] text-ink md:text-6xl">
          Your seat is locked in.
        </h1>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-soft">
          {paidUp ? (
            <>
              Payment received{firstName ? `, ${firstName}` : ""}. You're
              officially part of{" "}
              <span className="font-medium text-ink">{cohortName}</span>
              {startLabel && !started
                ? `, which kicks off on ${startLabel}.`
                : "."}{" "}
              A receipt is on its way to your inbox.
            </>
          ) : (
            <>
              We've got your payment and we're waiting on your bank to
              confirm it. Nothing more for you to do.
            </>
          )}
        </p>
      </div>

      <PaymentResult result={payment} />

      <section className="mt-10">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.22em] text-ink-faint">
          {started ? "Open now" : "Open to you today"}
        </h2>
        <div className="mt-4 border-t border-line">
          {started ? (
            <NextStep
              href="/dashboard/course"
              icon={PlayCircle}
              title="The course"
              body="Weekly modules and deliverables. Start with week one."
            />
          ) : (
            <NextStep
              href="/dashboard/kickoff"
              icon={CalendarDays}
              title="Your kickoff page"
              body={`What happens on day one${startLabel ? ` — ${startLabel}` : ""}, and how to arrive ready.`}
            />
          )}
          <NextStep
            href="/dashboard/community"
            icon={MessagesSquare}
            title="Link your Discord"
            body="Meet your cohort. Link once and your role stays in sync forever."
          />
          <NextStep
            href="/dashboard/team"
            icon={Rocket}
            title="Start your team"
            body="Up to 4 teammates from your cohort. You can begin before kickoff."
          />
          <NextStep
            href="/dashboard/resources"
            icon={FolderArchive}
            title="Before One"
            body="The pre-cohort flows — the work you do before your company becomes real."
          />
        </div>
      </section>

      {!started && (
        <p className="mt-8 text-sm text-ink-soft">
          The rest of the program — course, check-ins, office hours, events —
          unlocks at kickoff{startLabel ? ` on ${startLabel}` : ""}.
        </p>
      )}

      <div className="mt-10 flex flex-wrap items-center gap-3">
        <ButtonLink href={started ? "/dashboard/course" : "/dashboard/kickoff"}>
          {started ? "Open the course" : "See kickoff details"}
          <ArrowRight className="h-4 w-4 shrink-0" />
        </ButtonLink>
        <Link
          href="/dashboard/billing/receipts"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-soft hover:text-ink"
        >
          <Receipt className="h-3.5 w-3.5" /> Receipts
        </Link>
      </div>
    </div>
  );
}

function NextStep({
  href,
  icon: Icon,
  title,
  body,
}: {
  href: string;
  icon: any;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="press group flex items-start gap-4 border-b border-line py-4 hover:bg-wash"
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-phosphor-ink" />
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium text-ink">{title}</span>
        <span className="mt-0.5 block text-sm leading-relaxed text-ink-soft">
          {body}
        </span>
      </span>
      <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-ink-faint group-hover:text-ink-soft" />
    </Link>
  );
}
