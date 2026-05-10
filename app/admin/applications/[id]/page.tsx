import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { ReviewActions } from "./review-actions";

export const metadata = { title: "Review application · Admin" };

export default async function AdminApplicationDetail({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();
  const { data: app } = await admin
    .from("applications")
    .select("*, cohort:cohorts(*), profile:profiles!applications_user_id_fkey(email, full_name)")
    .eq("id", params.id)
    .maybeSingle();

  if (!app) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/admin/applications" className="text-sm text-white/50 hover:text-white">
        ← All applications
      </Link>
      <div className="mt-3 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {app.full_name || "Unnamed applicant"}
          </h1>
          <p className="mt-1 text-sm text-white/50">{(app as any).profile?.email}</p>
        </div>
        <StatusBadge status={app.status} />
      </div>

      <Card className="mt-6">
        <div className="grid gap-3 text-sm">
          <Row label="Age" value={app.age?.toString()} />
          <Row label="Grade" value={app.grade} />
          <Row label="School" value={app.school} />
          <Row label="Location" value={[app.city, app.country].filter(Boolean).join(", ")} />
          <Row label="Parent email" value={app.parent_email} />
          <Row label="Hours/week" value={app.hours_per_week?.toString()} />
          <Row label="Heard about us" value={app.referral_source} />
          <Row label="Cohort" value={(app as any).cohort?.name} />
          <Row
            label="Submitted"
            value={app.submitted_at ? new Date(app.submitted_at).toLocaleString() : "—"}
          />
        </div>
      </Card>

      <Card className="mt-6">
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-white/50">
          Links
        </h3>
        <div className="space-y-2 text-sm">
          <LinkRow label="LinkedIn" value={app.linkedin_url} />
          <LinkRow label="Resume" value={app.resume_url} />
          <LinkRow label="Portfolio" value={app.portfolio_url} />
        </div>
      </Card>

      <Card className="mt-6">
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-white/50">
          Why SparkLine
        </h3>
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm text-white/80">
          {app.why_join || "—"}
        </p>
      </Card>

      <Card className="mt-6">
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-white/50">
          Startup idea
        </h3>
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm text-white/80">
          {app.startup_idea || "—"}
        </p>
      </Card>

      <Card className="mt-6">
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-white/50">
          Experience
        </h3>
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm text-white/80">
          {app.experience || "—"}
        </p>
      </Card>

      <Card className="mt-6">
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-white/50">
          Decision
        </h3>
        <ReviewActions
          applicationId={app.id}
          status={app.status}
          feeWaived={Boolean((app as any).fee_waived)}
          initialNotes={app.review_notes ?? ""}
        />
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex items-baseline justify-between border-b border-white/5 py-2 last:border-0">
      <div className="text-xs uppercase tracking-wider text-white/40">{label}</div>
      <div className="text-white/80">{value || <span className="text-white/30">—</span>}</div>
    </div>
  );
}

function LinkRow({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/5 py-2 last:border-0">
      <div className="text-xs uppercase tracking-wider text-white/40">
        {label}
      </div>
      {value ? (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 truncate text-spark hover:underline"
        >
          {value}
        </a>
      ) : (
        <span className="text-white/30">—</span>
      )}
    </div>
  );
}
