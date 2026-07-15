import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPassForUser } from "@/lib/founder-pass";
import { getFeedbackRequestForUser } from "@/lib/founder-pass-perks";
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
const PERKS: Perk[] = [
  {
    key: "discount",
    icon: Banknote,
    title: "$30 off tuition",
    body: "If you're accepted, your enrollment fee drops $30 at checkout — automatically, in any region. Tuition is still only charged if you get in.",
  },
  {
    key: "priority",
    icon: Zap,
    title: "A priority review lane",
    body: "Your application is badged and sorted to the top of the queue, and we aim to get you a decision within three business days of a complete application. Priority means read first — the bar to get in is the same for everyone.",
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
    body: "Your serial is embossed on the card, bound to your account, and doesn't expire — it carries to every future cohort. The $30 discount redeems once unless your pass page says otherwise.",
  },
  {
    key: "early_access",
    icon: Clock,
    title: "Apply before applications open",
    body: "When a cohort isn't public yet, your pass gets you in early.",
  },
];

export default async function PassPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The pass read goes through the service-role client. founder_passes does
  // have a self-select RLS policy, but the anon client would return null
  // indistinguishably for "no pass" and "policy blocked it" — reading as admin
  // and filtering by user id keeps that ambiguity out of the UI.
  const admin = createAdminClient();
  const pass = user ? await getPassForUser(admin, user.id) : null;
  const config = await getSiteConfig();
  const earlyAccess = config.settings.founderPassEarlyAccess;

  // The ticket prints the holder's name like a boarding pass. profiles has a
  // self-select policy, so the user's own client can read it.
  let holderName: string | null = null;
  let feedbackRequest = null;
  if (user && pass) {
    const [{ data: profile }, request] = await Promise.all([
      supabase
        .from("profiles")
        .select("full_name")
        .eq("id", user.id)
        .maybeSingle(),
      getFeedbackRequestForUser(admin, user.id),
    ]);
    holderName =
      (profile as { full_name: string | null } | null)?.full_name ?? null;
    feedbackRequest = request;
  }

  // Holders have dedicated tool sections for these three perks below, so the
  // summary list drops them to avoid saying the same thing twice. Non-holders
  // see the full list — it's the whole value proposition.
  const sectionedKeys = new Set(["profile", "toolkit", "feedback_credit"]);
  const perksToList = PERKS.filter((perk) => {
    // The early-access perk is the one thing an admin can switch off (site
    // setting `founder_pass_early_access`), because the global applications
    // gate can't tell "not open yet" from "closed for good". Don't advertise
    // it while it's off — that's how the referral card ended up lying.
    if (perk.key === "early_access" && !earlyAccess) return false;
    if (pass && sectionedKeys.has(perk.key)) return false;
    return true;
  });

  return (
    <main className="mx-auto max-w-lg px-5 py-16 md:py-24">
      <div className="text-center">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-phosphor-ink">
          Founder Pass
        </p>
        <h1 className="mt-3 font-display text-4xl leading-none text-ink md:text-5xl">
          {pass ? "Your pass is active" : "Unlock your card"}
        </h1>
        <p className="mx-auto mt-4 max-w-md text-sm text-ink-soft">
          {pass
            ? "Permanently tied to your account. Real tools, feedback, and opportunities to build — whether or not you get into this cohort."
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

          {/* The interactive tools — the perks a holder acts on right here. */}
          <div className="mt-8 space-y-4">
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
              title="Feedback credit"
              subtitle="One focused, human review of the thing you're stuck on."
            >
              <FeedbackCredit request={feedbackRequest} />
            </ToolCard>
          </div>
        </>
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
