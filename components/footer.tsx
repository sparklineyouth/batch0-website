import React from "react";
import Image from "next/image";
import Link from "next/link";

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
              <a
                href="#how-it-works"
                className="rounded hover:text-spark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spark"
              >
                How it works
              </a>
            </li>
            <li>
              <a
                href="#curriculum"
                className="rounded hover:text-spark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spark"
              >
                Curriculum
              </a>
            </li>
            <li>
              <a
                href="#compare"
                className="rounded hover:text-spark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spark"
              >
                Why SparkLine
              </a>
            </li>
            <li>
              <Link
                href="/apply"
                className="rounded hover:text-spark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spark"
              >
                Apply
              </Link>
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
                href="mailto:sparkline.youth@gmail.com"
                className="rounded hover:text-spark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spark"
              >
                sparkline.youth@gmail.com
              </a>
            </li>
            <li>
              <Link
                href="/login"
                className="rounded hover:text-spark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spark"
              >
                Log in
              </Link>
            </li>
            <li>
              <Link
                href="/apply"
                className="rounded hover:text-spark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spark"
              >
                Apply
              </Link>
            </li>
          </ul>
        </div>
      </div>

      <div className="mx-auto max-w-6xl mt-14 flex flex-col md:flex-row items-center justify-between gap-3 border-t border-white/5 pt-6 text-xs text-white/40">
        <span>© {new Date().getFullYear()} SparkLine. All rights reserved.</span>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <a
            href="/terms"
            className="rounded hover:text-spark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spark"
          >
            Terms
          </a>
          <a
            href="/privacy"
            className="rounded hover:text-spark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spark"
          >
            Privacy
          </a>
          <a
            href="/refund-policy"
            className="rounded hover:text-spark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spark"
          >
            Refunds
          </a>
        </div>
      </div>
    </footer>
  );
}
