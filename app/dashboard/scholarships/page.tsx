import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, StatusBadge } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import {
  loadScholarshipCards,
  describeAward,
  formatMoney,
  type ScholarshipCard,
} from "@/lib/scholarships";
import {
  SCHOLARSHIP_KIND_LABELS,
  SCHOLARSHIP_KIND_BLURBS,
} from "@/lib/scholarship-award";
import { GraduationCap, Video, Coins } from "lucide-react";
import { WithdrawButton } from "./withdraw-button";

export const metadata = { title: "Scholarships · batch0" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The student's scholarship page.
 *
 * Deliberately reachable before enrolment — scholarships open at the ACCEPTED
 * stage, which is exactly the window where someone is deciding whether they
 * can afford the program at all. See the note beside this route in
 * lib/nav-config.ts ENROLLED_ONLY_HREFS.
 *
 * Reads through the service-role client rather than the session: the RLS read
 * policy on scholarship_applications would otherwise make "no award" and "RLS
 * said no" indistinguishable, and a student's own award silently rendering as
 * absent is the worst failure this page has. Every read below is explicitly
 * scoped to the signed-in user's id.
 */
export default async function ScholarshipsPage() {
  const user = await requireUser();
  const admin = createAdminClient();
  const { cards, missingTable } = await loadScholarshipCards(
    admin,
    user.id,
    new Date(),
  );

  const award = cards.find((c) => c.mine?.status === "awarded") ?? null;
  const open = cards.filter(
    (c) => c.eligibility.ok && !c.mine,
  );
  const mine = cards.filter((c) => c.mine && c.mine.status !== "withdrawn");
  const closed = cards.filter(
    (c) => !c.eligibility.ok && !c.mine && c.scholarship.enabled,
  );

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight text-ink">Scholarships</h1>
      <p className="mt-1 text-sm text-ink-soft">
        batch0 runs scholarships so money isn't what decides who gets to build.
        You can hold one at a time, and you can apply after you're accepted or
        after you've enrolled.
      </p>

      {missingTable && (
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            Scholarships aren't switched on yet. Check back shortly.
          </p>
        </Card>
      )}

      {award && award.mine && <AwardCard card={award} />}

      {mine.length > 0 && (
        <section className="mt-10">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.22em] text-ink-faint">
            Your applications
          </h2>
          <div className="mt-4 space-y-3">
            {mine.map((c) => (
              <MyApplicationRow key={c.scholarship.id} card={c} />
            ))}
          </div>
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.22em] text-ink-faint">
          {mine.length > 0 ? "Also open to you" : "Open to you"}
        </h2>
        {open.length === 0 ? (
          <Card className="mt-4">
            <p className="text-sm text-ink-soft">
              {award
                ? "You already hold a scholarship, so nothing else is open right now — students hold one at a time."
                : cards.length === 0
                  ? "No scholarships are running at the moment."
                  : "Nothing is open to you right now. The reasons are listed below."}
            </p>
          </Card>
        ) : (
          <div className="mt-4 space-y-3">
            {open.map((c) => (
              <OfferCard key={c.scholarship.id} card={c} />
            ))}
          </div>
        )}
      </section>

      {closed.length > 0 && (
        <section className="mt-10">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.22em] text-ink-faint">
            Not open to you right now
          </h2>
          <div className="mt-4 space-y-3">
            {closed.map((c) => (
              <Card key={c.scholarship.id} className="opacity-70">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-medium text-ink">{c.scholarship.name}</h3>
                  <span className="text-xs text-ink-faint">
                    {describeAward(c.scholarship.terms)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-ink-soft">
                  {!c.eligibility.ok ? c.eligibility.message : null}
                </p>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function KindIcon({ kind }: { kind: string }) {
  const Icon = kind === "learner" ? Video : kind === "merit" ? GraduationCap : Coins;
  return <Icon className="h-4 w-4 text-phosphor-ink" aria-hidden />;
}

/** The headline block for a student who actually holds an award. */
function AwardCard({ card }: { card: ScholarshipCard }) {
  const { scholarship, mine } = card;
  if (!mine) return null;
  const isCalls = scholarship.terms.awardType === "mentor_calls";

  return (
    <Card className="mt-8 border-phosphor/40 bg-phosphor/5">
      <div className="flex flex-wrap items-center gap-2">
        <KindIcon kind={scholarship.kind} />
        <h2 className="text-lg font-semibold text-phosphor-ink">
          You hold the {scholarship.name}
        </h2>
      </div>

      {isCalls ? (
        <>
          <p className="mt-2 text-sm text-ink-soft">
            <strong className="text-ink">
              {mine.credits.remaining} of {mine.credits.granted}
            </strong>{" "}
            extra mentor {mine.credits.granted === 1 ? "call" : "calls"} left to
            book. They don't expire during the cohort — but they also don't do
            anything sitting unused.
          </p>
          <div className="mt-4">
            <ButtonLink href="/dashboard/calls">
              {mine.credits.remaining > 0 ? "Book a call" : "See your calls"}
            </ButtonLink>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm text-ink-soft">
            {mine.fulfillment === "refunded" ? (
              <>
                <strong className="text-ink">
                  {formatMoney(mine.refundedCents)}
                </strong>{" "}
                was refunded to the card you paid with. Your enrollment is
                unchanged.
              </>
            ) : mine.fulfillment === "refund_due" ? (
              <>
                <strong className="text-ink">
                  {formatMoney(mine.awardCents)}
                </strong>{" "}
                is coming back to the card you paid with. We'll email you the
                moment it's on its way.
              </>
            ) : (
              <>
                <strong className="text-ink">
                  {formatMoney(mine.awardCents)}
                </strong>{" "}
                off your tuition. There's nothing to enter — the lower price is
                already applied when you go to pay.
              </>
            )}
          </p>
          {mine.fulfillment !== "none" && mine.fulfillment !== "discount" && (
            <div className="mt-4">
              <ButtonLink href="/dashboard/billing" variant="secondary">
                See your billing
              </ButtonLink>
            </div>
          )}
        </>
      )}

      {mine.decisionNote && (
        <p className="mt-4 border-l-2 border-phosphor/40 pl-3 text-sm italic text-ink-soft">
          {mine.decisionNote}
        </p>
      )}
    </Card>
  );
}

function MyApplicationRow({ card }: { card: ScholarshipCard }) {
  const { scholarship, mine } = card;
  if (!mine) return null;
  const pending = mine.status === "submitted" || mine.status === "under_review";

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <KindIcon kind={scholarship.kind} />
            <h3 className="font-medium text-ink">{scholarship.name}</h3>
          </div>
          <p className="mt-1 text-sm text-ink-soft">
            {describeAward(scholarship.terms)}
            {mine.submittedAt && (
              <>
                {" · applied "}
                <LocalTime value={mine.submittedAt} />
              </>
            )}
          </p>
          {mine.status === "declined" && mine.decisionNote && (
            <p className="mt-2 border-l-2 border-line pl-3 text-sm italic text-ink-soft">
              {mine.decisionNote}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge status={mine.status} />
          {mine.status === "draft" && (
            <ButtonLink
              size="sm"
              href={`/dashboard/scholarships/${scholarship.slug}`}
            >
              Finish it
            </ButtonLink>
          )}
          {pending && <WithdrawButton applicationId={mine.id} />}
        </div>
      </div>

      {mine.status === "declined" && (
        <p className="mt-3 text-xs text-ink-faint">
          This doesn't change your place at batch0. If cost is what's standing
          between you and the program,{" "}
          <Link href="/dashboard/discussions" className="underline">
            tell the team
          </Link>{" "}
          — we'd rather hear it.
        </p>
      )}
    </Card>
  );
}

function OfferCard({ card }: { card: ScholarshipCard }) {
  const { scholarship, awardedCount } = card;
  const seatsLeft =
    scholarship.seats === null ? null : Math.max(0, scholarship.seats - awardedCount);

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <KindIcon kind={scholarship.kind} />
            <h3 className="font-medium text-ink">{scholarship.name}</h3>
            <span className="rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
              {SCHOLARSHIP_KIND_LABELS[scholarship.kind]}
            </span>
          </div>
          <p className="mt-1 text-sm text-ink-soft">
            {scholarship.tagline || SCHOLARSHIP_KIND_BLURBS[scholarship.kind]}
          </p>
          <p className="mt-2 text-sm font-medium text-phosphor-ink">
            {describeAward(scholarship.terms)}
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            {seatsLeft !== null && (
              <>
                {seatsLeft} {seatsLeft === 1 ? "spot" : "spots"} left
                {scholarship.closesAt ? " · " : ""}
              </>
            )}
            {scholarship.closesAt && (
              <>
                closes <LocalTime value={scholarship.closesAt} />
              </>
            )}
          </p>
        </div>
        <ButtonLink
          size="sm"
          href={`/dashboard/scholarships/${scholarship.slug}`}
          className="shrink-0"
        >
          Apply
        </ButtonLink>
      </div>
    </Card>
  );
}
