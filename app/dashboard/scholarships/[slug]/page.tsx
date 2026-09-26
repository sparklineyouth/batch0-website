import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";
import {
  getScholarshipBySlug,
  eligibilityForScholarship,
  describeAward,
} from "@/lib/scholarships";
import { SCHOLARSHIP_KIND_LABELS } from "@/lib/scholarship-award";
import { windowHeadline } from "@/lib/scholarship-window";
import { visibleQuestions } from "@/lib/question-schema";
import { ScholarshipApplyForm } from "./apply-form";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const scholarship = await getScholarshipBySlug(createAdminClient(), slug);
  return { title: `${scholarship?.name ?? "Scholarship"} · batch0` };
}

export default async function ScholarshipApplyPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const user = await requireUser();
  const admin = createAdminClient();

  const scholarship = await getScholarshipBySlug(admin, slug);
  if (!scholarship) notFound();

  // The same read-and-decide saveScholarshipApplication makes, so the page
  // and the action agree about whether the form should be usable — including
  // the student's cohort window, which is what decides "open until".
  const { eligibility, existing: mine, blocking } = await eligibilityForScholarship(
    admin,
    user.id,
    scholarship,
    new Date(),
  );

  // Already submitted, or already decided: there's nothing to fill in, so send
  // them to the overview where their status actually lives.
  if (blocking) redirect("/dashboard/scholarships");

  const questions = visibleQuestions(scholarship.questions);

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href="/dashboard/scholarships"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← All scholarships
      </Link>

      <div className="mt-4 border-b border-line pb-6">
        <span className="rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
          {SCHOLARSHIP_KIND_LABELS[scholarship.kind]}
        </span>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-ink">
          {scholarship.name}
        </h1>
        <p className="mt-2 text-lg font-medium text-phosphor-ink">
          {describeAward(scholarship.terms)}
        </p>
        {scholarship.description && (
          <p className="mt-4 whitespace-pre-wrap text-[15px] leading-relaxed text-ink-soft">
            {scholarship.description}
          </p>
        )}
        {eligibility.ok && (
          <p className="mt-4 text-xs text-ink-faint">
            {windowHeadline(eligibility.window)}.
          </p>
        )}
      </div>

      {!eligibility.ok ? (
        <Card className="mt-8">
          <h2 className="font-medium text-ink">You can't apply to this one</h2>
          <p className="mt-1 text-sm text-ink-soft">{eligibility.message}</p>
          <div className="mt-4">
            <ButtonLink href="/dashboard/scholarships" variant="secondary">
              See what is open
            </ButtonLink>
          </div>
        </Card>
      ) : (
        <div className="mt-8">
          <ScholarshipApplyForm
            slug={scholarship.slug}
            questions={questions}
            saved={mine?.answers ?? null}
            awardSummary={describeAward(scholarship.terms)}
          />
        </div>
      )}
    </div>
  );
}
