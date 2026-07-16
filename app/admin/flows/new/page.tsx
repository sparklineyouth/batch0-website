import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { FlowBuilder } from "../flow-builder";

export const metadata = { title: "New flow · Admin" };

export default async function NewFlowPage() {
  const admin = createAdminClient();
  const { data: cohorts } = await admin
    .from("cohorts")
    .select("id, name")
    .order("starts_on");

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/admin/flows"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Pre-cohort flows
      </Link>
      <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        New flow
      </h1>
      <div className="mt-6">
        <FlowBuilder
          initial={{
            slug: "",
            title: "",
            tagline: null,
            stage: "explore",
            status: "draft",
            est_minutes: null,
            sort_order: 0,
            cohort_id: null,
          }}
          initialSteps={[]}
          cohorts={cohorts ?? []}
        />
      </div>
    </div>
  );
}
