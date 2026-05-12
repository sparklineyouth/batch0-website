import React from "react";
import { DollarSign, MapPin, Award } from "lucide-react";
import { Reveal } from "@/components/ui/reveal";

const problems = [
  {
    icon: DollarSign,
    title: "Priced for the few",
    body: "LaunchX, LeanGap, and most quality programs are locked behind $3,000–$8,000+ tuition. The teens who'd benefit most can't afford to apply.",
  },
  {
    icon: MapPin,
    title: "Locked to a city or season",
    body: "If you don't live in the right place, or your summer's already booked, you're out. Most accelerators run a couple of weeks a year — that's not how a real startup works.",
  },
  {
    icon: Award,
    title: "Judges, not investors",
    body: "Most programs end with a panel handing out plaques. That's not the real world. We end with real angel investors writing real checks.",
  },
];

export default function Problem() {
  return (
    <section className="relative py-16 md:py-32 px-6">
      <div className="mx-auto max-w-6xl">
        <Reveal className="mx-auto max-w-3xl text-center">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-spark">
            The problem
          </p>
          <h2 className="mt-3 text-4xl md:text-5xl font-bold tracking-tight text-white">
            Youth entrepreneurship is broken.
          </h2>
          <p className="mt-5 text-lg text-white/60">
            The teens who want to build companies don't need another
            business-plan competition. They need access — and right now
            that's reserved for people who can afford the tuition or who
            happen to live in the right zip code.
          </p>
        </Reveal>

        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {problems.map((p, i) => (
            <Reveal
              key={p.title}
              delay={i * 100}
              className="group relative rounded-2xl border border-white/10 bg-white/[0.03] p-7 hover:border-spark/30 hover:bg-spark/[0.04] transition-colors duration-150"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-spark/10 text-spark border border-spark/20">
                <p.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-5 text-xl font-semibold text-white">
                {p.title}
              </h3>
              <p className="mt-2 text-sm text-white/55 leading-relaxed">
                {p.body}
              </p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
