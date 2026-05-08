"use client";
import React from "react";
import { motion } from "framer-motion";

const stats = [
  { v: "16M", k: "U.S. high schoolers", sub: "Our addressable population" },
  { v: "$97", k: "Cohort tuition", sub: "vs. $3K–$8K elsewhere" },
  { v: "4 wks", k: "Idea → investor pitch", sub: "Structured, deliverable-driven" },
  { v: "100%", k: "Virtual", sub: "Open to any U.S. teen" },
];

export default function Stats() {
  return (
    <section className="relative py-20 md:py-24 px-6 border-y border-white/5">
      <div className="mx-auto max-w-6xl grid grid-cols-2 md:grid-cols-4 gap-8">
        {stats.map((s, i) => (
          <motion.div
            key={s.k}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-50px" }}
            transition={{ duration: 0.6, delay: i * 0.08 }}
            className="text-center md:text-left"
          >
            <div className="text-4xl md:text-6xl font-black tracking-tighter shine">
              {s.v}
            </div>
            <div className="mt-2 text-sm font-medium text-white">{s.k}</div>
            <div className="text-xs text-white/40 mt-0.5">{s.sub}</div>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
