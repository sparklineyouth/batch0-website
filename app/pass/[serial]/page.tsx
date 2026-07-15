import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatSerial } from "@/lib/founder-pass-code";
import { getSiteConfig } from "@/lib/site-config";
import { FounderPassTicket } from "../founder-pass-ticket";

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

  const row = data as {
    serial: number;
    batch: string;
    redeemed_at: string | null;
    redeemed_by: string;
    redeemed_code?: string | null;
  };
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
