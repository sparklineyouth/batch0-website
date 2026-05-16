import React from "react";
import Link from "next/link";
import { Reveal } from "@/components/ui/reveal";
import type { SiteConfig } from "@/lib/site-config";

export default function CTA({ config }: { config: SiteConfig }) {
  const { derived, settings } = config;
  const cohortLabel = derived.cohortLabel || derived.cohortName;

  return (
    <section
      id="apply"
      className="relative py-16 sm:py-20 md:py-32 px-5 sm:px-6"
    >
      <div className="mx-auto max-w-5xl">
        <Reveal className="max-w-2xl">
          <p className="text-[11px] sm:text-xs font-medium uppercase tracking-[0.22em] text-spark">
            Reserve your seat
          </p>
          <h2 className="mt-3 text-[34px] sm:text-4xl md:text-6xl font-bold tracking-[-0.03em] leading-[1.05] sm:leading-[1.02] text-white">
            Your startup, funded,
            <br />
            before you graduate.
          </h2>
          <p className="mt-4 sm:mt-5 max-w-xl text-[15px] sm:text-[17px] text-white/75 leading-[1.6]">
            {cohortLabel} launches {derived.cohortName}.{" "}
            {derived.capacityLabel} seats. {derived.priceLabel} if accepted.
            Real cash grants on Demo Day.
          </p>
        </Reveal>

        <Reveal
          delay={80}
          className="mt-10 sm:mt-12 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.04] to-transparent md:grid md:grid-cols-2"
        >
          {/* Price column — on mobile the tuition is the headline number
              (it's the actual commitment); $0 is the supporting fact. */}
          <div className="p-6 sm:p-8 md:p-10">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/60">
              Tuition if accepted
            </p>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-[48px] sm:text-5xl md:text-6xl font-bold tracking-[-0.03em] leading-none text-white">
                {derived.priceLabel}
              </span>
              <span className="text-sm text-white/65">one-time</span>
            </div>
            <div className="mt-5 flex items-center gap-3 rounded-lg border border-spark/20 bg-spark/[0.04] px-3 py-2.5">
              <span
                aria-hidden
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-spark/15 text-spark text-[13px] font-bold"
              >
                $0
              </span>
              <p className="text-[13px] text-white/85">
                Free to apply · ~5 minutes
              </p>
            </div>
            <ul className="mt-6 space-y-2.5 text-[14px] sm:text-[15px] text-white/80">
              <Bullet>4 weeks, fully virtual</Bullet>
              <Bullet>Live mentor sessions + Discord community</Bullet>
              <Bullet>Pitch our sponsor-funded grant panel on Demo Day</Bullet>
              <Bullet>Walk away with a fundable startup package</Bullet>
            </ul>
          </div>

          {/* Action column */}
          <div className="flex flex-col gap-5 border-t border-white/10 p-6 sm:p-8 md:border-l md:border-t-0 md:p-10">
            {(derived.spotsLabel || derived.applicationsCountdownLabel) && (
              <div className="rounded-lg border border-spark/30 bg-spark/[0.06] px-3 py-2 text-[12px] sm:text-xs text-spark">
                {derived.applicationsCountdownLabel || derived.spotsLabel}
                {derived.applicationsCountdownLabel && derived.spotsLabel && (
                  <>
                    {" "}
                    <span className="text-white/60">·</span>{" "}
                    <span className="text-white/85">
                      {derived.spotsLabel}
                    </span>
                  </>
                )}
              </div>
            )}
            <Link
              href="/signup"
              className="press group inline-flex w-full items-center justify-center gap-2 rounded-lg bg-spark px-6 py-4 text-[15px] font-semibold text-black shadow-[0_8px_24px_-8px_rgba(250,204,21,0.5)] hover:bg-spark-200"
            >
              Start your application
              <span
                aria-hidden
                className="transition-transform group-hover:translate-x-0.5"
              >
                →
              </span>
            </Link>
            <p className="text-center text-[13px] sm:text-xs text-white/65">
              Rolling admissions · Reviewed weekly
            </p>
            <p className="text-center text-[13px] sm:text-xs text-white/65">
              Already applied?{" "}
              <Link
                href="/login"
                className="text-white/80 underline underline-offset-2 hover:text-spark"
              >
                Log in
              </Link>
            </p>
          </div>
        </Reveal>

        <p className="mt-8 text-center text-[13px] sm:text-xs text-white/65">
          Questions?{" "}
          <a
            href={`mailto:${settings.contactEmail}`}
            className="text-spark hover:underline"
          >
            {settings.contactEmail}
          </a>
        </p>
      </div>
    </section>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-spark"
      />
      <span>{children}</span>
    </li>
  );
}
