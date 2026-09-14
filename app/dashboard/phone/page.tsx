import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { PhoneForm } from "./phone-form";

export const metadata = { title: "Your phone number · batch0" };

/**
 * Where the "we need your phone number" email lands accepted students who
 * applied before the form asked for one. Reading their own application is fine
 * under RLS; the write goes through the service-role client in the action
 * (see ./actions), because a student can't self-update a non-draft row.
 */
export default async function PhonePage() {
  const user = await requireUser();
  const supabase = createClient();

  const { data: app } = await supabase
    .from("applications")
    .select("id, phone")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const currentPhone = app?.phone ?? "";

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <h1 className="text-2xl font-bold tracking-tight text-ink">
        Your phone number
      </h1>
      <p className="mt-2 text-sm text-ink-soft">
        We collect a phone number for everyone in the program so we can reach
        you about kickoff logistics and anything time-sensitive. It's only used
        to run the program — never shared or sold. See our{" "}
        <Link href="/privacy" className="text-phosphor-ink underline">
          Privacy Policy
        </Link>
        .
      </p>

      <Card className="mt-6 p-5 sm:p-6">
        {app ? (
          <>
            {currentPhone && (
              <p className="text-sm text-ink-soft">
                We currently have{" "}
                <span className="font-medium text-ink">{currentPhone}</span> on
                file. You can update it below.
              </p>
            )}
            <PhoneForm initialPhone={currentPhone} />
          </>
        ) : (
          <p className="text-sm text-ink-soft">
            We couldn't find an application on your account, so there's nothing
            to attach a number to yet.{" "}
            <Link href="/apply" className="text-phosphor-ink underline">
              Apply here
            </Link>{" "}
            and the form will ask for your phone number.
          </p>
        )}
      </Card>
    </div>
  );
}
