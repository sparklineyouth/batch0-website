import Link from "next/link";
import { LoginForm } from "./login-form";

export const metadata = { title: "Log in · SparkLine" };

export default function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string; error?: string };
}) {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-white">Welcome back</h1>
      <p className="mt-1 text-sm text-white/50">
        Log in to continue your SparkLine journey.
      </p>
      <LoginForm next={searchParams.next} initialError={searchParams.error} />
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
