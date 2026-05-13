import React from "react";
import type { SiteConfig } from "@/lib/site-config";

export default function Stats({ config }: { config: SiteConfig }) {
  const { derived } = config;

  const supporting = [
    {
      v: derived.capacityLabel,
      k: "Seats per cohort",
      sub: "Capped on purpose",
    },
    { v: "4 wks", k: "Idea → pitch", sub: "Structured deliverables" },
    { v: "100%", k: "Virtual", sub: "Open to U.S. teens" },
  ];

  return (
    <section className="relative border-y border-white/10 px-6 py-14 md:py-20">
      <div className="mx-auto max-w-6xl grid grid-cols-1 md:grid-cols-12 gap-10 md:gap-14 items-end">
        <div className="md:col-span-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-spark">
            Tuition
          </p>
          <div className="mt-3 flex items-baseline gap-3">
            <span className="text-7xl md:text-8xl font-bold tracking-[-0.04em] text-white">
              {derived.priceLabel}
            </span>
            <span className="text-base text-white/65">one-time</span>
          </div>
          <p className="mt-3 max-w-sm text-[15px] text-white/75 leading-relaxed">
            Compare to LaunchX or LeanGap at $3,000–$8,000+. Free to apply,
            charged only if accepted.
          </p>
        </div>

        <dl className="md:col-span-7 grid grid-cols-3 gap-6 md:gap-10">
          {supporting.map((s) => (
            <div key={s.k} className="border-t border-white/10 pt-4">
              <dt className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/60">
                {s.k}
              </dt>
              <dd className="mt-2 text-3xl md:text-4xl font-semibold tracking-tight text-white">
                {s.v}
              </dd>
              <dd className="mt-0.5 text-xs text-white/65">{s.sub}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
