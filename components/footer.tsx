import React from "react";
import Image from "next/image";
import Link from "next/link";
import { getSiteConfig, type SiteConfig } from "@/lib/site-config";

// Footer can take an explicit config (lets a page render in a single
// pass without re-querying) or self-resolve when used inside a layout
// that doesn't already have one.
export default async function Footer({ config }: { config?: SiteConfig }) {
  const resolved = config ?? (await getSiteConfig());
  const contactEmail = resolved.settings.contactEmail;
  return (
    <footer className="relative border-t border-white/10 px-5 sm:px-6 py-12 sm:py-14 pb-safe">
      <div className="mx-auto max-w-6xl grid gap-8 sm:gap-10 sm:grid-cols-2 md:grid-cols-4">
        <div className="md:col-span-2">
          <div className="flex items-center gap-2.5">
            <Image src="/logo.svg" alt="SparkLine Youth" width={28} height={28} />
            <span className="text-lg font-semibold tracking-tight text-white">
              Spark<span className="text-spark">Line</span> Youth
            </span>
          </div>
          <p className="mt-4 max-w-sm text-sm text-white/70 leading-relaxed">
            A 4-week, fully virtual entrepreneurship program for U.S.
            high schoolers. Curriculum, mentor support, and a live pitch
            in front of our investor network. Optional sponsorship for
            standouts — zero equity, ever. Funding is never guaranteed.
          </p>
          <p className="mt-5 text-xs text-white/55">
            sparklineyouth.org
          </p>
        </div>

        <div>
          <div className="text-xs uppercase tracking-widest text-white/55">
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
                Why SparkLine Youth
              </a>
            </li>
            <li>
              <Link
                href="/sponsors"
                className="rounded hover:text-spark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spark"
              >
                Sponsors
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

        <div>
          <div className="text-xs uppercase tracking-widest text-white/55">
            Connect
          </div>
          <ul className="mt-4 space-y-2.5 text-sm text-white/70">
            <li>
              <a
                href={`mailto:${contactEmail}`}
                className="rounded hover:text-spark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spark"
              >
                {contactEmail}
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

      <div className="mx-auto max-w-6xl mt-12 sm:mt-14 flex flex-col md:flex-row items-center justify-between gap-3 border-t border-white/5 pt-6 text-xs text-white/55">
        <span>© {new Date().getFullYear()} SparkLine Youth. All rights reserved.</span>
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
