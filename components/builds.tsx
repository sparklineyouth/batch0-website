import React from "react";
import {
  Compass,
  Wrench,
  LineChart,
  Megaphone,
  Presentation,
  Handshake,
  type LucideIcon,
} from "lucide-react";
import { Reveal } from "@/components/ui/reveal";

type Build = {
  icon: LucideIcon;
  title: string;
  body: string;
};

const BUILDS: Build[] = [
  {
    icon: Compass,
    title: "Customer discovery",
    body: "Find a real problem worth solving. Lean Canvas, problem-solution fit, structured user interviews.",
  },
  {
    icon: Wrench,
    title: "MVP & product",
    body: "Ship a v1 fast — landing page, no-code MVP, or working prototype — without overbuilding before validation.",
  },
  {
    icon: LineChart,
    title: "Business model",
    body: "Revenue, pricing, unit economics. Turn your idea into something investors can actually back.",
  },
  {
    icon: Megaphone,
    title: "Go-to-market",
    body: "Brand, positioning, distribution. Land your first hundred users with a wedge you can actually execute.",
  },
  {
    icon: Presentation,
    title: "Pitch & storytelling",
    body: "A deck that holds up to investor scrutiny, and the live delivery to back it up.",
  },
  {
    icon: Handshake,
    title: "Fundraising fundamentals",
    body: "How sponsorship, angel, and pre-seed capital actually work — and how to ask for it without giving away the farm.",
  },
];

export default function Builds() {
  return (
    <section className="relative py-16 sm:py-20 md:py-28 px-5 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <Reveal className="max-w-2xl">
          <p className="text-[11px] sm:text-xs font-medium uppercase tracking-[0.22em] text-spark">
            What you'll learn
          </p>
          <h2 className="mt-3 text-[32px] sm:text-4xl md:text-5xl font-bold tracking-[-0.02em] text-white leading-[1.05]">
            The skills founders actually use.
          </h2>
          <p className="mt-4 sm:mt-5 text-base sm:text-[17px] text-white/75 leading-relaxed">
            Six core skill blocks. Taught in sequence, applied to your
            own startup, with feedback from mentors who have shipped.
          </p>
        </Reveal>

        <ul className="mt-10 sm:mt-12 grid gap-4 sm:gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {BUILDS.map((b, i) => {
            const Icon = b.icon;
            return (
              <Reveal
                key={b.title}
                as="li"
                delay={i * 60}
                className="rounded-2xl border border-white/10 bg-white/[0.02] p-6"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-spark/15 text-spark">
                  <Icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-lg sm:text-xl font-semibold tracking-tight text-white">
                  {b.title}
                </h3>
                <p className="mt-2 text-[14px] sm:text-[15px] text-white/75 leading-relaxed">
                  {b.body}
                </p>
              </Reveal>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
