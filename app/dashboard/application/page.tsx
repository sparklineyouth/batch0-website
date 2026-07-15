import Link from "next/link";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { Card, StatusBadge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getCountryFromHeaders, getRegionalPrice } from "@/lib/pricing";
import {
  hasFounderPass,
  FOUNDER_PASS_TUITION_DISCOUNT_CENTS,
} from "@/lib/founder-pass";
import { PayButton } from "./pay-button";
import { TrackSubmitted } from "./track-submitted";

export const metadata = { title: "Application · batch0" };

export default async function ApplicationPage({
  searchParams,
}: {
  searchParams: { submitted?: string; canceled?: string };
}) {
  const user = await requireUser();
  const supabase = createClient();

  const { data: app } = await supabase
    .from("applications")
    .select("*, cohort:cohorts(*)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!app) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-bold tracking-tight">Application</h1>
        <p className="mt-2 text-ink-soft">You haven't started an application yet.</p>
        <Link href="/apply" className="mt-5 inline-block">
          <Button>Start application</Button>
        </Link>
      </div>
    );
  }

  const basePriceCents = app.cohort?.price_cents ?? 13000;
  const country = getCountryFromHeaders(headers());
  // Mirror the checkout math (app/api/stripe/checkout) exactly — regional
  // price, then the founder-pass discount — so the number on this card is
  // the number Stripe charges. founder_passes has a self-select policy, so
  // the user's own client can answer "do I hold one".
  const passDiscountCents =
    app.status === "accepted" && (await hasFounderPass(supabase, user.id))
      ? FOUNDER_PASS_TUITION_DISCOUNT_CENTS
      : 0;
  const priceCents = Math.max(
    0,
    getRegionalPrice(basePriceCents, country).amountCents - passDiscountCents,
  );

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Application</h1>
        <StatusBadge status={app.status} />
      </div>

      {searchParams.submitted && (
        <div className="mt-5 rounded-lg border border-phosphor/30 bg-phosphor/5 p-4 text-sm">
          <TrackSubmitted />
          <p className="font-medium text-phosphor-ink">Application submitted</p>
          <p className="mt-1 text-ink-soft">
            We'll review and get back to you by email. You can check status here anytime.
          </p>
        </div>
      )}
      {searchParams.canceled && (
        <div className="mt-5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300">
          Payment canceled. You can retry any time.
        </div>
      )}

      {app.status === "accepted" && (
        <Card className="mt-6 border-phosphor/40 bg-phosphor/5">
          <h3 className="text-lg font-semibold text-phosphor-ink">You're in.</h3>
          <p className="mt-1 text-sm text-ink-soft">
            Welcome to {app.cohort?.name ?? "batch0"}. Pay your one-time ${(priceCents / 100).toFixed(0)} to lock in your seat. Course access unlocks immediately after.
          </p>
          {passDiscountCents > 0 && (
            <p className="mt-2 text-xs font-medium text-phosphor-ink">
              Founder pass applied — $
              {(passDiscountCents / 100).toFixed(0)} off tuition.
            </p>
          )}
          {app.review_notes && <ReviewerNote text={app.review_notes} />}
          <div className="mt-5">
            <PayButton applicationId={app.id} />
          </div>
        </Card>
      )}

      {app.status === "rejected" && (
        <Card className="mt-6">
          <h3 className="text-lg font-semibold">Decision: not this cohort</h3>
          <p className="mt-1 text-sm text-ink-soft">
            Thanks for applying. We can't offer you a seat in this cohort.
          </p>
          {app.review_notes && <ReviewerNote text={app.review_notes} />}
        </Card>
      )}

      {(app.status === "paid" || app.status === "enrolled") && (
        <Card className="mt-6 border-emerald-500/30 bg-emerald-500/10">
          <h3 className="text-lg font-semibold text-emerald-700 dark:text-emerald-300">Enrolled</h3>
          <p className="mt-1 text-sm text-ink-soft">
            Payment received. You're all set.
          </p>
          {app.review_notes && <ReviewerNote text={app.review_notes} />}
          <Link href="/dashboard/course" className="mt-4 inline-block">
            <Button>Open course</Button>
          </Link>
        </Card>
      )}

      {app.status === "submitted" && app.review_notes && (
        <Card className="mt-6">
          <h3 className="text-sm font-medium uppercase tracking-wider text-ink-faint">
            Note from the team
          </h3>
          <ReviewerNote text={app.review_notes} />
        </Card>
      )}

      <Card className="mt-6">
        <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-ink-faint">
          Your answers
        </h3>
        <div className="space-y-3 text-sm">
          <Row label="Full name" value={app.full_name} />
          <Row label="Age" value={app.age?.toString()} />
          <Row label="Grade" value={app.grade} />
          <Row label="School" value={app.school} />
          <Row label="Location" value={[app.city, app.country].filter(Boolean).join(", ")} />
          <Row label="Parent email" value={app.parent_email} />
          <Row label="Hours/week" value={app.hours_per_week?.toString()} />
          <Row
            label="Team size"
            value={
              app.team_size == null
                ? null
                : app.team_size === 1
                  ? "Solo"
                  : app.team_size >= 5
                    ? "5+"
                    : String(app.team_size)
            }
          />
          <Row label="Heard about us" value={app.referral_source} />
          <Row label="LinkedIn" value={app.linkedin_url} />
          <Row label="Resume" value={app.resume_url} />
          <Row label="Portfolio" value={app.portfolio_url} />
          <Row label="Why batch0" value={app.why_join} multiline />
          <Row label="Startup idea" value={app.startup_idea} multiline />
          <Row label="Experience" value={app.experience} multiline />
        </div>
        {app.status === "draft" && (
          <Link href="/apply" className="mt-5 inline-block">
            <Button variant="secondary" size="sm">Continue editing</Button>
          </Link>
        )}
      </Card>
    </div>
  );
}

function ReviewerNote({ text }: { text: string }) {
  return (
    <div className="mt-4 rounded-lg border border-line bg-paper p-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
        Note from reviewer
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-soft">
        {text}
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  multiline,
}: {
  label: string;
  value?: string | null;
  multiline?: boolean;
}) {
  return (
    <div className={`${multiline ? "" : "flex items-baseline gap-3"} min-w-0 border-b border-line py-2 last:border-0`}>
      <div className="text-xs uppercase tracking-wider text-ink-faint">{label}</div>
      <div
        className={`${multiline ? "mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]" : "min-w-0 truncate"} text-ink-soft`}
      >
        {value || <span className="text-ink-faint">—</span>}
      </div>
    </div>
  );
}
