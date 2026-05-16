import React from "react";

// A subdued curriculum strip — restrained tracking, no decorative sparkles,
// stronger contrast so the words read like a manifest, not chrome.
const items = [
  "Lean Canvas",
  "Customer Discovery",
  "Business Model",
  "Pricing Strategy",
  "Go-to-Market",
  "Brand Positioning",
  "Pitch Deck",
  "Demo Day",
  "Sponsor Grants",
  "Zero Equity",
  "Real Funding",
];

export default function Marquee() {
  return (
    <section
      aria-hidden
      className="relative overflow-hidden border-y border-white/10 py-4 sm:py-5 bg-black"
    >
      {/* Soft fade at the edges so the marquee feels continuous instead
       * of slamming into the viewport border. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 sm:w-20 bg-gradient-to-r from-black to-transparent"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 sm:w-20 bg-gradient-to-l from-black to-transparent"
      />
      <div className="flex animate-marquee gap-8 sm:gap-10 whitespace-nowrap will-change-transform">
        {[...items, ...items].map((s, i) => (
          <span
            key={`${s}-${i}`}
            className="text-[13px] sm:text-sm font-medium uppercase tracking-[0.2em] sm:tracking-[0.22em] text-white/60"
          >
            {s}
            <span aria-hidden className="ml-8 sm:ml-10 text-white/25">
              /
            </span>
          </span>
        ))}
      </div>
    </section>
  );
}
