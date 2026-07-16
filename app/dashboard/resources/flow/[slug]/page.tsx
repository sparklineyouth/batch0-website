import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser, getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getStudentAccess } from "@/lib/access";
import { isAcceptedStatus } from "@/lib/pre-cohort";
import { renderMarkdown } from "@/lib/blog";
import type { FlowStepData, StepConfig } from "@/lib/flows";
import { FlowPlayer, type CompiledStep } from "./flow-player";

export const metadata = { title: "Before One · batch0" };

export default async function FlowPage({
  params,
}: {
  params: { slug: string };
}) {
  const user = await requireUser();
  const profile = await getProfile();
  const access = await getStudentAccess(profile?.role ?? "student");
  const accepted = isAcceptedStatus(access.applicationStatus);
  const fullAccess = access.enrolled && !access.preCohort;
  // Same audience as the resources hub: accepted or enrolled (admins count
  // as enrolled via getStudentAccess, so they can preview — RLS additionally
  // lets staff open drafts).
  if (!fullAccess && !accepted) redirect("/dashboard/resources");

  const supabase = createClient();
  const { data: flow } = await supabase
    .from("flows")
    .select("id, slug, title, tagline, stage, status, est_minutes")
    .eq("slug", params.slug)
    .maybeSingle();
  if (!flow) notFound();

  const [{ data: steps }, { data: progress }] = await Promise.all([
    supabase
      .from("flow_steps")
      .select("step_key, title, kind, body, config, sort_order")
      .eq("flow_id", flow.id)
      .order("sort_order"),
    supabase
      .from("flow_progress")
      .select("answers, current_step, completed_at")
      .eq("flow_id", flow.id)
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);
  if (!steps?.length) notFound();

  // Compile all markdown server-side (the player is a client component and
  // shouldn't ship a markdown pipeline). {{placeholders}} pass through as
  // plain text; the player substitutes escaped answers into the HTML.
  const compiled: CompiledStep[] = await Promise.all(
    (steps as FlowStepData[]).map(async (s) => {
      const config = (s.config ?? {}) as StepConfig;
      return {
        step_key: s.step_key,
        title: s.title,
        kind: s.kind,
        config,
        sort_order: s.sort_order,
        bodyHtml: s.body ? await renderMarkdown(s.body) : null,
        blocks: config.blocks
          ? await Promise.all(
              config.blocks.map(async (b) => ({
                when: b.when,
                title: b.title,
                body: b.body,
                bodyHtml: await renderMarkdown(b.body),
              })),
            )
          : null,
      };
    }),
  );

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/dashboard/resources"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Resources
      </Link>
      {flow.status !== "published" && (
        <p className="mt-3 inline-block rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
          {flow.status === "draft" ? "Draft preview" : "Archived"} — students
          can't see this flow.
        </p>
      )}
      <FlowPlayer
        flowId={flow.id}
        title={flow.title}
        tagline={flow.tagline}
        estMinutes={flow.est_minutes}
        steps={compiled}
        initialAnswers={(progress?.answers as any) ?? {}}
        initialStep={progress?.current_step ?? null}
        initiallyCompleted={!!progress?.completed_at}
      />
    </div>
  );
}
