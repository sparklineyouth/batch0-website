import Link from "next/link";
import { Wordmark } from "@/components/wordmark";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  // Theme follows the site-wide next-themes value (see ThemeProvider): in
  // light mode the compat layer in globals.css flips the dark-authored form
  // components to the light palette; in dark mode they render natively. The
  // auth funnel and marketing surface stay one continuous, themeable site.
  //
  // Same header bar and open, left-aligned column as /apply
  // (app/apply/apply-flow.tsx) rather than a boxed card: signing up is step 1
  // of applying for most people who land here, and the two should read as
  // one flow.
  return (
    <div className="flex min-h-[100dvh] flex-col bg-paper">
      <header className="border-b border-line">
        <div className="mx-auto flex h-14 max-w-5xl items-center px-5 sm:px-8">
          <Link href="/" aria-label="batch0 home" className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor">
            <Wordmark className="h-4 text-ink" />
          </Link>
        </div>
      </header>
      <div className="flex flex-1 items-start sm:items-center">
        <div className="mx-auto w-full max-w-md px-5 py-12 sm:px-6 sm:py-16">{children}</div>
      </div>
    </div>
  );
}
