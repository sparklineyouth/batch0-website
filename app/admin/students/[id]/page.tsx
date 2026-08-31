import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/auth";
import { getAllRoles, capabilitiesForRole } from "@/lib/roles";
import { can, covers, roleColorClasses } from "@/lib/permissions";
import { Card, StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { RoleSelect } from "../role-select";
import { ManagePanel } from "./manage-panel";
import { discordAvatarUrl } from "@/lib/discord";
import { getSiteConfig } from "@/lib/site-config";
import { Meter } from "@/components/admin/charts";
import { getStudentProgress } from "@/lib/progress";
import type { Role } from "@/lib/types";

export const metadata = { title: "Manage user · Admin" };

function fmtMoney(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

function ProgressStat({
  label,
  done,
  total,
  hint,
}: {
  label: string;
  done: number;
  total: number;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-paper px-3 py-2.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-ink-faint">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-ink">
        {done}
        <span className="text-sm font-normal text-ink-faint"> / {total}</span>
      </p>
      <div className="mt-1.5">
        <Meter value={done} max={total || null} />
      </div>
      {hint && <p className="mt-1 text-[11px] text-ink-faint">{hint}</p>}
    </div>
  );
}

export default async function AdminStudentDetail({
  params,
}: {
  params: { id: string };
}) {
  // Progress is its own module because it spans five tables; see lib/progress.ts.
  const progress = await getStudentProgress(params.id);

  const { profile: actor, caps } = await requirePermission("people.view");
  const admin = createAdminClient();

  // Assignable roles are capped by what the viewer holds, mirroring the
  // server action; a viewer without `people.roles` gets a read-only badge.
  const canChangeRoles = can(caps, "people.roles");

  const [
    allRoles,
    siteConfig,
    { data: profile },
    { data: applications },
    { data: enrollments },
    { data: payments },
    { data: cohorts },
    { data: charges },
  ] = await Promise.all([
    getAllRoles(),
    getSiteConfig(),
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

  const roleOptions = allRoles
    .filter((r) => covers(caps, r.permissions))
    .map((r) => ({ slug: r.slug, label: r.label, color: r.color }));
  const referralsEnabled = siteConfig.settings.referralsEnabled;

  if (!profile) notFound();

  // Deleting a full-access account is blocked server-side; mirror that here.
  const targetCaps = await capabilitiesForRole(profile.role);

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
        className="text-sm text-ink-faint hover:text-ink"
      >
        ← People
      </Link>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            {profile.full_name || "—"}
          </h1>
          <p className="mt-1 text-sm text-ink-soft">{profile.email}</p>
          <p className="mt-1 text-xs text-ink-faint">
            Joined <LocalTime value={profile.created_at} mode="date" />
            {referralsEnabled && (
              <>
                {" · "}Referral code{" "}
                <span className="text-ink-soft">
                  {profile.referral_code ?? "—"}
                </span>
              </>
            )}
            {profile.discord_user_id && (
              <>
                {" "}· Discord{" "}
                <span className="text-ink-soft">
                  @{profile.discord_username ?? profile.discord_user_id}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-ink-faint">
            Role
          </span>
          {canChangeRoles ? (
            <RoleSelect
              userId={profile.id}
              role={profile.role as Role}
              options={roleOptions}
            />
          ) : (
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider ${roleColorClasses(
                allRoles.find((r) => r.slug === profile.role)?.color ?? "slate",
              )}`}
            >
              {allRoles.find((r) => r.slug === profile.role)?.label ??
                profile.role}
            </span>
          )}
        </div>
      </div>

      {/* Where this student actually is. The roster view at /admin/progress
          answers the same question across the whole cohort. */}
      <Card className="mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-faint">
            Progress
          </h2>
          <Link
            href="/admin/progress"
            className="text-xs text-phosphor-ink hover:underline"
          >
            Whole cohort →
          </Link>
        </div>

        {progress.stoppedAt ? (
          <div className="mt-3 rounded-xl border border-line bg-paper px-4 py-3">
            <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-ink-faint">
              Stopped at
            </p>
            <p className="mt-1 text-base font-medium text-ink">
              {progress.stoppedAt.label}
            </p>
            <p className="mt-0.5 text-xs text-ink-soft">
              {progress.stoppedAt.detail} ·{" "}
              <LocalTime value={progress.stoppedAt.at} mode="datetime-short" />
              {progress.idleDays !== null &&
                progress.idleDays > 0 &&
                ` · ${progress.idleDays}d ago`}
            </p>
          </div>
        ) : (
          <p className="mt-3 rounded-xl border border-dashed border-line px-4 py-3 text-sm text-ink-faint">
            No recorded activity yet — no lessons watched, flows started, or
            resources opened.
          </p>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <ProgressStat
            label="Course"
            done={progress.course.done}
            total={progress.course.total}
            hint={
              progress.course.inProgress > 0
                ? `${progress.course.inProgress} in progress`
                : undefined
            }
          />
          <ProgressStat
            label="Flows"
            done={progress.flows.done}
            total={progress.flows.total}
            hint={
              progress.flows.inProgress > 0
                ? `${progress.flows.inProgress} in progress`
                : undefined
            }
          />
          <ProgressStat
            label="Resources opened"
            done={progress.resources.done}
            total={progress.resources.total}
            hint={progress.missingTable ? "run migration 0053" : undefined}
          />
        </div>

        {progress.recent.length > 0 && (
          <ol className="mt-4 space-y-1.5 border-t border-line pt-3">
            {progress.recent.map((e, i) => (
              <li
                key={`${e.area}-${e.at}-${i}`}
                className="flex flex-wrap items-baseline gap-x-2 text-xs"
              >
                <span className="w-16 shrink-0 text-ink-faint">{e.area}</span>
                <span className="text-ink">{e.label}</span>
                {e.detail && <span className="text-ink-faint">· {e.detail}</span>}
                <span className="ml-auto text-ink-faint">
                  <LocalTime value={e.at} mode="datetime-short" />
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card className="mt-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-faint">
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
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-faint">
          Manage
        </h2>
        <ManagePanel
          userId={profile.id}
          isSelf={actor?.id === profile.id}
          isAdminTarget={targetCaps.superAdmin}
          hasRefundable={hasRefundable}
          cohorts={(cohorts ?? []) as any}
          currentCohortId={
            currentEnrollment?.cohort_id ?? latestApp?.cohort_id ?? null
          }
        />
      </Card>

      <Card className="mt-6 !p-0 overflow-hidden">
        <div className="px-5 py-3 text-sm font-semibold uppercase tracking-wider text-ink-faint">
          Applications
        </div>
        {(applications?.length ?? 0) === 0 ? (
          <p className="px-5 pb-5 text-sm text-ink-soft">No applications.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-line bg-wash text-left text-xs font-mono uppercase tracking-wider text-ink-faint">
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
                  className="border-b border-line last:border-0 hover:bg-wash"
                >
                  <td className="px-5 py-3 text-ink-soft">
                    <LocalTime value={a.submitted_at} />
                  </td>
                  <td className="px-5 py-3 text-ink-soft">
                    {a.cohort?.name ?? "—"}
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge status={a.status} />
                  </td>
                  <td className="px-5 py-3 text-ink-soft">
                    {a.fee_waived ? "Yes" : "—"}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Link
                      href={`/admin/applications/${a.id}`}
                      className="text-xs text-phosphor-ink hover:underline"
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
        <div className="px-5 py-3 text-sm font-semibold uppercase tracking-wider text-ink-faint">
          Payments
        </div>
        {(payments?.length ?? 0) === 0 ? (
          <p className="px-5 pb-5 text-sm text-ink-soft">No payments.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-line bg-wash text-left text-xs font-mono uppercase tracking-wider text-ink-faint">
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
                  className="border-b border-line last:border-0 hover:bg-wash"
                >
                  <td className="px-5 py-3 text-ink-soft">
                    <LocalTime value={p.created_at} />
                  </td>
                  <td className="px-5 py-3 text-ink tabular-nums">
                    {fmtMoney(p.amount_cents, p.currency)}
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-5 py-3 text-xs text-ink-faint font-mono">
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
          <div className="text-sm font-semibold uppercase tracking-wider text-ink-faint">
            Fees & fines
          </div>
          <Link
            href={`/admin/charges?user=${profile.id}`}
            className="text-xs text-phosphor-ink hover:underline"
          >
            Issue a charge →
          </Link>
        </div>
        {(charges?.length ?? 0) === 0 ? (
          <p className="px-5 pb-5 text-sm text-ink-soft">No charges.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-line bg-wash text-left text-xs font-mono uppercase tracking-wider text-ink-faint">
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
                  className="border-b border-line last:border-0 hover:bg-wash"
                >
                  <td className="px-5 py-3 text-ink-soft">
                    <LocalTime value={c.created_at} mode="date" />
                  </td>
                  <td className="px-5 py-3 text-ink-soft capitalize">
                    {c.kind}
                  </td>
                  <td className="px-5 py-3 text-ink tabular-nums">
                    {fmtMoney(c.amount_cents)}
                  </td>
                  <td className="px-5 py-3 text-ink-soft max-w-xs truncate">
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
    <div className="rounded-xl border border-line bg-wash p-4">
      <div className="text-xs uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold capitalize text-ink">
        {value}
      </div>
    </div>
  );
}
