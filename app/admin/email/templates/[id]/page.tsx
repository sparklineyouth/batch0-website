import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTemplateById } from "@/lib/email/store";
import { TemplateEditor, type VersionSummary } from "../template-editor";
import type { TemplateInput } from "../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { id: string } }) {
  const t = await getTemplateById(params.id);
  return { title: t ? `${t.name} · Email templates · Admin` : "Email template · Admin" };
}

export default async function EmailTemplatePage({
  params,
}: {
  params: { id: string };
}) {
  const t = await getTemplateById(params.id);
  if (!t) notFound();

  const admin = createAdminClient();
  const [{ data: versions }, { count: usedBy }] = await Promise.all([
    admin
      .from("email_template_versions")
      .select("id, version, created_at")
      .eq("template_id", t.id)
      .order("version", { ascending: false })
      // Ten is enough to undo a bad session. Beyond that the history is
      // archaeology, and the panel would need paging it doesn't earn.
      .limit(10),
    admin
      .from("email_automation_steps")
      .select("id", { count: "exact", head: true })
      .eq("template_id", t.id),
  ]);

  const initial: TemplateInput = {
    id: t.id,
    key: t.key,
    name: t.name,
    description: t.description ?? "",
    category: t.category,
    subject: t.subject,
    preheader: t.preheader ?? "",
    bodyHtml: t.body_html,
    ctaLabel: t.cta_label ?? "",
    ctaUrl: t.cta_url ?? "",
    fromName: t.from_name ?? "",
    fromEmail: t.from_email ?? "",
    replyTo: t.reply_to ?? "",
    variables: t.variables ?? [],
    enabled: t.enabled,
  };

  return (
    <TemplateEditor
      initial={initial}
      isSystem={t.is_system}
      versions={(versions ?? []) as VersionSummary[]}
      usedByAutomations={usedBy ?? 0}
    />
  );
}
