"use client";

import { useEffect } from "react";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="min-h-[60vh] px-6 py-24">
      <div className="mx-auto max-w-md text-center">
        <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-phosphor">
          Something broke
        </p>
        <h1 className="mt-3 text-3xl font-bold tracking-[-0.02em] md:text-4xl">
          We hit a snag.
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-white/70">
          The page failed to load. The error has been reported — try again,
          or head back home.
        </p>
        {error.digest && (
          <p className="mt-4 break-all rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-white/50">
            Reference: <span className="text-white/80">{error.digest}</span>
          </p>
        )}
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={reset}
            className="press rounded-md bg-phosphor px-4 py-2.5 text-sm font-semibold text-black hover:bg-phosphor-200"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-md border border-white/15 px-4 py-2.5 text-sm font-medium text-white/80 hover:bg-white/[0.04]"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
