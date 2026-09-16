import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { ScholarshipForm } from "../scholarship-form";
import { emptyScholarshipForm } from "../form-values";

export const metadata = { title: "New scholarship · Admin" };
export const dynamic = "force-dynamic";

export default async function NewScholarshipPage() {
  // `scholarships.view` opens the route (see ADMIN_ROUTE_PERMISSIONS); the
  // save action re-asserts `scholarships.manage`, which is what actually
  // authorizes creating one.
  await requirePermission("scholarships.manage");

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href="/admin/scholarships"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Scholarships
      </Link>
      <h1 className="mt-4 text-3xl font-bold tracking-tight">New scholarship</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Its extra questions are added after it exists — save this first.
      </p>
      <Card className="mt-6">
        <ScholarshipForm initial={emptyScholarshipForm()} />
      </Card>
    </div>
  );
}
