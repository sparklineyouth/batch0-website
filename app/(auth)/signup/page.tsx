import Link from "next/link";
import { SignupForm } from "./signup-form";
import { getSiteConfig } from "@/lib/site-config";

export const metadata = {
  title: "Apply — Create Your Account · Sparkline Youth",
  description:
    "Step 1 of applying to Sparkline Youth: create your free account, then fill in the application. Free to apply; tuition is charged only if accepted.",
};

// Mirrors safeNext in app/(auth)/login/page.tsx — same-origin paths only,
// so a tampered ?next= can't trampoline the user off-site after signup.
function safeNext(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  return raw;
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  const safe = safeNext(searchParams.next);
  const loginHref = safe ? `/login?next=${encodeURIComponent(safe)}` : "/login";
  const config = await getSiteConfig();
  const { derived } = config;
  const isApplyFlow = !safe || safe === "/apply" || safe.startsWith("/apply?");

  return (
    <div>
      {isApplyFlow ? (
        <>
          <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-white/55">
            Apply · step 1 of 2
          </p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-white">
            Create your account
          </h1>
          <p className="mt-2 text-sm leading-[1.6] text-white/50">
            The application itself is step 2 — one form about you and what
            you want to build. Applying is free;{" "}
            {derived.priceLabel} tuition is charged only if you&apos;re
            accepted. Decisions go out by email on a rolling basis.
          </p>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Create your account
          </h1>
          <p className="mt-1 text-sm text-white/50">
            Sign up for Sparkline Youth. Takes 30 seconds.
          </p>
        </>
      )}
      <SignupForm next={safe} />
      <p className="mt-6 text-center text-sm text-white/50">
        Already have an account?{" "}
        <Link href={loginHref} className="text-spark hover:underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
