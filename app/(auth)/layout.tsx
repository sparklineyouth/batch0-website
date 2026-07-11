import Link from "next/link";
import Image from "next/image";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  // Theme follows the site-wide next-themes value (see ThemeProvider): in
  // light mode the compat layer in globals.css flips the dark-authored form
  // components to the light palette; in dark mode they render natively. The
  // auth funnel and marketing surface stay one continuous, themeable site.
  return (
    <div className="min-h-screen bg-paper">
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
        <Link href="/" className="mb-8 flex items-center gap-2">
          <Image src="/logo.svg" alt="" width={24} height={24} />
          <span className="font-display text-[15px] font-bold tracking-tight text-ink">
            Sparkline Youth
          </span>
        </Link>
        <div className="w-full rounded-md border border-line bg-paper p-7">
          {children}
        </div>
      </div>
    </div>
  );
}
