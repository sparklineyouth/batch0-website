"use client";
import React from "react";
import { motion } from "framer-motion";

const team = [
  {
    name: "Rishabh Dagli",
    role: "Founder & Engineering",
    location: "Plainsboro, NJ",
    bio: "Built SparkLine's curriculum, platform, brand, and Discord architecture. Background in hardware engineering, product, and startup development.",
    initials: "RD",
  },
  {
    name: "Shresht Chopra",
    role: "Co-Founder & Operations",
    location: "West Windsor, NJ",
    bio: "Drives student enrollment, school and parent outreach, partnerships, and program logistics. Background in FTC robotics and grassroots scaling.",
    initials: "SC",
  },
];

export default function Founders() {
  return (
    <section id="founders" className="relative py-24 md:py-32 px-6">
      <div className="mx-auto max-w-6xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="max-w-3xl"
        >
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-spark">
            The team
          </p>
          <h2 className="mt-3 text-4xl md:text-5xl font-bold tracking-tight text-white">
            Built by students, for students.
          </h2>
          <p className="mt-5 text-lg text-white/60">
            We're high schoolers ourselves. We built SparkLine because we
            looked at the alternatives — and they weren't built for people
            like us.
          </p>
        </motion.div>

        <div className="mt-14 grid gap-6 md:grid-cols-2">
          {team.map((m, i) => (
            <motion.div
              key={m.name}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.6, delay: i * 0.1 }}
              className="group relative rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.04] to-transparent p-7 hover:border-spark/30 transition-colors"
            >
              <div className="flex items-start gap-5">
                <div className="relative shrink-0">
                  <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-spark to-spark-400 flex items-center justify-center text-black font-black text-xl">
                    {m.initials}
                  </div>
                  <div className="absolute inset-0 rounded-2xl bg-spark/40 blur-xl -z-10 opacity-50 group-hover:opacity-80 transition-opacity" />
                </div>
                <div>
                  <h3 className="text-xl font-semibold text-white">{m.name}</h3>
                  <div className="text-sm text-spark mt-0.5">{m.role}</div>
                  <div className="text-xs text-white/40 mt-0.5">
                    {m.location}
                  </div>
                </div>
              </div>
              <p className="mt-5 text-sm text-white/60 leading-relaxed">
                {m.bio}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
