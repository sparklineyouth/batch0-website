import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProfile } from "@/lib/auth";
import { Card, StatusBadge } from "@/components/ui/card";
import { RoleSelect } from "../role-select";
import { ManagePanel } from "./manage-panel";
import { discordAvatarUrl } from "@/lib/discord";
import type { Role } from "@/lib/types";

export const metadata = { title: "Manage user · Admin" };

function fmtMoney(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

export default async function AdminStudentDetail({
  params,
}: {
  params: { id: string };
}) {
  const actor = await getProfile();
  const admin = createAdminClient();

  const [
    { data: profile },
    { data: applications },
    { data: enrollments },
    { data: payments },
    { data: cohorts },
    { data: charges },
  ] = await Promise.all([
    admin
      .from("profiles")
      .select("*")
      .eq("id", params.id)
      .maybeSingle(),
    admin
      .from("applications")
      .select("*, cohort:cohorts(name)")
      .eq("user_id", params.id)
      .order("created_at", { ascending: false }),
    admin
      .from("enrollments")
      .select("*, cohort:cohorts(id, name, starts_on, ends_on)")
      .eq("user_id", params.id)
      .order("enrolled_at", { ascending: false }),
    admin
      .from("payments")
      .select("*")
      .eq("user_id", params.id)
      .order("created_at", { ascending: false }),
    admin.from("cohorts").select("id, name").order("starts_on"),
    admin
      .from("user_charges")
      .select("*")
      .eq("user_id", params.id)
      .order("created_at", { ascending: false }),
  ]);

  if (!profile) notFound();

  const latestApp = (applications ?? [])[0] as any;
  const currentEnrollment = (enrollments ?? [])[0] as any;
  const hasRefundable = (payments ?? []).some(
    (p: any) => p.status === "succeeded" && p.stripe_payment_intent_id,
  );
  const pendingCharges = (charges ?? []).filter(
    (c: any) => c.status === "pending",
  );

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href="/admin/students"
        className="text-sm text-white/55 hover:text-white"
      >
        ← People
      </Link>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {profile.full_name || "—"}
          </h1>
          <p className="mt-1 text-sm text-white/55">{profile.email}</p>
          <p className="mt-1 text-xs text-white/40">
            Joined {new Date(profile.created_at).toLocaleDateString()} ·
            Referral code{" "}
            <span className="text-white/70">{profile.referral_code ?? "—"}</span>
            {profile.discord_user_id && (
              <>
                {" "}· Discord{" "}
                <span className="text-white/70">
                  @{profile.discord_username ?? profile.discord_user_id}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-white/40">
            Role
          </span>
          <RoleSelect userId={profile.id} role={profile.role as Role} />
        </div>
      </div>

      <Card className="mt-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/55">
          Snapshot
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Mini label="Latest application" value={latestApp?.status ?? "—"} />
          <Mini
            label="Current cohort"
            value={currentEnrollment?.cohort?.name ?? "—"}
          />
          <Mini
            label="Pending charges"
            value={pendingCharges.length.toString()}
          />
        </div>
      </Card>

      <Card className="mt-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/55">
          Manage
        </h2>
        <ManagePanel
          userId={profile.id}
          isSelf={actor?.id === profile.id}
          isAdminTarget={profile.role === "admin"}
          hasRefundable={hasRefundable}
          cohorts={(cohorts ?? []) as any}
          currentCohortId={
            currentEnrollment?.cohort_id ?? latestApp?.cohort_id ?? null
          }
        />
      </Card>

      <Card className="mt-6 !p-0 overflow-hidden">
        <div className="px-5 py-3 text-sm font-semibold uppercase tracking-wider text-white/55">
          Applications
        </div>
        {(applications?.length ?? 0) === 0 ? (
          <p className="px-5 pb-5 text-sm text-white/55">No applications.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-white/10 text-left text-xs uppercase tracking-wider text-white/40">
                <th className="px-5 py-2">Submitted</th>
                <th className="px-5 py-2">Cohort</th>
                <th className="px-5 py-2">Status</th>
                <th className="px-5 py-2">Fee waived</th>
                <th className="px-5 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {(applications ?? []).map((a: any) => (
                <tr
                  key={a.id}
                  className="border-b border-white/5 last:border-0"
                >
                  <td className="px-5 py-3 text-white/70">
                    {a.submitted_at
                      ? new Date(a.submitted_at).toLocaleString()
                      : "—"}
                  </td>
                  <td className="px-5 py-3 text-white/70">
                    {a.cohort?.name ?? "—"}
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge status={a.status} />
                  </td>
                  <td className="px-5 py-3 text-white/70">
                    {a.fee_waived ? "Yes" : "—"}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Link
                      href={`/admin/applications/${a.id}`}
                      className="text-xs text-spark hover:underline"
                    >
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="mt-6 !p-0 overflow-hidden">
        <div className="px-5 py-3 text-sm font-semibold uppercase tracking-wider text-white/55">
          Payments
        </div>
        {(payments?.length ?? 0) === 0 ? (
          <p className="px-5 pb-5 text-sm text-white/55">No payments.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-white/10 text-left text-xs uppercase tracking-wider text-white/40">
                <th className="px-5 py-2">Date</th>
                <th className="px-5 py-2">Amount</th>
                <th className="px-5 py-2">Status</th>
                <th className="px-5 py-2">Stripe intent</th>
              </tr>
            </thead>
            <tbody>
              {(payments ?? []).map((p: any) => (
                <tr
                  key={p.id}
                  className="border-b border-white/5 last:border-0"
                >
                  <td className="px-5 py-3 text-white/70">
                    {new Date(p.created_at).toLocaleString()}
                  </td>
                  <td className="px-5 py-3 text-white/80">
                    {fmtMoney(p.amount_cents, p.currency)}
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-5 py-3 text-xs text-white/40">
                    {p.stripe_payment_intent_id ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="mt-6 !p-0 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3">
          <div className="text-sm font-semibold uppercase tracking-wider text-white/55">
            Fees & fines
          </div>
          <Link
            href={`/admin/charges?user=${profile.id}`}
            className="text-xs text-spark hover:underline"
          >
            Issue a charge →
          </Link>
        </div>
        {(charges?.length ?? 0) === 0 ? (
          <p className="px-5 pb-5 text-sm text-white/55">No charges.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-white/10 text-left text-xs uppercase tracking-wider text-white/40">
                <th className="px-5 py-2">Issued</th>
                <th className="px-5 py-2">Type</th>
                <th className="px-5 py-2">Amount</th>
                <th className="px-5 py-2">Description</th>
                <th className="px-5 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {(charges ?? []).map((c: any) => (
                <tr
                  key={c.id}
                  className="border-b border-white/5 last:border-0"
                >
                  <td className="px-5 py-3 text-white/70">
                    {new Date(c.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3 text-white/70 capitalize">
                    {c.kind}
                  </td>
                  <td className="px-5 py-3 text-white/80">
                    {fmtMoney(c.amount_cents)}
                  </td>
                  <td className="px-5 py-3 text-white/60 max-w-xs truncate">
                    {c.description}
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge status={c.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-4">
      <div className="text-xs uppercase tracking-wider text-white/40">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold capitalize text-white">
        {value}
      </div>
    </div>
  );
}
