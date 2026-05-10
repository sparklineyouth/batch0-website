import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { SettingsForm } from "./settings-form";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Settings · SparkLine" };

export default async function SettingsPage() {
  const user = await requireUser();
  const supabase = createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-white/50">
        Update your profile and account details.
      </p>

      <Card className="mt-8">
        <SettingsForm
          initialFullName={profile?.full_name ?? ""}
          email={user.email ?? ""}
        />
      </Card>
    </div>
  );
}
