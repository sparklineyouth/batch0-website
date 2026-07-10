import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { ChargePayButton } from "@/components/charge-pay-button";
import { AlertTriangle } from "lucide-react";

export const metadata = { title: "Outstanding fine · SparkLine Youth" };

export default async function PayFinePage() {
  const user = await requireUser();
  const supabase = createClient();
  const { data: fines } = await supabase
    .from("user_charges")
    .select("*")
    .eq("user_id", user.id)
    .eq("kind", "fine")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (!fines || fines.length === 0) {
    redirect("/dashboard");
  }

  const total = fines.reduce(
    (s: number, f: any) => s + (f.amount_cents ?? 0),
    0,
  );

  return (
    <div className="min-h-screen bg-black">
      <div className="mx-auto max-w-2xl px-6 py-20">
        <div className="mb-6 flex items-center gap-2 text-spark">
          <AlertTriangle className="h-5 w-5" />
          <span className="text-xs font-semibold uppercase tracking-[0.2em]">
            Account paused
          </span>
        </div>
        <h1 className="text-3xl font-bold tracking-tight">
          Resolve your outstanding fine{fines.length > 1 ? "s" : ""}
        </h1>
        <p className="mt-2 text-sm text-white/60">
          Your access is paused until the {fines.length > 1 ? "fines below are" : "fine below is"} paid or waived by an admin.
          Email{" "}
          <a
            href="mailto:sparklineyouth@gmail.com"
            className="text-spark hover:underline"
          >
            sparklineyouth@gmail.com
          </a>{" "}
          if you think this is wrong.
        </p>

        <div className="mt-8 space-y-3">
          {fines.map((f: any) => (
            <Card
              key={f.id}
              className="border-red-400/30 bg-red-400/5"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-wider text-red-300">
                    Fine
                  </div>
                  <h3 className="mt-1 text-base font-semibold">
                    {f.description}
                  </h3>
                  <p className="mt-1 text-xs text-white/45">
                    Issued <LocalTime value={f.created_at} />
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold text-spark">
                    ${(f.amount_cents / 100).toFixed(2)}
                  </div>
                </div>
              </div>
              <div className="mt-4 flex justify-end">
                <ChargePayButton chargeId={f.id} />
              </div>
            </Card>
          ))}
        </div>

        <div className="mt-6 flex items-center justify-between text-sm">
          <span className="text-white/50">Total outstanding</span>
          <span className="text-xl font-bold text-spark">
            ${(total / 100).toFixed(2)}
          </span>
        </div>

        <div className="mt-12 flex items-center justify-between text-xs text-white/40">
          <Link href="/dashboard/billing" className="hover:text-white">
            Billing history
          </Link>
          <form action="/auth/signout" method="post">
            <button type="submit" className="hover:text-white">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
