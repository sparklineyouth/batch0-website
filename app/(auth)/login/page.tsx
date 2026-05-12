import Link from "next/link";
import { LoginForm } from "./login-form";

export const metadata = { title: "Log in · SparkLine" };

/**
 * Same-origin "next" gate. Mirrors `safeNext` in app/auth/callback/route.ts;
 * keeps an attacker from coaxing the user to /login?next=https://evil.com
 * and turning the post-login redirect into an open redirect.
 */
function safeNext(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  return raw;
}

export default function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string; error?: string };
}) {
  const safe = safeNext(searchParams.next);
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-white">Welcome back</h1>
      <p className="mt-1 text-sm text-white/50">
        Log in to continue your SparkLine journey.
      </p>
      <LoginForm next={safe} initialError={searchParams.error} />
      <p className="mt-6 text-center text-sm text-white/50">
        New here?{" "}
        <Link href="/signup" className="text-spark hover:underline">
          Create an account
        </Link>
      </p>
      <p className="mt-2 text-center text-xs text-white/40">
        <Link href="/forgot-password" className="hover:text-white/70">
          Forgot your password?
        </Link>
      </p>
    </div>
  );
}
