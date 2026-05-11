"use client";
import React from "react";
import { motion } from "framer-motion";
import { Check, X } from "lucide-react";

const rows = [
  {
    program: "LaunchX",
    cost: "$3,000–$8,000",
    investors: true,
    virtual: "partial",
    yearRound: false,
  },
  {
    program: "LeanGap",
    cost: "Varies",
    investors: true,
    virtual: "partial",
    yearRound: false,
  },
  {
    program: "YEA!",
    cost: "School-based",
    investors: "panel",
    virtual: false,
    yearRound: "academic",
  },
  {
    program: "SparkLine",
    cost: "$97",
    investors: true,
    virtual: true,
    yearRound: true,
    highlight: true,
  },
];

function Cell({ value }: { value: any }) {
  if (value === true)
    return (
      <span className="inline-flex items-center justify-center h-7 w-7 rounded-full bg-spark/15 border border-spark/30">
        <Check className="h-4 w-4 text-spark" />
      </span>
    );
  if (value === false)
    return (
      <span className="inline-flex items-center justify-center h-7 w-7 rounded-full bg-red-500/10 border border-red-500/30">
        <X className="h-4 w-4 text-red-400" />
      </span>
    );
  if (value === "partial")
    return (
      <span className="text-xs text-amber-300/80 px-2 py-1 rounded-full border border-amber-300/20 bg-amber-300/5">
        Partial
      </span>
    );
  if (value === "panel")
    return (
      <span className="text-xs text-amber-300/80 px-2 py-1 rounded-full border border-amber-300/20 bg-amber-300/5">
        Panel only
      </span>
    );
  if (value === "academic")
    return (
      <span className="text-xs text-amber-300/80 px-2 py-1 rounded-full border border-amber-300/20 bg-amber-300/5">
        Academic year
      </span>
    );
  return <span className="text-white/70 text-sm">{value}</span>;
}

export default function Comparison() {
  return (
    <section id="compare" className="relative py-16 md:py-32 px-6">
      <div className="mx-auto max-w-6xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center max-w-3xl mx-auto"
        >
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-spark">
            Why SparkLine
          </p>
          <h2 className="mt-3 text-4xl md:text-5xl font-bold tracking-tight text-white">
            Affordable. Virtual. <span className="shine">Real investors.</span>
          </h2>
          <p className="mt-5 text-lg text-white/60">
            No other program offers all four: affordable, year-round
            cohorts, fully virtual, and real angel investors on demo day.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.7 }}
          className="relative mt-14 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.04] to-transparent"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-white/10 text-xs uppercase tracking-wider text-white/40">
                  <th className="px-6 py-5 font-medium">Program</th>
                  <th className="px-6 py-5 font-medium">Cost</th>
                  <th className="px-6 py-5 font-medium">Real Investors</th>
                  <th className="px-6 py-5 font-medium">Virtual</th>
                  <th className="px-6 py-5 font-medium">Year-Round</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.program}
                    className={`border-b border-white/5 last:border-b-0 ${
                      r.highlight
                        ? "bg-spark/[0.06] relative"
                        : "hover:bg-white/[0.02]"
                    }`}
                  >
                    <td className="px-6 py-5">
                      <div className="flex items-center gap-2">
                        {r.highlight && (
                          <span className="h-2 w-2 rounded-full bg-spark animate-pulse" />
                        )}
                        <span
                          className={`font-semibold ${
                            r.highlight ? "text-spark" : "text-white"
                          }`}
                        >
                          {r.program}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-5">
                      <span
                        className={
                          r.highlight
                            ? "text-spark font-bold text-lg"
                            : "text-white/70"
                        }
                      >
                        {r.cost}
                      </span>
                    </td>
                    <td className="px-6 py-5">
                      <Cell value={r.investors} />
                    </td>
                    <td className="px-6 py-5">
                      <Cell value={r.virtual} />
                    </td>
                    <td className="px-6 py-5">
                      <Cell value={r.yearRound} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
