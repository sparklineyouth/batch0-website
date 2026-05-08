"use client";
import React from "react";
import Image from "next/image";

export default function Footer() {
  return (
    <footer className="relative border-t border-white/10 px-6 py-14">
      <div className="mx-auto max-w-6xl grid gap-10 md:grid-cols-4">
        <div className="md:col-span-2">
          <div className="flex items-center gap-2.5">
            <Image src="/logo.svg" alt="SparkLine" width={28} height={28} />
            <span className="text-lg font-semibold tracking-tight text-white">
              Spark<span className="text-spark">Line</span>
            </span>
          </div>
          <p className="mt-4 max-w-sm text-sm text-white/50 leading-relaxed">
            The 4-week, fully virtual startup accelerator for high schoolers.
            Build real. Pitch real. Get funded — before graduation.
          </p>
          <p className="mt-4 text-xs text-white/30">
            sparklineyouth.org · Plainsboro, NJ
          </p>
        </div>

        <div>
          <div className="text-xs uppercase tracking-widest text-white/40">
            Program
          </div>
          <ul className="mt-4 space-y-2.5 text-sm text-white/70">
            <li>
              <a href="#how-it-works" className="hover:text-spark">
                How it works
              </a>
            </li>
            <li>
              <a href="#curriculum" className="hover:text-spark">
                Curriculum
              </a>
            </li>
            <li>
              <a href="#compare" className="hover:text-spark">
                Why SparkLine
              </a>
            </li>
            <li>
              <a href="#apply" className="hover:text-spark">
                Apply
              </a>
            </li>
          </ul>
        </div>

        <div>
          <div className="text-xs uppercase tracking-widest text-white/40">
            Connect
          </div>
          <ul className="mt-4 space-y-2.5 text-sm text-white/70">
            <li>
              <a
                href="mailto:hello@sparklineyouth.org"
                className="hover:text-spark"
              >
                hello@sparklineyouth.org
              </a>
            </li>
            <li>
              <a href="#" className="hover:text-spark">
                Instagram
              </a>
            </li>
            <li>
              <a href="#" className="hover:text-spark">
                TikTok
              </a>
            </li>
            <li>
              <a href="#" className="hover:text-spark">
                Discord
              </a>
            </li>
          </ul>
        </div>
      </div>

      <div className="mx-auto max-w-6xl mt-14 flex flex-col md:flex-row items-center justify-between gap-3 border-t border-white/5 pt-6 text-xs text-white/40">
        <span>© {new Date().getFullYear()} SparkLine. All rights reserved.</span>
        <span>Built by high schoolers, for high schoolers.</span>
      </div>
    </footer>
  );
}
