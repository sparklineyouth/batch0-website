import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { ApplicationForm } from "./application-form";

export const metadata = { title: "Apply · SparkLine" };

export default async function ApplyPage() {
  const user = await requireUser();
  const supabase = createClient();

  const { data: existing } = await supabase
    .from("applications")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // If they already submitted/accepted/paid, redirect them to the dashboard view
  if (existing && existing.status !== "draft") {
    redirect("/dashboard/application");
  }

  return (
    <div className="min-h-screen bg-black">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[40rem] bg-spark-radial opacity-50"
      />
      <div className="relative mx-auto max-w-3xl px-6 py-16">
        <div className="mb-8">
          <Link href="/dashboard" className="text-sm text-white/50 hover:text-white">
            ← Dashboard
          </Link>
        </div>
        <h1 className="text-4xl font-bold tracking-tight text-white">
          Apply to SparkLine
        </h1>
        <p className="mt-3 max-w-2xl text-white/60">
          Cohort 1 (Summer 2026) is capped at 24 students. Applications are reviewed on a rolling basis. After your application is accepted, you'll pay $97 to lock in your seat.
        </p>
        <div className="mt-10">
          <ApplicationForm
            defaults={existing ?? null}
            email={user.email ?? ""}
          />
        </div>
      </div>
    </div>
  );
}
