import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { Card, StatusBadge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PayButton } from "./pay-button";

export const metadata = { title: "Application · SparkLine" };

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
        <p className="mt-2 text-white/60">You haven't started an application yet.</p>
        <Link href="/apply" className="mt-5 inline-block">
          <Button>Start application</Button>
        </Link>
      </div>
    );
  }

  const priceCents = app.cohort?.price_cents ?? 9700;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Application</h1>
        <StatusBadge status={app.status} />
      </div>

      {searchParams.submitted && (
        <div className="mt-5 rounded-lg border border-spark/30 bg-spark/5 p-4 text-sm">
          <p className="font-medium text-spark">Application submitted</p>
          <p className="mt-1 text-white/60">
            We'll review and get back to you by email. You can check status here anytime.
          </p>
        </div>
      )}
      {searchParams.canceled && (
        <div className="mt-5 rounded-lg border border-amber-400/30 bg-amber-400/5 p-4 text-sm text-amber-200">
          Payment canceled. You can retry any time.
        </div>
      )}

      {app.status === "accepted" && (
        <Card className="mt-6 border-spark/40 bg-spark/5">
          <h3 className="text-lg font-semibold text-spark">You're in.</h3>
          <p className="mt-1 text-sm text-white/70">
            Welcome to {app.cohort?.name ?? "SparkLine"}. Pay your one-time ${(priceCents / 100).toFixed(0)} to lock in your seat. Course access unlocks immediately after.
          </p>
          <div className="mt-5">
            <PayButton applicationId={app.id} />
          </div>
        </Card>
      )}

      {app.status === "rejected" && (
        <Card className="mt-6">
          <h3 className="text-lg font-semibold">Decision: not this cohort</h3>
          <p className="mt-1 text-sm text-white/60">
            Thanks for applying. We can't offer you a seat in this cohort.
          </p>
          {app.review_notes && (
            <p className="mt-3 text-sm text-white/70">
              <span className="text-white/40">Notes:</span> {app.review_notes}
            </p>
          )}
        </Card>
      )}

      {(app.status === "paid" || app.status === "enrolled") && (
        <Card className="mt-6 border-emerald-400/40 bg-emerald-400/5">
          <h3 className="text-lg font-semibold text-emerald-300">Enrolled</h3>
          <p className="mt-1 text-sm text-white/70">
            Payment received. You're all set.
          </p>
          <Link href="/dashboard/course" className="mt-4 inline-block">
            <Button>Open course</Button>
          </Link>
        </Card>
      )}

      <Card className="mt-6">
        <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-white/50">
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
          <Row label="Heard about us" value={app.referral_source} />
          <Row label="Why SparkLine" value={app.why_join} multiline />
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
    <div className={`${multiline ? "" : "flex items-baseline gap-3"} border-b border-white/5 py-2 last:border-0`}>
      <div className="text-xs uppercase tracking-wider text-white/40">{label}</div>
      <div className={`${multiline ? "mt-1 whitespace-pre-wrap" : ""} text-white/80`}>
        {value || <span className="text-white/30">—</span>}
      </div>
    </div>
  );
}
