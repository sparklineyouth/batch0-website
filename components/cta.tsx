import React from "react";
import Link from "next/link";
import { Reveal } from "@/components/ui/reveal";
import type { SiteConfig } from "@/lib/site-config";

export default function CTA({ config }: { config: SiteConfig }) {
  const { derived, settings } = config;
  const cohortLabel = derived.cohortLabel || derived.cohortName;

  return (
    <section id="apply" className="relative py-20 md:py-32 px-6">
      <div className="mx-auto max-w-5xl">
        <Reveal className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-[0.22em] text-spark">
            Reserve your seat
          </p>
          <h2 className="mt-3 text-4xl md:text-6xl font-bold tracking-[-0.03em] leading-[1.02] text-white">
            Your startup, funded,
            <br />
            before you graduate.
          </h2>
          <p className="mt-5 max-w-xl text-[17px] text-white/75 leading-relaxed">
            {cohortLabel} launches {derived.cohortName}.{" "}
            {derived.capacityLabel} seats. {derived.priceLabel} if accepted.
            Real angel investors on Demo Day.
          </p>
        </Reveal>

        <Reveal
          delay={80}
          className="mt-12 grid gap-6 rounded-2xl border border-white/10 bg-white/[0.02] p-8 md:grid-cols-2 md:p-10"
        >
          <div className="flex flex-col justify-between gap-6">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/60">
                Application
              </p>
              <p className="mt-2 text-5xl md:text-6xl font-bold tracking-[-0.03em] text-white">
                $0
              </p>
              <p className="mt-1 text-sm text-white/70">
                Free to apply. About 5 minutes.
              </p>
            </div>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/60">
                Tuition if accepted
              </p>
              <p className="mt-2 text-3xl font-semibold tracking-tight text-white">
                {derived.priceLabel}{" "}
                <span className="text-base font-normal text-white/65">
                  one-time
                </span>
              </p>
            </div>
          </div>

          <div className="flex flex-col justify-between gap-6 border-t border-white/10 pt-6 md:border-l md:border-t-0 md:pl-10 md:pt-0">
            <ul className="space-y-3 text-[15px] text-white/80">
              <Bullet>4 weeks, fully virtual</Bullet>
              <Bullet>Live mentor sessions + Discord community</Bullet>
              <Bullet>Pitch to real angel investors on Demo Day</Bullet>
              <Bullet>Walk away with a fundable startup package</Bullet>
            </ul>
            <div>
              <Link
                href="/signup"
                className="press inline-flex w-full items-center justify-center gap-2 rounded-md bg-spark px-6 py-3.5 text-[15px] font-semibold text-black hover:bg-spark-200"
              >
                Start your application
                <span aria-hidden>→</span>
              </Link>
              <p className="mt-3 text-center text-xs text-white/65">
                Rolling admissions · Reviewed weekly · Already applied?{" "}
                <Link
                  href="/login"
                  className="text-white/80 underline-offset-2 hover:text-spark hover:underline"
                >
                  Log in
                </Link>
              </p>
            </div>
          </div>
        </Reveal>

        <p className="mt-8 text-center text-xs text-white/65">
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
        className="mt-2 h-1 w-1 shrink-0 rounded-full bg-spark"
      />
      <span>{children}</span>
    </li>
  );
}
