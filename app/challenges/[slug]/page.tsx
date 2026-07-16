import Link from "next/link";
import { notFound } from "next/navigation";
import { getUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getChallengeBySlug, isChallengeOpen, formatCents } from "@/lib/challenges";
import { LocalTime } from "@/components/ui/local-time";
import { ChallengeForm } from "./challenge-form";

export const metadata = {
  title: "Weekly Challenge · batch0",
  // Public to humans (top-of-funnel), but the marketing marquee and the
  // /challenges index carry the SEO — keep individual entries unindexed.
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ChallengePage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams: { ref?: string };
}) {
  // The challenge itself is public — this is a top-of-funnel page, so a
  // logged-out visitor must be able to read the whole thing. Only the
  // entry form needs an account; they get a sign-in CTA in its place.
  const user = await getUser();

  const challenge = await getChallengeBySlug(params.slug);
  if (!challenge) notFound();

  let existing: { id: string; status: string } | null = null;
  if (user) {
    const admin = createAdminClient();
    const { data } = await admin
      .from("challenge_submissions")
      .select("id, status")
      .eq("challenge_id", challenge.id)
      .eq("user_id", user.id)
      .maybeSingle();
    existing = (data as any) ?? null;
  }

  const open = isChallengeOpen(challenge);

  return (
    <div className="min-h-screen bg-paper">
      <div className="relative mx-auto max-w-3xl px-5 sm:px-6 py-10 sm:py-16">
        <Link href="/challenges" className="text-sm text-ink-soft hover:text-ink">
          ← All challenges
        </Link>

        <p className="mt-6 font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-phosphor-ink">
          Weekly Challenge
        </p>
        <h1 className="mt-3 font-display text-[30px] sm:text-4xl font-bold leading-[1.1] tracking-[-0.02em] text-ink">
          {challenge.title}
        </h1>
        {challenge.description && (
          <p className="mt-4 max-w-2xl whitespace-pre-line text-[15px] sm:text-base leading-[1.6] text-ink-soft">
            {challenge.description}
          </p>
        )}

        {(challenge.prizeLabel || challenge.closesAt) && (
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 border-y border-line py-3 font-mono text-[13px]">
            {challenge.prizeLabel && (
              <span className="text-ink">
                <span className="text-ink-faint">Prize · </span>
                {challenge.prizeLabel}
              </span>
            )}
            {challenge.closesAt && (
              <span className="text-ink">
                <span className="text-ink-faint">Closes · </span>
                <LocalTime value={challenge.closesAt} mode="datetime-short" />
              </span>
            )}
          </div>
        )}

        <div className="mt-10">
          {existing ? (
            <AlreadyApplied />
          ) : !open ? (
            <ClosedPanel closesAt={challenge.closesAt} />
          ) : !user ? (
            <SignInPanel slug={params.slug} refCode={searchParams.ref ?? null} />
          ) : (
            <ChallengeForm
              challenge={{
                id: challenge.id,
                slug: challenge.slug,
                title: challenge.title,
                questions: challenge.questions,
              }}
              refCode={searchParams.ref ?? null}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SignInPanel({
  slug,
  refCode,
}: {
  slug: string;
  refCode: string | null;
}) {
  const next = `/challenges/${slug}${refCode ? `?ref=${encodeURIComponent(refCode)}` : ""}`;
  return (
    <div className="rounded-2xl border border-phosphor/30 bg-phosphor/5 p-6">
      <h2 className="font-display text-xl font-bold tracking-[-0.02em] text-ink">
        Ready to enter?
      </h2>
      <p className="mt-2 text-sm text-ink-soft">
        Entering takes a free account so we can review your submission and
        reach you if you win. Sign in or create one — you'll land right back
        on this page.
      </p>
      <div className="mt-4">
        <Link
          href={`/login?next=${encodeURIComponent(next)}`}
          className="press inline-flex items-center justify-center rounded-md bg-phosphor px-5 py-3 text-[15px] font-semibold text-on-phosphor shadow-cta hover:bg-phosphor-200"
        >
          Sign in to enter — it's free
        </Link>
      </div>
    </div>
  );
}

function AlreadyApplied() {
  return (
    <div className="rounded-2xl border border-phosphor/30 bg-phosphor/5 p-6">
      <h2 className="font-display text-xl font-bold tracking-[-0.02em] text-ink">
        You&apos;ve already applied
      </h2>
      <p className="mt-2 text-sm text-ink-soft">
        We&apos;ve got your entry for this challenge. We review funding weekly
        and will email you.
      </p>
      <div className="mt-4">
        <Link
          href="/dashboard"
          className="text-sm text-phosphor-ink hover:underline"
        >
          Go to dashboard →
        </Link>
      </div>
    </div>
  );
}

function ClosedPanel({ closesAt }: { closesAt: string | null }) {
  return (
    <div className="rounded-2xl border border-amber-400/40 bg-wash p-6">
      <h2 className="font-display text-xl font-bold tracking-[-0.02em] text-ink">
        This challenge is closed
      </h2>
      <p className="mt-2 text-sm text-ink-soft">
        {closesAt
          ? "Applications for this one have wrapped up."
          : "This challenge isn't open for applications right now."}{" "}
        Keep an eye on the homepage — a new challenge drops most weeks.
      </p>
      <div className="mt-4">
        <Link href="/challenges" className="text-sm text-phosphor-ink hover:underline">
          See other challenges →
        </Link>
      </div>
    </div>
  );
}
