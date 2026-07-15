import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPassForUser } from "@/lib/founder-pass";
import { formatSerial } from "@/lib/founder-pass-code";
import { getSiteConfig } from "@/lib/site-config";
import { PassForm } from "./pass-form";
import { FounderPassTicket } from "./founder-pass-ticket";
import {
  Zap,
  MessageSquare,
  BadgeCheck,
  Clock,
  Users,
  Share2,
  Banknote,
  PenLine,
} from "lucide-react";

export const metadata: Metadata = {
  title: "Founder Pass — batch0",
  description:
    "Unlock the founder pass on your batch0 card: a fast-tracked application, a Discord role, and early access to apply.",
};

// Reads per-user state (their pass) — never cache this at the edge.
export const dynamic = "force-dynamic";

type Perk = {
  icon: typeof Zap;
  title: string;
  body: string;
};

// Only list perks the product actually delivers. The referral card next door
// (app/dashboard/referral-card.tsx) is a standing reminder of the cost of
// doing otherwise: it promised "a credit toward a 1:1 mentor session" that had
// no schema, no mentors, and no chance of being honoured. Every line below is
// backed by code in this commit.
const PERKS: Perk[] = [
  {
    icon: Banknote,
    title: "$30 off tuition",
    body: "If you're accepted, your enrollment fee drops $30 at checkout — automatically, in any region. Tuition is still only charged if you get in.",
  },
  {
    icon: Zap,
    title: "Your application gets fast-tracked",
    body: "It's badged and sorted to the top of the review queue, so a human reads it first — not sooner-accepted, just sooner-read.",
  },
  {
    icon: PenLine,
    title: "A straight answer if it's a no",
    body: "Pass holders never get a form-letter rejection: the review tool refuses to decline your application until a human has written you feedback. It lands in your email and on your dashboard.",
  },
  {
    icon: Clock,
    title: "Apply before applications open",
    body: "When a cohort isn't public yet, your pass gets you in early.",
  },
  {
    icon: MessageSquare,
    title: "A founder role in Discord",
    body: "In the Discord server: link your account and the role lands automatically. Link it later and it still lands.",
  },
  {
    icon: Users,
    title: "The badge on the site",
    body: "On batch0 itself — team pages, team threads — a founder-pass badge sits next to your name, where mentors and investors are looking.",
  },
  {
    icon: BadgeCheck,
    title: "A numbered pass, for good",
    body: "Your serial is embossed on the card, bound to your account, and doesn't expire — it carries to every future cohort.",
  },
  {
    icon: Share2,
    title: "A ticket page you can share",
    body: "Your pass gets its own public page with your name and card code on the ticket. Link it from your bio; the unfurl is the ticket itself.",
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
  const pass = user ? await getPassForUser(createAdminClient(), user.id) : null;
  const config = await getSiteConfig();
  const earlyAccess = config.settings.founderPassEarlyAccess;

  // The ticket prints the holder's name like a boarding pass. profiles has a
  // self-select policy, so the user's own client can read it.
  let holderName: string | null = null;
  if (user && pass) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", user.id)
      .maybeSingle();
    holderName =
      (profile as { full_name: string | null } | null)?.full_name ?? null;
  }

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
            ? "This card is bound to your account. Here's what it gets you."
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
          <p className="mt-4 text-center text-xs text-ink-faint">
            Your ticket has a public page —{" "}
            <Link
              href={`/pass/${pass.serial}`}
              className="font-medium text-phosphor-ink underline underline-offset-4"
            >
              batch0.org/pass/{pass.serial}
            </Link>
            . Share it anywhere.
          </p>
        </>
      ) : (
        <Card className="mt-8">
          <PassForm signedIn={!!user} />
        </Card>
      )}

      <ul className="mt-10 space-y-5">
        {PERKS.map((perk) => {
          // The early-access perk is the one thing here that an admin can
          // switch off (site setting `founder_pass_early_access`), because the
          // global applications gate can't tell "not open yet" from "closed for
          // good". Don't advertise it while it's off — that's how the referral
          // card ended up lying.
          const dimmed = perk.icon === Clock && !earlyAccess;
          if (dimmed) return null;
          return (
            <li key={perk.title} className="flex gap-4">
              <perk.icon className="mt-0.5 h-5 w-5 shrink-0 text-phosphor-ink" />
              <div>
                <p className="text-sm font-semibold text-ink">{perk.title}</p>
                <p className="mt-1 text-sm text-ink-soft">{perk.body}</p>
              </div>
            </li>
          );
        })}
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
