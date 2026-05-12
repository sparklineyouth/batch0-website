import React from "react";
import Image from "next/image";

export default function Navbar() {
  const links = [
    { href: "#how-it-works", label: "Program" },
    { href: "#curriculum", label: "Curriculum" },
    { href: "#compare", label: "Why SparkLine" },
    { href: "#faq", label: "FAQ" },
  ];

  return (
    <header className="fixed top-0 inset-x-0 z-50 px-4 pt-4 animate-slide-down">
      <nav className="mx-auto max-w-6xl flex items-center justify-between rounded-2xl border border-white/10 bg-black/50 backdrop-blur-xl px-4 py-2.5">
        <a href="/" className="flex items-center gap-2.5 press rounded-lg">
          <Image src="/logo.svg" alt="SparkLine" width={28} height={28} priority />
          <span className="text-white font-semibold tracking-tight text-lg">
            Spark<span className="text-spark">Line</span>
          </span>
        </a>
        <ul className="hidden md:flex items-center gap-7 text-sm text-white/70">
          {links.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                className="press rounded px-1 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spark"
              >
                {l.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3">
          <a
            href="/login"
            className="press hidden sm:inline-block text-sm text-white/60 hover:text-white rounded px-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spark"
          >
            Log in
          </a>
          <a
            href="/apply"
            className="press group relative inline-flex items-center gap-1.5 rounded-full bg-spark px-4 py-2 text-sm font-semibold text-black hover:bg-spark-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spark"
          >
            Apply
            <span aria-hidden className="transition-transform duration-100 group-hover:translate-x-0.5">→</span>
          </a>
        </div>
      </nav>
    </header>
  );
}
