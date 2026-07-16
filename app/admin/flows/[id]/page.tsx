import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import type { FlowStepData } from "@/lib/flows";
import { FlowBuilder } from "../flow-builder";

export const metadata = { title: "Edit flow · Admin" };

export default async function EditFlowPage({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();
  const [{ data: flow }, { data: cohorts }] = await Promise.all([
    admin.from("flows").select("*").eq("id", params.id).maybeSingle(),
    admin.from("cohorts").select("id, name").order("starts_on"),
  ]);
  if (!flow) notFound();

  const { data: steps } = await admin
    .from("flow_steps")
    .select("step_key, title, kind, body, config, sort_order")
    .eq("flow_id", flow.id)
    .order("sort_order");

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/admin/flows"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Pre-cohort flows
      </Link>
      <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        Edit flow
      </h1>
      <div className="mt-6">
        <FlowBuilder
          initial={{
            id: flow.id,
            slug: flow.slug,
            title: flow.title,
            tagline: flow.tagline,
            stage: flow.stage,
            status: flow.status,
            est_minutes: flow.est_minutes,
            sort_order: flow.sort_order,
            cohort_id: flow.cohort_id,
          }}
          initialSteps={(steps ?? []) as FlowStepData[]}
          cohorts={cohorts ?? []}
        />
      </div>
    </div>
  );
}
