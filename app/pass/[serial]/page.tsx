import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatSerial } from "@/lib/founder-pass-code";
import { getSiteConfig } from "@/lib/site-config";
import { mapPassProfile, type PassProfile, type PassRow } from "@/lib/founder-pass";
import { normalizeUrl } from "@/lib/founder-pass-perks";
import { FounderPassTicket } from "../founder-pass-ticket";
import { ExternalLink } from "lucide-react";

/**
 * The public face of a claimed pass — a shareable ticket page, the way the
 * YC Startup School ticket exists to be linked. /pass/7 (or /pass/007, the
 * padded form embossed on the card) renders the holder's ticket for anyone.
 *
 * Only CLAIMED, live passes have a page: an unredeemed serial 404s, so the
 * unissued batch stays invisible (same reasoning as the RLS self-select
 * policy), and a revoked card's page dies with it. Names here are as public
 * as the rest of the community — /teams/[slug] already lists members by
 * full name on the open web.
 */

export const dynamic = "force-dynamic";

type PublicPass = {
  serial: number;
  batch: string;
  redeemedAt: string | null;
  name: string | null;
  /** Inert once redeemed (see migration 0040) — safe on a public page. */
  code: string | null;
  /** The holder's profile (migration 0041). Only rendered when `public`. */
  profile: PassProfile;
};

async function getPublicPass(serialParam: string): Promise<PublicPass | null> {
  // Strict digits-only: parseInt("7abc") === 7 would give one ticket many
  // URLs, and OG scrapers treat each as a distinct page.
  if (!/^\d{1,6}$/.test(serialParam)) return null;
  const serial = Number.parseInt(serialParam, 10);

  const admin = createAdminClient();
  // select("*") so this page keeps working on a database where migration
  // 0040 (redeemed_code) hasn't run — same reasoning as getPassForUser.
  const { data } = await admin
    .from("founder_passes")
    .select("*")
    .eq("serial", serial)
    .not("redeemed_by", "is", null)
    .is("revoked_at", null)
    .maybeSingle();
  if (!data) return null;

  const row = data as PassRow & { redeemed_by: string };
  const { data: profile } = await admin
    .from("profiles")
    .select("full_name")
    .eq("id", row.redeemed_by)
    .maybeSingle();

  return {
    serial: row.serial,
    batch: row.batch,
    redeemedAt: row.redeemed_at,
    name: (profile as { full_name: string | null } | null)?.full_name ?? null,
    code: row.redeemed_code ?? null,
    profile: mapPassProfile(row),
  };
}

export async function generateMetadata({
  params,
}: {
  params: { serial: string };
}): Promise<Metadata> {
  const pass = await getPublicPass(params.serial);
  if (!pass) return { title: "Founder Pass — batch0" };
  const label = formatSerial(pass.serial);
  const holder = pass.name ?? "A batch0 founder";
  return {
    title: `Founder Pass ${label} — batch0`,
    description: `${holder} holds batch0 founder pass ${label} — fast-tracked application, founder role, numbered card.`,
  };
}

export default async function PublicPassPage({
  params,
}: {
  params: { serial: string };
}) {
  const [pass, config] = await Promise.all([
    getPublicPass(params.serial),
    getSiteConfig(),
  ]);
  if (!pass) notFound();

  return (
    <main className="mx-auto max-w-lg px-5 py-16 md:py-24">
      <div className="text-center">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-phosphor-ink">
          Founder Pass {formatSerial(pass.serial)}
        </p>
        <h1 className="mt-3 font-display text-4xl leading-none text-ink md:text-5xl">
          {pass.name ?? "A batch0 founder"}
        </h1>
        <p className="mx-auto mt-4 max-w-md text-sm text-ink-soft">
          One of a numbered run of 3D-printed batch0 cards, bound to its
          holder&apos;s account.
        </p>
      </div>

      <FounderPassTicket
        className="mt-8 sm:-mx-8"
        name={pass.name}
        serialLabel={formatSerial(pass.serial)}
        code={pass.code}
        batch={pass.batch}
        cohortHeadline={config.derived.cohortHeadline}
        redeemedAt={pass.redeemedAt}
      />

      {pass.profile.public && <PublicProfile profile={pass.profile} />}

      <div className="mt-10 text-center text-sm text-ink-soft">
        <p>
          batch0 is a live, online startup accelerator for U.S. high
          schoolers. No equity taken.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
          <Link
            href="/apply"
            className="font-semibold text-phosphor-ink underline underline-offset-4"
          >
            Apply for {config.derived.cohortLabel || "the next cohort"} →
          </Link>
          <Link
            href="/pass"
            className="text-xs text-ink-faint underline underline-offset-4"
          >
            Hold a card? Unlock yours
          </Link>
        </div>
      </div>
    </main>
  );
}

/**
 * The holder's published profile. Only rendered when profile.public is true,
 * and every field guards its own presence — a holder who filled in only a
 * project name gets a page with only a project name, never empty scaffolding.
 * Links are re-normalized here (defence in depth) so nothing but http(s) ever
 * reaches an anchor on this public page.
 */
function PublicProfile({ profile }: { profile: PassProfile }) {
  const website = normalizeUrl(profile.websiteUrl);
  const demo = normalizeUrl(profile.demoUrl);
  const hasAnything =
    profile.projectName ||
    profile.bio ||
    website ||
    demo ||
    profile.milestones.length > 0;
  if (!hasAnything) return null;

  return (
    <section className="mt-8 rounded-2xl border border-line bg-wash p-6">
      {profile.projectName && (
        <h2 className="font-display text-2xl text-ink">{profile.projectName}</h2>
      )}
      {profile.bio && (
        <p className="mt-2 whitespace-pre-wrap text-sm text-ink-soft">
          {profile.bio}
        </p>
      )}
      {(website || demo) && (
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
          {website && (
            <a
              href={website}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-phosphor-ink underline underline-offset-4"
            >
              Website <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          {demo && (
            <a
              href={demo}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-phosphor-ink underline underline-offset-4"
            >
              Demo <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      )}
      {profile.milestones.length > 0 && (
        <ul className="mt-5 space-y-2">
          {profile.milestones.map((m, i) => (
            <li key={i} className="flex gap-2.5 text-sm text-ink-soft">
              <span
                aria-hidden
                className="mt-2 h-1 w-1 shrink-0 rounded-full bg-phosphor-ink/50"
              />
              <span>{m}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
