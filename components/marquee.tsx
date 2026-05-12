import React from "react";

const items = [
  "Lean Canvas",
  "Customer Discovery",
  "Business Model",
  "Pricing Strategy",
  "Go-to-Market",
  "Brand Positioning",
  "Pitch Deck",
  "Demo Day",
  "Angel Investors",
  "Real Funding",
];

export default function Marquee() {
  return (
    <section
      aria-hidden
      className="relative overflow-hidden border-y border-white/5 py-6 bg-black"
    >
      <div className="flex animate-marquee gap-12 whitespace-nowrap will-change-transform">
        {[...items, ...items].map((s, i) => (
          <span
            key={`${s}-${i}`}
            className="text-sm md:text-base font-medium uppercase tracking-[0.18em] text-white/30"
          >
            {s} <span className="text-spark/60 ml-12">✦</span>
          </span>
        ))}
      </div>
    </section>
  );
}
