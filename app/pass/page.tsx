import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPassForUser } from "@/lib/founder-pass";
import {
  getFeedbackRequestForUser,
  feedbackCreditBalance,
} from "@/lib/founder-pass-perks";
import {
  DEFAULT_TIER,
  discountLabel,
  formatCents,
  grantPerkLines,
} from "@/lib/founder-pass-tiers";
import { formatSerial } from "@/lib/founder-pass-code";
import { getSiteConfig } from "@/lib/site-config";
import { PassForm } from "./pass-form";
import { FounderPassTicket } from "./founder-pass-ticket";
import { ProfileEditor } from "./profile-editor";
import { FeedbackCredit } from "./feedback-credit";
import {
  Zap,
  MessageSquare,
  BadgeCheck,
  Clock,
  Users,
  Globe,
  Banknote,
  PenLine,
  Hammer,
  Wrench,
  MessagesSquare,
  ArrowRight,
  Sparkles,
} from "lucide-react";

export const metadata: Metadata = {
  title: "Founder Pass — batch0",
  description:
    "Your Founder Pass unlocks more than a discount: a priority review lane, real feedback, a feedback credit, the Founder Toolkit, a public profile, and a numbered card that stays yours.",
};

// Reads per-user state (their pass) — never cache this at the edge.
export const dynamic = "force-dynamic";

type Perk = {
  key: string;
  icon: typeof Zap;
  title: string;
  body: string;
};

// Only list perks the product actually delivers. The referral card next door
// (app/dashboard/referral-card.tsx) is a standing reminder of the cost of doing
// otherwise: it promised "a credit toward a 1:1 mentor session" that had no
// schema, no mentors, and no chance of being honoured. Every line below is
// backed by code — migration 0039/0040 for the card itself, 0041 for the
// profile, feedback credit, rebuild, and structured feedback.
//
// Deliberately absent: build clinics and guest invitations. Those are real
// intentions but pure scheduling/ops with nothing to back them yet — so they
// don't appear here until they do.
//
// Also deliberately absent: AUTO-ADMIT. It is real and it is enforced
// (lib/admissions.ts), but only for a VIRTUAL pass — one issued by name to a
// person an admin already decided on. This list is what a stranger holding a
// printed card is promised, and a card that admitted whoever picked it up
// would be an admissions hole, not a perk. Virtual holders see the line via
// grantPerkLines() in the block under their ticket, which reads the pass's
// actual kind.
const PERKS: Perk[] = [
  {
    key: "discount",
    icon: Banknote,
    // Read off DEFAULT_TIER rather than typed out. This list is what someone
    // holding a PRINTED card is promised, and a printed card is always
    // standard — so changing the standard tier's discount has to move this
    // number with it. The two drifting is how a public page ends up
    // advertising a deal checkout doesn't give.
    title: `${discountLabel(DEFAULT_TIER)}`,
    body: `If you're accepted, your enrollment fee drops ${formatCents(
      DEFAULT_TIER.tuitionDiscount === "full" ? 0 : DEFAULT_TIER.tuitionDiscount,
    )} at checkout — automatically, in any region. Tuition is still only charged if you get in.`,
  },
  {
    key: "priority",
    icon: Zap,
    title: "A priority review lane",
    body: `Your application is badged and sorted to the top of the queue, and we aim to get you a decision within ${DEFAULT_TIER.decisionTargetDays} business days of a complete application. Priority means read first — the bar to get in is the same for everyone.`,
  },
  {
    key: "feedback_on_no",
    icon: PenLine,
    title: "A real answer if it's a no",
    body: "A pass application can't be declined with a form letter. Your feedback names what was strongest, what was missing, the most useful next step, and whether you're eligible for another look — in your dashboard and by email.",
  },
  {
    key: "rebuild",
    icon: Hammer,
    title: "One chance to build your way back in",
    body: "Declined but still eligible before the deadline? Complete the seven-day build — validate the problem, talk to users, ship something small — and your updated application gets one fresh human review.",
  },
  {
    key: "feedback_credit",
    icon: MessageSquare,
    title: "One human feedback credit",
    body: "Redeem one credit for focused feedback on your application, idea, customer-interview plan, landing page, MVP, or pitch deck — delivered on your dashboard or at a live clinic.",
  },
  {
    key: "toolkit",
    icon: Wrench,
    title: "The Founder Toolkit",
    body: "Validation worksheets, interview scripts, a lean canvas, MVP planning, landing-page and pitch-deck templates, and a seven-day launch plan. Yours to use even if you don't join this cohort.",
  },
  {
    key: "profile",
    icon: Globe,
    title: "A public founder profile",
    body: "Your pass gets its own page you control — project, bio, website, demo, shipped milestones. Publish it or keep it private; the card code and serial are always on the ticket.",
  },
  {
    key: "discord",
    icon: MessagesSquare,
    title: "A founder role in Discord",
    body: "Link your account and the Founder Pass role lands automatically. Link it later and it still lands.",
  },
  {
    key: "badge",
    icon: Users,
    title: "The badge on the site",
    body: "On batch0 itself — team pages, team threads — a Founder Pass badge sits next to your name, where mentors and investors are looking.",
  },
  {
    key: "numbered",
    icon: BadgeCheck,
    title: "A numbered pass, for good",
    body: "Your serial is embossed on the card, bound to your account, and doesn't expire — it carries to every future cohort. The tuition discount redeems once, on the cohort you get into.",
  },
  {
    key: "early_access",
    icon: Clock,
    title: "Apply before applications open",
    body: "When a cohort isn't public yet, your pass gets you in early.",
  },
];

export default async function PassPage({
  searchParams,
}: {
  searchParams: { code?: string };
}) {
  // Whether this visit came from a virtual pass's "Redeem your pass" link.
  // Only the PRESENCE of the parameter is read here — the value is never
  // looked up server-side, because a page that resolved a code before anyone
  // was signed in would be a free oracle for testing guesses, outside the
  // rate limiter that guards the real redemption path.
  //
  // Covers the direct-from-email case, which is the overwhelmingly common one.
  // Someone bouncing back through signup returns to a bare /pass and lands on
  // the generic heading; the golden card and its own copy carry that case,
  // since only the client can see the stashed code.
  const arrivingWithCode = typeof searchParams?.code === "string" && searchParams.code.length > 0;
  const supabase = createClient();
  // Site config depends on nothing per-user, so it starts before the auth
  // round trip and lands in the same wave as the pass read.
  const configPromise = getSiteConfig();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The pass read goes through the service-role client. founder_passes does
  // have a self-select RLS policy, but the anon client would return null
  // indistinguishably for "no pass" and "policy blocked it" — reading as admin
  // and filtering by user id keeps that ambiguity out of the UI.
  const admin = createAdminClient();
  const [pass, config] = await Promise.all([
    user ? getPassForUser(admin, user.id) : null,
    configPromise,
  ]);
  const earlyAccess = config.settings.founderPassEarlyAccess;

  // The ticket prints the holder's name like a boarding pass. profiles has a
  // self-select policy, so the user's own client can read it.
  let holderName: string | null = null;
  let feedbackRequest = null;
  let credits: { total: number; spent: number; remaining: number } | null = null;
  if (user && pass) {
    const [{ data: profile }, request, balance] = await Promise.all([
      supabase
        .from("profiles")
        .select("full_name")
        .eq("id", user.id)
        .maybeSingle(),
      getFeedbackRequestForUser(admin, user.id),
      // A tier can carry more than one credit (migration 0055), so the card
      // below shows a number going down rather than the flat "one credit" the
      // copy used to assume.
      feedbackCreditBalance(admin, user.id),
    ]);
    holderName =
      (profile as { full_name: string | null } | null)?.full_name ?? null;
    feedbackRequest = request;
    credits = balance;
  }

  // Holders have dedicated tool sections for these three perks below, so the
  // summary list drops them to avoid saying the same thing twice. Non-holders
  // see the full list — it's the whole value proposition.
  const sectionedKeys = new Set(["profile", "toolkit", "feedback_credit"]);

  // Perks whose wording depends on the holder's tier (migration 0055). For a
  // holder these are printed from tierPerkLines() in the block under the
  // ticket instead, because the generic copy is written for a standard pass —
  // telling a full-ride holder "$30 off tuition" would contradict the email
  // that gave them the pass. Non-holders still see the standard text, which is
  // exactly right: a printed card IS standard.
  const tierVaryingKeys = new Set(["discount", "priority", "early_access"]);
  const perksToList = PERKS.filter((perk) => {
    // The early-access perk is the one thing an admin can switch off (site
    // setting `founder_pass_early_access`), because the global applications
    // gate can't tell "not open yet" from "closed for good". Don't advertise
    // it while it's off — that's how the referral card ended up lying.
    if (perk.key === "early_access" && !earlyAccess) return false;
    if (pass && sectionedKeys.has(perk.key)) return false;
    if (pass && tierVaryingKeys.has(perk.key)) return false;
    return true;
  });

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-lg px-5 py-16 md:py-24">
      <div className="text-center">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-phosphor-ink">
          Founder Pass
        </p>
        <h1 className="mt-3 font-display text-4xl leading-none text-ink md:text-5xl">
          {pass
            ? "Your pass is active"
            : arrivingWithCode
              ? "Someone sent you a pass"
              : "Unlock your card"}
        </h1>
        <p className="mx-auto mt-4 max-w-md text-sm text-ink-soft">
          {pass
            ? "Permanently tied to your account. Real tools, feedback, and opportunities to build — whether or not you get into this cohort."
            : arrivingWithCode
              ? "Your code is already filled in — there's nothing to type. Claiming it ties the pass to your account for good."
              : "Type the code on the back of your batch0 card to bind it to your account."}
        </p>
      </div>

      {pass ? (
        // Breaks out of the column a little at sm+ — a ticket wants to be
        // wider than a form.
        <>
          <FounderPassTicket
            className="mt-8 sm:-mx-8"
            name={holderName}
            serialLabel={formatSerial(pass.serial)}
            code={pass.redeemedCode}
            batch={pass.batch}
            cohortHeadline={config.derived.cohortHeadline}
            redeemedAt={pass.redeemedAt}
          />

          {/* What THIS pass carries, printed from the same tierPerkLines() the
              invite email used. One source, so the promise someone read in
              their inbox and the promise on this page cannot drift apart. */}
          <Card className="mt-8">
            <div className="flex items-start gap-3">
              <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-phosphor-ink" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">
                  What your pass carries
                  {pass.grant.tier.key !== DEFAULT_TIER.key && (
                    <span className="ml-2 rounded-md border border-phosphor/40 bg-phosphor/[0.08] px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-phosphor-ink">
                      {pass.grant.tier.label}
                    </span>
                  )}
                </p>
                <ul className="mt-2 space-y-1.5">
                  {grantPerkLines(pass.grant).map((line) => (
                    <li key={line} className="flex gap-2 text-sm text-ink-soft">
                      <span className="text-phosphor-ink">&bull;</span>
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Card>

          {/* The interactive tools — the perks a holder acts on right here. */}
          <div className="mt-4 space-y-4">
            <ToolCard
              icon={Globe}
              title="Your public profile"
              subtitle="Show your project, or keep it private. You control what appears."
            >
              <ProfileEditor serial={pass.serial} initial={pass.profile} />
            </ToolCard>

            <ToolCard
              icon={Wrench}
              title="Founder Toolkit"
              subtitle="The worksheets, scripts, and templates we hand our founders."
            >
              <Link
                href="/pass/toolkit"
                className="press inline-flex items-center gap-1.5 rounded-md border border-line bg-paper px-3 py-2 text-sm font-medium text-ink-soft hover:border-ink/30 hover:text-ink"
              >
                Open the toolkit
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </ToolCard>

            <ToolCard
              icon={MessageSquare}
              title={
                credits && credits.total > 1 ? "Feedback credits" : "Feedback credit"
              }
              subtitle={
                credits
                  ? credits.remaining > 0
                    ? `${credits.remaining} of ${credits.total} left — a focused, human review of the thing you're stuck on. One at a time.`
                    : `All ${credits.total} used. A focused, human review of the thing you're stuck on.`
                  : "One focused, human review of the thing you're stuck on."
              }
            >
              <FeedbackCredit request={feedbackRequest} />
            </ToolCard>
          </div>
        </>
      ) : arrivingWithCode ? (
        // No Card wrapper: the golden card IS the surface here, and framing an
        // object inside a panel makes it read as a form field again.
        <div className="mt-8">
          <PassForm signedIn={!!user} />
        </div>
      ) : (
        <Card className="mt-8">
          <PassForm signedIn={!!user} />
        </Card>
      )}

      <h2 className="mt-12 text-center text-[11px] font-medium uppercase tracking-[0.22em] text-ink-faint">
        {pass ? "Everything your pass carries" : "What your pass unlocks"}
      </h2>
      <ul className="mt-6 space-y-5">
        {perksToList.map((perk) => (
          <li key={perk.key} className="flex gap-4">
            <perk.icon className="mt-0.5 h-5 w-5 shrink-0 text-phosphor-ink" />
            <div>
              <p className="text-sm font-semibold text-ink">{perk.title}</p>
              <p className="mt-1 text-sm text-ink-soft">{perk.body}</p>
            </div>
          </li>
        ))}
      </ul>

      {pass && (
        <div className="mt-10 text-center">
          <Link
            href="/apply"
            className="text-sm font-semibold text-phosphor-ink underline underline-offset-4"
          >
            Start your application →
          </Link>
        </div>
      )}

      <p className="mt-10 text-center text-xs text-ink-faint">
        Lost your card or think something&apos;s wrong?{" "}
        <a
          href="mailto:hello@batch0.org"
          className="underline underline-offset-4"
        >
          hello@batch0.org
        </a>
      </p>
    </main>
  );
}

/** A titled tool block on the holder's pass hub. */
function ToolCard({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: typeof Zap;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-phosphor-ink" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <p className="mt-0.5 text-xs text-ink-soft">{subtitle}</p>
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </Card>
  );
}
