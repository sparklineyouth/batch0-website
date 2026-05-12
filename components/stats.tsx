import React from "react";
import { Reveal } from "@/components/ui/reveal";

// Each stat should anchor a concrete fact about the program (not market
// sizing) so first-time visitors read it as social proof, not pitch deck.
const stats = [
  { v: "24", k: "Seats per cohort", sub: "Capped on purpose — feedback over scale" },
  { v: "$97", k: "Cohort tuition", sub: "vs. $3K–$8K elsewhere" },
  { v: "4 wks", k: "Idea → investor pitch", sub: "Structured, deliverable-driven" },
  { v: "100%", k: "Virtual", sub: "Open to any U.S. teen, 13–18" },
];

export default function Stats() {
  return (
    <section className="relative py-16 md:py-24 px-6 border-y border-white/5">
      <div className="mx-auto max-w-6xl grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-10 md:gap-10">
        {stats.map((s, i) => (
          <Reveal key={s.k} delay={i * 80} className="text-center">
            <div className="text-4xl md:text-6xl font-black tracking-tighter shine">
              {s.v}
            </div>
            <div className="mt-2 text-sm font-medium text-white">{s.k}</div>
            <div className="mt-0.5 text-xs text-white/40">{s.sub}</div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
