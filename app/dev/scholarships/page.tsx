import { notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { ScholarshipForm } from "@/app/admin/scholarships/scholarship-form";
import {
  emptyScholarshipForm,
  scholarshipToForm,
} from "@/app/admin/scholarships/form-values";

/**
 * Interface preview for the scholarship form.
 *
 * The real page (/admin/scholarships/new) needs a signed-in admin and a
 * database; this renders the same client component twice — once empty, once
 * seeded the way the edit page seeds it from a row carrying every perk — so
 * the "What it's worth" section (money tick, perk checkboxes, "how many",
 * the reads-as line) can be reviewed without any of that. Save still calls
 * the real server action, which refuses without the permission.
 *
 * Gated on VERCEL_ENV exactly like app/dev/live, and for the same reason: it
 * renders on localhost and on branch previews, and 404s on the live site.
 */
export const metadata = {
  title: "Scholarship form preview · batch0",
  robots: { index: false, follow: false },
};

export default function ScholarshipFormPreviewPage() {
  if (process.env.VERCEL_ENV === "production") notFound();

  const seeded = scholarshipToForm({
    id: "00000000-0000-0000-0000-000000000000",
    slug: "builders-grant",
    name: "Builder's grant",
    kind: "merit",
    tagline: "For students who ship.",
    description: null,
    terms: {
      amountCents: 0,
      percent: 25,
      perks: { mentorCalls: 3, feedbackCredits: 1, demoDayTickets: 2, aiBoost: true },
    },
    seats: 5,
    opensAt: null,
    closesAt: null,
    eligibleStages: ["accepted", "enrolled"],
    enabled: true,
    sortIndex: 100,
  });

  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <p className="mb-6 rounded-lg border border-amber-400/40 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
        Preview. Saving is refused without an admin session — this page is for
        looking at the form, not using it.
      </p>

      <h2 className="mb-3 text-sm font-semibold text-ink">New scholarship (empty)</h2>
      <Card>
        <ScholarshipForm initial={emptyScholarshipForm()} />
      </Card>

      <h2 className="mb-3 mt-10 text-sm font-semibold text-ink">
        Editing one that carries money and every perk
      </h2>
      <Card>
        <ScholarshipForm initial={seeded} />
      </Card>
    </main>
  );
}
