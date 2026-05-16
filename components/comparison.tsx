import React from "react";
import { Check, Minus } from "lucide-react";
import { Reveal } from "@/components/ui/reveal";
import type { SiteConfig } from "@/lib/site-config";

type Row = {
  program: string;
  cost: string;
  investors: boolean | string;
  virtual: boolean | string;
  yearRound: boolean | string;
  highlight?: boolean;
};

function ValueCell({ value }: { value: any }) {
  if (value === true) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] text-white/85">
        <Check className="h-3.5 w-3.5 text-spark" />
        Yes
      </span>
    );
  }
  if (value === false) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] text-white/45">
        <Minus className="h-3.5 w-3.5 text-white/30" />
        No
      </span>
    );
  }
  return <span className="text-[13px] text-white/70">{value}</span>;
}

export default function Comparison({ config }: { config: SiteConfig }) {
  const rows: Row[] = [
    {
      program: "LaunchX",
      cost: "$3,000–$8,000",
      investors: true,
      virtual: "Partial",
      yearRound: false,
    },
    {
      program: "LeanGap",
      cost: "Varies",
      investors: true,
      virtual: "Partial",
      yearRound: false,
    },
    {
      program: "YEA!",
      cost: "School-based",
      investors: "Panel only",
      virtual: false,
      yearRound: "Academic year",
    },
    {
      program: "SparkLine",
      cost: config.derived.priceLabel,
      investors: true,
      virtual: true,
      yearRound: true,
      highlight: true,
    },
  ];

  return (
    <section id="compare" className="relative py-16 sm:py-20 md:py-32 px-5 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <Reveal className="max-w-2xl">
          <p className="text-[11px] sm:text-xs font-medium uppercase tracking-[0.22em] text-spark">
            Why SparkLine
          </p>
          <h2 className="mt-3 text-[32px] sm:text-4xl md:text-5xl font-bold tracking-[-0.02em] text-white leading-[1.05]">
            Affordable. Virtual. Real investors.
          </h2>
          <p className="mt-4 sm:mt-5 text-base sm:text-[17px] text-white/75 leading-relaxed">
            Four axes worth comparing: cost, who you pitch, whether it
            actually runs online, and whether you can join when it fits
            your year.
          </p>
        </Reveal>

        {/* Desktop table */}
        <Reveal
          delay={80}
          className="relative mt-12 hidden overflow-hidden rounded-xl border border-white/10 md:block"
        >
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-white/10 bg-white/[0.02] text-[11px] uppercase tracking-[0.18em] text-white/60">
                <th scope="col" className="px-6 py-4 font-medium">Program</th>
                <th scope="col" className="px-6 py-4 font-medium">Cost</th>
                <th scope="col" className="px-6 py-4 font-medium">Real investors</th>
                <th scope="col" className="px-6 py-4 font-medium">Virtual</th>
                <th scope="col" className="px-6 py-4 font-medium">Year-round</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.program}
                  className={`border-b border-white/5 last:border-b-0 ${
                    r.highlight ? "bg-spark/[0.04]" : ""
                  }`}
                >
                  <td className="px-6 py-5">
                    <span
                      className={`text-[15px] font-semibold ${
                        r.highlight ? "text-spark" : "text-white"
                      }`}
                    >
                      {r.program}
                    </span>
                  </td>
                  <td className="px-6 py-5">
                    <span
                      className={
                        r.highlight
                          ? "text-[15px] font-semibold text-spark"
                          : "text-[15px] text-white/75"
                      }
                    >
                      {r.cost}
                    </span>
                  </td>
                  <td className="px-6 py-5">
                    <ValueCell value={r.investors} />
                  </td>
                  <td className="px-6 py-5">
                    <ValueCell value={r.virtual} />
                  </td>
                  <td className="px-6 py-5">
                    <ValueCell value={r.yearRound} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Reveal>

        {/* Mobile stacked cards — keeps comparison readable without a
         * cramped scrolling table. */}
        <div className="mt-8 grid gap-3 md:hidden">
          {rows.map((r) => (
            <div
              key={r.program}
              className={`rounded-xl border p-4 sm:p-5 ${
                r.highlight
                  ? "border-spark/40 bg-spark/[0.04]"
                  : "border-white/10 bg-white/[0.02]"
              }`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className={`text-[15px] font-semibold ${
                    r.highlight ? "text-spark" : "text-white"
                  }`}
                >
                  {r.program}
                </span>
                <span
                  className={
                    r.highlight
                      ? "text-[15px] font-semibold text-spark"
                      : "text-sm text-white/75"
                  }
                >
                  {r.cost}
                </span>
              </div>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
                <dt className="text-white/60">Investors</dt>
                <dd>
                  <ValueCell value={r.investors} />
                </dd>
                <dt className="text-white/60">Virtual</dt>
                <dd>
                  <ValueCell value={r.virtual} />
                </dd>
                <dt className="text-white/60">Year-round</dt>
                <dd>
                  <ValueCell value={r.yearRound} />
                </dd>
              </dl>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
