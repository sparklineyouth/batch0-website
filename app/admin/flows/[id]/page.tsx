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
  // Steps filter on the same id the flow row is looked up by, so all three
  // reads run together — a missing flow just yields zero steps and 404s.
  const [{ data: flow }, { data: cohorts }, { data: steps }] =
    await Promise.all([
      admin.from("flows").select("*").eq("id", params.id).maybeSingle(),
      admin.from("cohorts").select("id, name").order("starts_on"),
      admin
        .from("flow_steps")
        .select("step_key, title, kind, body, config, sort_order")
        .eq("flow_id", params.id)
        .order("sort_order"),
    ]);
  if (!flow) notFound();

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
