"use client";
import React from "react";
import Image from "next/image";
import { motion } from "framer-motion";

export default function Navbar() {
  const links = [
    { href: "#how-it-works", label: "Program" },
    { href: "#curriculum", label: "Curriculum" },
    { href: "#compare", label: "Why SparkLine" },
    { href: "#founders", label: "Team" },
    { href: "#faq", label: "FAQ" },
  ];

  return (
    <motion.header
      initial={{ y: -24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      className="fixed top-0 inset-x-0 z-50 px-4 pt-4"
    >
      <nav className="mx-auto max-w-6xl flex items-center justify-between rounded-2xl border border-white/10 bg-black/50 backdrop-blur-xl px-4 py-2.5">
        <a href="#" className="flex items-center gap-2.5">
          <Image src="/logo.svg" alt="SparkLine" width={28} height={28} priority />
          <span className="text-white font-semibold tracking-tight text-lg">
            Spark<span className="text-spark">Line</span>
          </span>
        </a>
        <ul className="hidden md:flex items-center gap-7 text-sm text-white/70">
          {links.map((l) => (
            <li key={l.href}>
              <a href={l.href} className="hover:text-white transition-colors">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3">
          <a
            href="/login"
            className="hidden sm:inline-block text-sm text-white/60 hover:text-white transition-colors"
          >
            Log in
          </a>
          <a
            href="/signup"
            className="group relative inline-flex items-center gap-1.5 rounded-full bg-spark px-4 py-2 text-sm font-semibold text-black hover:bg-spark-200 transition-colors"
          >
            Apply
            <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
          </a>
        </div>
      </nav>
    </motion.header>
  );
}
