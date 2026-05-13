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
  "Angel Investors",
  "Real Funding",
];

export default function Marquee() {
  return (
    <section
      aria-hidden
      className="relative overflow-hidden border-y border-white/10 py-5 bg-black"
    >
      <div className="flex animate-marquee gap-10 whitespace-nowrap will-change-transform">
        {[...items, ...items].map((s, i) => (
          <span
            key={`${s}-${i}`}
            className="text-sm font-medium uppercase tracking-[0.22em] text-white/60"
          >
            {s}
            <span aria-hidden className="ml-10 text-white/25">
              /
            </span>
          </span>
        ))}
      </div>
    </section>
  );
}
