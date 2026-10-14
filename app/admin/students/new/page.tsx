import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { CreatePersonForm } from "./create-person-form";

export const metadata = { title: "Add a person · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminNewPersonPage() {
  // People-manage, not people-view: this creates accounts and enrolments. The
  // server action re-checks the same permission.
  await requirePermission("people.manage");
  const admin = createAdminClient();

  const { data: cohorts } = await admin
    .from("cohorts")
    .select("id, name, status")
    .order("starts_on", { ascending: true });

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href="/admin/students"
        className="text-sm text-ink-faint hover:text-ink"
      >
        ← People
      </Link>

      <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        Add a person
      </h1>

      <Card className="mt-6">
        <CreatePersonForm cohorts={cohorts ?? []} />
      </Card>
    </div>
  );
}
