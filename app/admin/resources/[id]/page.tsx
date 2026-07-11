import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { ResourceForm } from "../resource-form";

export const metadata = { title: "Edit resource · Admin" };

export default async function EditResourcePage({
  params,
}: {
  params: { id: string };
}) {
  const admin = createAdminClient();
  const [{ data: resource }, { data: cohorts }] = await Promise.all([
    admin
      .from("resources")
      .select("*")
      .eq("id", params.id)
      .maybeSingle(),
    admin.from("cohorts").select("id, name").order("starts_on"),
  ]);
  if (!resource) notFound();

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href="/admin/resources"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Resources
      </Link>
      <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] text-ink">Edit resource</h1>
      <Card className="mt-6">
        <ResourceForm
          initial={{
            id: resource.id,
            cohort_id: resource.cohort_id,
            category: resource.category,
            title: resource.title,
            description: resource.description,
            storage_path: resource.storage_path,
            external_url: resource.external_url,
            size_bytes: resource.size_bytes,
            mime_type: resource.mime_type,
          }}
          cohorts={cohorts ?? []}
        />
      </Card>
    </div>
  );
}
