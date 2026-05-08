"use client";
import React from "react";
import Image from "next/image";
import { ContainerScroll } from "./container-scroll";

export default function ScrollPreview() {
  return (
    <section id="how-it-works" className="relative -mt-16">
      <ContainerScroll
        titleComponent={
          <>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-white">
              From idea to <span className="shine">funded startup</span>
            </h2>
            <p className="mt-4 text-base md:text-xl text-white/60 max-w-2xl mx-auto">
              4 weeks, fully online. Real curriculum, real mentors, real angel
              investors on demo day.
            </p>
          </>
        }
      >
        <div className="relative h-full w-full bg-gradient-to-br from-zinc-900 via-black to-zinc-900 p-6 md:p-10 overflow-hidden">
          <div className="absolute inset-0 grid-bg opacity-60" />
          <div className="absolute -right-20 -top-20 h-80 w-80 rounded-full bg-spark/20 blur-3xl" />

          <div className="relative grid h-full grid-cols-12 gap-4">
            <aside className="col-span-3 hidden md:flex flex-col gap-2 rounded-2xl border border-white/10 bg-black/40 p-4">
              <div className="flex items-center gap-2 mb-2">
                <Image src="/logo.svg" alt="" width={20} height={20} />
                <span className="font-semibold text-white text-sm">
                  Spark<span className="text-spark">Line</span>
                </span>
              </div>
              {[
                "Dashboard",
                "Week 1 · Validate",
                "Week 2 · Build",
                "Week 3 · Market",
                "Week 4 · Pitch",
                "Mentors",
                "Investor Day",
                "Community",
              ].map((s, i) => (
                <div
                  key={s}
                  className={`text-xs px-3 py-2 rounded-lg ${
                    i === 1
                      ? "bg-spark/15 text-spark border border-spark/30"
                      : "text-white/60 hover:bg-white/5"
                  }`}
                >
                  {s}
                </div>
              ))}
            </aside>

            <main className="col-span-12 md:col-span-9 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-widest text-spark">
                    Week 1
                  </p>
                  <h3 className="text-xl md:text-2xl font-bold text-white">
                    Validate your idea
                  </h3>
                </div>
                <div className="hidden md:flex items-center gap-2 text-xs text-white/50">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  Cohort Live · 24 students
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { k: "Students", v: "24" },
                  { k: "Mentors", v: "3" },
                  { k: "Investors", v: "8" },
                  { k: "Funded so far", v: "$0 → ?" },
                ].map((s) => (
                  <div
                    key={s.k}
                    className="rounded-xl border border-white/10 bg-white/5 p-3"
                  >
                    <div className="text-[10px] uppercase tracking-widest text-white/40">
                      {s.k}
                    </div>
                    <div className="text-lg font-bold text-white mt-0.5">
                      {s.v}
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 flex-1">
                {[
                  {
                    title: "Lean Canvas",
                    body: "Map your problem, customer, and unique value in one page.",
                    pct: 78,
                  },
                  {
                    title: "Customer Discovery",
                    body: "Run 10 problem interviews. Ship insights to the cohort.",
                    pct: 42,
                  },
                  {
                    title: "Problem/Solution Fit",
                    body: "Pressure-test your hypothesis with peer + mentor review.",
                    pct: 12,
                  },
                ].map((c) => (
                  <div
                    key={c.title}
                    className="rounded-xl border border-white/10 bg-zinc-900/80 p-4 flex flex-col"
                  >
                    <div className="text-sm font-semibold text-white">
                      {c.title}
                    </div>
                    <p className="text-xs text-white/50 mt-1 flex-1">{c.body}</p>
                    <div className="mt-3">
                      <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                        <div
                          className="h-full bg-spark"
                          style={{ width: `${c.pct}%` }}
                        />
                      </div>
                      <div className="mt-1.5 flex items-center justify-between text-[10px] text-white/40">
                        <span>{c.pct}% complete</span>
                        <span>Due Sun</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-spark/20 bg-spark/5 p-4 flex items-center justify-between">
                <div>
                  <div className="text-xs uppercase tracking-widest text-spark">
                    Demo Day
                  </div>
                  <div className="text-sm text-white mt-0.5">
                    Pitch live to angel investors · Week 4 · Friday 7pm ET
                  </div>
                </div>
                <span className="hidden md:inline rounded-full bg-spark px-3 py-1.5 text-xs font-semibold text-black">
                  Save your seat
                </span>
              </div>
            </main>
          </div>
        </div>
      </ContainerScroll>
    </section>
  );
}
