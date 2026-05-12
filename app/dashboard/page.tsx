import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import { Card, StatusBadge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ReferralCard } from "./referral-card";
import { ChargePayButton } from "@/components/charge-pay-button";
import { env } from "@/lib/env";
import { AlertCircle } from "lucide-react";

export default async function DashboardHome() {
  const user = await requireUser();
  const supabase = createClient();

  const [
    { data: profile },
    { data: app },
    { data: enrollment },
    { data: pendingFees },
    { data: certificate },
  ] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", user.id).single(),
    supabase
      .from("applications")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("enrollments")
      .select("*, cohort:cohorts(*)")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("user_charges")
      .select("*")
      .eq("user_id", user.id)
      .eq("kind", "fee")
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
    supabase
      .from("certificates")
      .select("code")
      .eq("user_id", user.id)
      .order("issued_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const greeting = profile?.full_name?.split(" ")[0] || "there";

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-3xl font-bold tracking-tight">
        Welcome, {greeting}.
      </h1>
      <p className="mt-1 text-sm text-white/50">
        Here's where your SparkLine journey lives.
      </p>

      {(pendingFees?.length ?? 0) > 0 && (
        <div className="mt-6 space-y-3">
          {(pendingFees ?? []).map((f: any) => (
            <Card
              key={f.id}
              className="border-amber-300/30 bg-amber-300/5"
            >
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-amber-200">
                    Fee due: {f.description}
                  </h3>
                  <p className="mt-0.5 text-xs text-white/60">
                    ${(f.amount_cents / 100).toFixed(2)} — please settle when
                    you can. You can keep using SparkLine in the meantime.
                  </p>
                </div>
                <ChargePayButton chargeId={f.id} />
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-10 grid gap-5 md:grid-cols-2">
        {/* Application card */}
        <Card>
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-sm font-medium uppercase tracking-wider text-white/50">
                Application
              </h3>
              <p className="mt-2 text-2xl font-semibold">
                {app ? app.status[0].toUpperCase() + app.status.slice(1) : "Not started"}
              </p>
            </div>
            {app && <StatusBadge status={app.status} />}
          </div>
          <div className="mt-5">
            {!app && (
              <Link href="/apply">
                <Button>Start application</Button>
              </Link>
            )}
            {app?.status === "draft" && (
              <Link href="/apply">
                <Button>Continue application</Button>
              </Link>
            )}
            {app?.status === "submitted" && (
              <p className="text-sm text-white/60">
                We're reviewing your application. We'll email you when there's a
                decision.
              </p>
            )}
            {app?.status === "accepted" && (
              <Link href="/dashboard/application">
                <Button>Pay $97 to enroll</Button>
              </Link>
            )}
            {app?.status === "rejected" && (
              <p className="text-sm text-white/60">
                Thanks for applying. Unfortunately you weren't selected for this cohort. You're welcome to apply for the next one.
              </p>
            )}
            {(app?.status === "paid" || app?.status === "enrolled") && (
              <p className="text-sm text-emerald-300">
                You're enrolled. See you in the cohort!
              </p>
            )}
          </div>
        </Card>

        {/* Enrollment / Course card */}
        <Card>
          <h3 className="text-sm font-medium uppercase tracking-wider text-white/50">
            Course access
          </h3>
          {enrollment ? (
            <>
              <p className="mt-2 text-2xl font-semibold">
                {enrollment.cohort?.name ?? "Cohort"}
              </p>
              <p className="mt-1 text-sm text-white/50">
                {enrollment.cohort?.starts_on} → {enrollment.cohort?.ends_on}
              </p>
              <Link href="/dashboard/course" className="mt-5 inline-block">
                <Button>Open course</Button>
              </Link>
            </>
          ) : (
            <>
              <p className="mt-2 text-2xl font-semibold text-white/40">
                Locked
              </p>
              <p className="mt-1 text-sm text-white/50">
                Course content unlocks once you're enrolled.
              </p>
            </>
          )}
        </Card>
      </div>

      {profile?.referral_code && (
        <div className="mt-10">
          <ReferralCard
            code={profile.referral_code}
            siteUrl={env.siteUrl}
            referralCount={await countReferrals(profile.referral_code)}
          />
        </div>
      )}

      {certificate && (
        <Card className="mt-10 border-spark/30 bg-spark/5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wider text-spark">
                Certificate of completion
              </h3>
              <p className="mt-1 text-sm text-white/70">
                You graduated. Share it on LinkedIn or anywhere.
              </p>
            </div>
            <Link href={`/verify/${certificate.code}`}>
              <Button size="sm">View certificate →</Button>
            </Link>
          </div>
        </Card>
      )}

      <div className="mt-10">
        <h2 className="text-lg font-semibold">Quick links</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href="/dashboard/application">
            <Button variant="secondary" size="sm">View application</Button>
          </Link>
          <Link href="/dashboard/billing">
            <Button variant="secondary" size="sm">Billing</Button>
          </Link>
          <Link href="/dashboard/settings">
            <Button variant="secondary" size="sm">Settings</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

async function countReferrals(code: string): Promise<number> {
  try {
    const admin = createAdminClient();
    const { count } = await admin
      .from("applications")
      .select("id", { count: "exact", head: true })
      .eq("referral_code", code);
    return count ?? 0;
  } catch {
    return 0;
  }
}
