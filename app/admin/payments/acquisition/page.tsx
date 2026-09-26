import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Campaign payments · Admin" };

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export default async function CampaignPaymentsPage() {
  const admin = createAdminClient();
  const [{ data: rows, error }, { data: cohorts, error: cohortError }] = await Promise.all([
    admin.from("campaign_attribution_report").select("*").order("campaign"),
    admin.from("cohorts").select("id,name"),
  ]);
  if (error || cohortError) throw new Error("Campaign report unavailable. Check campaign attribution migration 0086 and database access.");
  const cohortNames = new Map((cohorts ?? []).map(c => [c.id, c.name]));
  return <div className="mx-auto max-w-6xl">
    <Link href="/admin/payments" className="text-sm text-ink-soft underline">← Payments</Link>
    <h1 className="mt-4 font-display text-3xl font-bold text-ink">Campaign payments</h1>
    <p className="mt-2 text-sm text-ink-soft">First tagged Google Search visit before an application was created. Parent payments follow the application, including payments made on another device.</p>
    <Card className="mt-6 overflow-x-auto">
      {!rows?.length ? <p className="text-sm text-ink-soft">No applications from tagged Search visits yet. Historical and untagged applications are not assigned to a campaign.</p> :
        <table className="w-full text-sm text-left">
          <thead><tr className="border-b border-line text-ink-soft">
            {["Campaign / cohort", "Started", "Submitted", "Paid applications", "Captured", "Refunded", "After refunds"].map(label => <th key={label} className="p-3">{label}</th>)}
          </tr></thead>
          <tbody>{rows.map(row => <tr key={`${row.campaign}:${row.cohort_id ?? "none"}`} className="border-b border-line text-ink">
            <td className="p-3"><div>{row.campaign}</div><div className="text-xs text-ink-faint">{cohortNames.get(row.cohort_id) ?? "Cohort not chosen"} · {row.source} / {row.medium}</div></td>
            <td className="p-3">{row.applications_started}</td><td className="p-3">{row.applications_submitted}</td><td className="p-3">{row.paid_applications}</td>
            <td className="p-3">{money(Number(row.captured_cents))}</td><td className="p-3">{money(Number(row.refunded_cents))}</td><td className="p-3">{money(Number(row.retained_cents))}</td>
          </tr>)}</tbody>
        </table>}
    </Card>
    <p className="mt-4 text-sm text-ink-soft">Amounts are verified USD tuition payments, using the amount actually charged after discounts. Refunds reduce retained tuition; a fully refunded or free place is not counted as a paid application. Totals are before payment fees and teaching costs.</p>
    <p className="mt-2 text-sm text-ink-soft">Compare tuition after refunds with actual campaign spend in Google Ads. Cost per paid application = spend ÷ paid applications. Applications, clicks, and open checkouts are not purchases.</p>
    {(rows ?? []).some(row => Number(row.other_currency_payments) > 0) && <p className="mt-2 text-sm text-amber-700">This campaign also has non-USD payments, excluded from these USD totals. Review Payments for those transactions.</p>}
    <p className="mt-2 text-xs text-ink-faint">This is first-party source attribution, not proof that the ad caused a sale. It cannot connect an ad visit on one device with an application begun independently on another. Families can share the original tagged program link. No student identity or payment result is uploaded to an ad platform by this feature.</p>
  </div>;
}
