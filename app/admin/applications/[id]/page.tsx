import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { ReviewActions } from "./review-actions";
import { AiScreenButton } from "./ai-screen-button";
import { ReviewThread } from "./review-thread";
import { ReviewScorecard } from "./review-scorecard";
import { getSiteConfig } from "@/lib/site-config";
import { requireAdmin } from "@/lib/auth";

export const metadata = { title: "Review application · Admin" };

export default async function AdminApplicationDetail({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();
  const viewer = await requireAdmin();
  const [{ data: app }, { data: comments }, siteConfig, { data: reviews }] =
    await Promise.all([
      admin
        .from("applications")
        .select(
          "*, cohort:cohorts(*), profile:profiles!applications_user_id_fkey(email, full_name)",
        )
        .eq("id", params.id)
        .maybeSingle(),
      admin
        .from("application_review_comments")
        .select(
          "id, body, created_at, author_id, author:profiles!application_review_comments_author_id_fkey(email, full_name)",
        )
        .eq("application_id", params.id)
        .order("created_at", { ascending: true }),
      getSiteConfig(),
      admin
        .from("application_reviews")
        .select(
          "reviewer_id, idea, founder, motivation, feasibility, fit, decision, notes, submitted_at, reviewer:profiles(full_name, email)",
        )
        .eq("application_id", params.id),
    ]);

  if (!app) notFound();

  const myReview =
    (reviews ?? []).find((r: any) => r.reviewer_id === viewer.id) ?? null;
  const otherSubmitted = (reviews ?? []).filter(
    (r: any) => r.reviewer_id !== viewer.id && r.submitted_at,
  );

  // Duplicate detection: bigram-level overlap on startup_idea. We
  // match on any of the top distinctive 3-grams. The gin_trgm index
  // on applications.startup_idea (migration 0032) makes this cheap.
  let duplicates: { id: string; full_name: string | null; startup_idea: string | null; status: string }[] = [];
  if (app.startup_idea) {
    const tokens: string[] = (app.startup_idea as string)
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter((w: string) => w.length >= 4 && !STOP_WORDS.has(w))
      .slice(0, 6);
    if (tokens.length > 0) {
      const orFilters = tokens.map((t: string) => `startup_idea.ilike.%${t}%`).join(",");
      const { data } = await admin
        .from("applications")
        .select("id, full_name, startup_idea, status")
        .neq("id", app.id)
        .or(orFilters)
        .limit(20);
      const seenWords = new Set<string>(tokens);
      duplicates = (data ?? [])
        .map((row: any) => ({
          ...row,
          overlap: countOverlap(row.startup_idea ?? "", seenWords),
        }))
        .filter((row: any) => row.overlap >= 2)
        .sort((a: any, b: any) => b.overlap - a.overlap)
        .slice(0, 4);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/admin/applications" className="text-sm text-ink-faint hover:text-ink">
        ← All applications
      </Link>
      <div className="mt-3 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            {app.full_name || "Unnamed applicant"}
          </h1>
          <p className="mt-1 text-sm text-ink-faint">{(app as any).profile?.email}</p>
        </div>
        <StatusBadge status={app.status} />
      </div>

      <Card className="mt-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-ink-faint">
              AI pre-score
            </h3>
            {(app as any).ai_score != null ? (
              <div className="mt-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-bold tracking-tight tabular-nums text-phosphor-ink">
                    {(app as any).ai_score}
                  </span>
                  <span className="text-xs text-ink-faint">/ 10</span>
                </div>
                {(app as any).ai_summary && (
                  <p className="mt-2 text-sm text-ink-soft">
                    {(app as any).ai_summary}
                  </p>
                )}
                <p className="mt-2 text-[11px] text-ink-faint">
                  Scored{" "}
                  <LocalTime value={(app as any).ai_reviewed_at} fallback="" />{" "}
                  · advisory only
                </p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-ink-faint">
                Not yet screened.
              </p>
            )}
          </div>
          <AiScreenButton
            applicationId={app.id}
            alreadyScored={(app as any).ai_score != null}
          />
        </div>
      </Card>

      <Card className="mt-6">
        <div className="grid gap-3 text-sm">
          <Row label="Age" value={app.age?.toString()} />
          <Row label="Grade" value={app.grade} />
          <Row label="School" value={app.school} />
          <Row label="Location" value={[app.city, app.country].filter(Boolean).join(", ")} />
          <Row label="Parent email" value={app.parent_email} />
          <Row label="Hours/week" value={app.hours_per_week?.toString()} />
          <Row label="Team size" value={teamSizeAdminLabel(app.team_size)} />
          <Row label="Heard about us" value={app.referral_source} />
          <Row
            label="Referred by (code)"
            value={
              app.referral_code ? (
                <span className="font-mono text-xs">{app.referral_code}</span>
              ) : undefined
            }
          />
          <Row label="Cohort" value={(app as any).cohort?.name} />
          <Row
            label="Submitted"
            value={app.submitted_at ? <LocalTime value={app.submitted_at} /> : "—"}
          />
        </div>
      </Card>

      <Card className="mt-6">
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-ink-faint">
          Links
        </h3>
        <div className="space-y-2 text-sm">
          <LinkRow label="LinkedIn" value={app.linkedin_url} />
          <LinkRow label="Resume" value={app.resume_url} />
          <LinkRow label="Portfolio" value={app.portfolio_url} />
        </div>
      </Card>

      <Card className="mt-6">
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-ink-faint">
          Why batch0
        </h3>
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm text-ink-soft">
          {app.why_join || "—"}
        </p>
      </Card>

      <Card className="mt-6">
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-ink-faint">
          Startup idea
        </h3>
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm text-ink-soft">
          {app.startup_idea || "—"}
        </p>
      </Card>

      <Card className="mt-6">
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-ink-faint">
          Experience
        </h3>
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm text-ink-soft">
          {app.experience || "—"}
        </p>
      </Card>

      <Card className="mt-6">
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-ink-faint">
          Decision
        </h3>
        <ReviewActions
          applicationId={app.id}
          status={app.status}
          feeWaived={Boolean((app as any).fee_waived)}
          initialNotes={app.review_notes ?? ""}
          priceLabel={siteConfig.derived.priceLabel}
        />
      </Card>

      <Card className="mt-6">
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-ink-faint">
          Your scorecard
        </h3>
        <p className="text-xs text-ink-faint">
          Submit a recommendation when you're done. Other reviewers' scores
          are hidden until you submit yours.
        </p>
        <div className="mt-4">
          <ReviewScorecard
            applicationId={app.id}
            existing={
              myReview
                ? {
                    idea: (myReview as any).idea,
                    founder: (myReview as any).founder,
                    motivation: (myReview as any).motivation,
                    feasibility: (myReview as any).feasibility,
                    fit: (myReview as any).fit,
                    decision: (myReview as any).decision,
                    notes: (myReview as any).notes ?? "",
                  }
                : null
            }
          />
        </div>
        {myReview && (myReview as any).submitted_at && otherSubmitted.length > 0 && (
          <div className="mt-6 border-t border-line pt-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
              Other reviewers ({otherSubmitted.length})
            </p>
            <ul className="mt-2 space-y-3 text-xs">
              {otherSubmitted.map((r: any) => {
                const reviewer = Array.isArray(r.reviewer)
                  ? r.reviewer[0]
                  : r.reviewer;
                return (
                  <li
                    key={r.reviewer_id}
                    className="rounded-lg border border-line bg-wash p-3"
                  >
                    <div className="flex items-baseline justify-between">
                      <span className="font-semibold text-ink">
                        {reviewer?.full_name ?? reviewer?.email ?? "Reviewer"}
                      </span>
                      <span className="text-phosphor-ink">
                        {(r.decision ?? "").replace("_", " ")}
                      </span>
                    </div>
                    <div className="mt-1 text-ink-soft">
                      Idea {r.idea ?? "—"} · Founder {r.founder ?? "—"} ·
                      Motivation {r.motivation ?? "—"} · Feasibility{" "}
                      {r.feasibility ?? "—"} · Fit {r.fit ?? "—"}
                    </div>
                    {r.notes && (
                      <p className="mt-2 whitespace-pre-wrap text-ink-soft">
                        {r.notes}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Card>

      {duplicates.length > 0 && (
        <Card className="mt-6">
          <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300">
            Possible duplicate ideas
          </h3>
          <p className="text-xs text-ink-faint">
            Heuristic word-overlap on the startup idea text. Useful for
            spotting copy-paste and coordinated applications.
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {duplicates.map((d) => (
              <li
                key={d.id}
                className="rounded-lg border border-line bg-wash p-3"
              >
                <Link
                  href={`/admin/applications/${d.id}`}
                  className="text-phosphor-ink hover:underline"
                >
                  {d.full_name ?? "Applicant"} · {d.status}
                </Link>
                <p className="mt-1 line-clamp-2 text-xs text-ink-soft">
                  {d.startup_idea ?? ""}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mt-6">
        <ReviewThread
          applicationId={app.id}
          currentUserId={viewer.id}
          comments={(comments ?? []).map((c: any) => ({
            id: c.id,
            body: c.body,
            created_at: c.created_at,
            author_id: c.author_id,
            author: Array.isArray(c.author) ? c.author[0] ?? null : c.author,
          }))}
        />
      </Card>
    </div>
  );
}

const STOP_WORDS = new Set([
  "that",
  "this",
  "with",
  "from",
  "have",
  "they",
  "their",
  "would",
  "could",
  "about",
  "would",
  "where",
  "which",
  "while",
  "into",
  "your",
  "youre",
  "build",
  "building",
  "make",
  "thing",
  "people",
  "want",
  "wants",
  "going",
  "really",
]);

function countOverlap(text: string, tokens: Set<string>): number {
  const lc = text.toLowerCase();
  let hits = 0;
  for (const t of tokens) {
    if (lc.includes(t)) hits += 1;
  }
  return hits;
}

function teamSizeAdminLabel(value: number | null | undefined): string {
  if (value == null) return "";
  if (value === 1) return "Solo";
  if (value === 2) return "2 (with co-founder)";
  if (value >= 5) return "5+";
  return String(value);
}

function Row({
  label,
  value,
}: {
  label: string;
  value?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between border-b border-line py-2 last:border-0">
      <div className="text-xs uppercase tracking-wider text-ink-faint">{label}</div>
      <div className="text-ink-soft">{value || <span className="text-ink-faint">—</span>}</div>
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
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-2 last:border-0">
      <div className="text-xs uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      {value ? (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 truncate text-phosphor-ink hover:underline"
        >
          {value}
        </a>
      ) : (
        <span className="text-ink-faint">—</span>
      )}
    </div>
  );
}
