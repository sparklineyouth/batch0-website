import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { ResourceForm } from "../resource-form";

export const metadata = { title: "New resource · Admin" };

export default async function NewResourcePage() {
  const admin = createAdminClient();
  const { data: cohorts } = await admin
    .from("cohorts")
    .select("id, name")
    .order("starts_on");

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href="/admin/resources"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Resources
      </Link>
      <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] text-ink">New resource</h1>
      <Card className="mt-6">
        <ResourceForm
          initial={{
            cohort_id: null,
            category: "general",
            title: "",
            description: "",
            storage_path: null,
            external_url: null,
            size_bytes: null,
            mime_type: null,
            pre_cohort: false,
          }}
          cohorts={cohorts ?? []}
        />
      </Card>
    </div>
  );
}
