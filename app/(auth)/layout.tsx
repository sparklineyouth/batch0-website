import Link from "next/link";
import { Wordmark } from "@/components/wordmark";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  // Flat-black dark-only; the auth funnel shares the marketing surface's dark
  // tokens so the two read as one continuous site.
  return (
    <div className="min-h-screen bg-paper">
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
        <Link href="/" className="mb-8 flex items-center gap-2">
          <Wordmark className="h-5 text-ink" />
        </Link>
        <div className="w-full rounded-md border border-line bg-paper p-7">
          {children}
        </div>
      </div>
    </div>
  );
}
