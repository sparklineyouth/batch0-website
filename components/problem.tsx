"use client";
import React from "react";
import { motion } from "framer-motion";
import { DollarSign, MapPin, Award } from "lucide-react";

const problems = [
  {
    icon: DollarSign,
    title: "$3,000–$8,000+",
    body: "LaunchX, LeanGap, and most quality programs are locked behind massive tuition. The teens who'd benefit most can't afford to apply.",
  },
  {
    icon: MapPin,
    title: "Locked to a city, summer, or zip code",
    body: "If you don't live in the right place — or your summer's already booked — you're out. Most accelerators run a couple weeks a year.",
  },
  {
    icon: Award,
    title: "Judges and certificates. Not investors.",
    body: "Most programs end with a panel handing out plaques. That's not the real world. We end with angel investors writing real checks.",
  },
];

export default function Problem() {
  return (
    <section className="relative py-24 md:py-32 px-6">
      <div className="mx-auto max-w-6xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="max-w-3xl"
        >
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-spark">
            The problem
          </p>
          <h2 className="mt-3 text-4xl md:text-5xl font-bold tracking-tight text-white">
            Youth entrepreneurship is broken.
          </h2>
          <p className="mt-5 text-lg text-white/60">
            The teens who want to build companies don't need another business
            plan competition. They need access. Right now, that's reserved for
            wealthy families in major cities.
          </p>
        </motion.div>

        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {problems.map((p, i) => (
            <motion.div
              key={p.title}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.6, delay: i * 0.1 }}
              className="group relative rounded-2xl border border-white/10 bg-white/[0.03] p-7 hover:border-spark/30 hover:bg-spark/[0.04] transition-colors"
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
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
