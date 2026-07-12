"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

export type MarqueeChallenge = {
  slug: string;
  title: string;
  marqueeText: string;
  prizeLabel: string;
  ctaLabel: string;
  ctaHref: string | null;
};

/**
 * The one moving element on the homepage. A seamless horizontal ticker on a
 * spark bar while a challenge is active. Pauses on hover/focus; falls back to
 * a static single line when the visitor prefers reduced motion.
 */
export function ChallengeMarquee({ challenge }: { challenge: MarqueeChallenge }) {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  const message =
    challenge.marqueeText.trim() ||
    [challenge.title.trim(), challenge.prizeLabel.trim()]
      .filter(Boolean)
      .join(" — ") ||
    challenge.title.trim();

  const href = challenge.ctaHref || `/challenges/${challenge.slug}`;
  const ctaLabel = challenge.ctaLabel || "Apply";

  // Each repeated ticker unit. Duplicated across two identical halves so the
  // -50% wrap is seamless. Marked decorative — the accessible copy is the
  // sr-only summary + the real Apply link.
  const Unit = () => (
    <span className="mx-6 inline-flex items-center gap-3" aria-hidden>
      <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em]">
        ⚡ Weekly Challenge
      </span>
      <span className="text-[13px]">{message}</span>
      <span className="text-on-spark/40">•</span>
    </span>
  );
  const half = Array.from({ length: 6 }, (_, i) => <Unit key={i} />);

  return (
    <section
      aria-label="Weekly challenge"
      className="bg-spark text-on-spark"
    >
      <div className="mx-auto flex max-w-[1100px] items-stretch">
        <div className="challenge-marquee-viewport min-w-0 flex-1 overflow-hidden">
          <span className="sr-only">
            Weekly challenge: {message}.
          </span>
          {reduced ? (
            <p className="truncate px-5 py-2 text-[13px]">
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em]">
                ⚡ Weekly Challenge{" "}
              </span>
              {message}
            </p>
          ) : (
            <div className="challenge-marquee-track py-2" aria-hidden>
              <div className="flex shrink-0">{half}</div>
              <div className="flex shrink-0">{half}</div>
            </div>
          )}
        </div>
        <Link
          href={href}
          className="press flex shrink-0 items-center gap-1 border-l border-on-spark/20 px-4 text-[13px] font-semibold text-on-spark underline decoration-on-spark/40 underline-offset-2 hover:decoration-on-spark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-on-spark/50"
        >
          {ctaLabel} →
        </Link>
      </div>
    </section>
  );
}
