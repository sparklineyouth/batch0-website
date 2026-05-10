import Link from "next/link";
import { SignupForm } from "./signup-form";

export const metadata = { title: "Sign up · SparkLine" };

export default function SignupPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-white">Create your account</h1>
      <p className="mt-1 text-sm text-white/50">
        Sign up to apply for SparkLine. Takes 30 seconds.
      </p>
      <SignupForm />
      <p className="mt-6 text-center text-sm text-white/50">
        Already have an account?{" "}
        <Link href="/login" className="text-spark hover:underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
