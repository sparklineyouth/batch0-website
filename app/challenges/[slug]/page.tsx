import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getUser, viewerCan } from "@/lib/auth";
import { getPublicSiteConfig } from "@/lib/site-config";
import { renderSafeMarkdown } from "@/lib/markdown-safe";
import { env } from "@/lib/env";
import {
  getChallengeBySlug,
  getEntrantState,
  getPublicWinners,
  getReferralProgress,
  getRegistrationCount,
  challengeReferralLink,
  prizeHeadline,
  KIND_LABELS,
} from "@/lib/challenges";
import { EventView } from "./event-view";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const c = await getChallengeBySlug(slug);
  if (!c || c.status === "draft") return { title: "Challenge · batch0" };
  const description =
    c.tagline || `${KIND_LABELS[c.kind]} for high schoolers. ${prizeHeadline(c)}`.trim();
  return {
    title: `${c.title} · batch0`,
    description,
    alternates: { canonical: `/challenges/${c.slug}` },
    // Shareable (OG) but unindexed: the /challenges index carries the SEO and
    // an ended challenge shouldn't linger in results.
    robots: { index: false, follow: true },
    openGraph: {
      title: c.title,
      description,
      ...(c.coverImageUrl ? { images: [{ url: c.coverImageUrl }] } : {}),
    },
  };
}

export default async function ChallengePage(props: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ ref?: string; join?: string }>;
}) {
  const [{ slug }, searchParams] = await Promise.all([
    props.params,
    props.searchParams,
  ]);
  // The page itself is public — top of funnel. Only the register card varies
  // by viewer. These lookups are independent, so they run together.
  const [user, challenge, config] = await Promise.all([
    getUser(),
    getChallengeBySlug(slug),
    getPublicSiteConfig(),
  ]);
  if (!challenge) notFound();
  const isStaff = user ? await viewerCan("challenges.manage") : false;
  if (challenge.status === "draft" && !isStaff) notFound();

  const [registrationCount, entrant, winners, description, rules] =
    await Promise.all([
      getRegistrationCount(challenge.id),
      user ? getEntrantState(challenge.id, user.id) : Promise.resolve(null),
      challenge.winnersPublished
        ? getPublicWinners({ challengeSlug: challenge.slug, limit: 30 })
        : Promise.resolve([]),
      challenge.description.trim()
        ? renderSafeMarkdown(challenge.description)
        : Promise.resolve(""),
      challenge.rules.trim() ? renderSafeMarkdown(challenge.rules) : Promise.resolve(""),
    ]);

  const referral =
    user && entrant?.referralCode
      ? {
          link: challengeReferralLink(env.siteUrl, challenge.slug, entrant.referralCode),
          count:
            challenge.referralsRequired > 0
              ? (
                  await getReferralProgress(
                    challenge,
                    user.id,
                    entrant.referralCode,
                  )
                ).count
              : 0,
        }
      : null;

  return (
    <EventView
      challenge={challenge}
      config={config}
      registrationCount={registrationCount}
      entrant={entrant}
      winners={winners}
      descriptionHtml={description}
      rulesHtml={rules}
      referral={referral}
      signedIn={!!user}
      autoJoin={searchParams.join === "1"}
      refCode={(searchParams.ref ?? "").slice(0, 32) || null}
    />
  );
}
