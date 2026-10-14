import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Mail, MessageSquare } from "lucide-react";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { loadStudentAssignments } from "@/lib/assignments-server";
import { isDone } from "@/lib/assignments";
import { AppHeader, AppBody, Section, Row } from "@/components/app/frame";

export const metadata = { title: "Person · Admin" };
export const dynamic = "force-dynamic";

/**
 * One person, at a glance.
 *
 * The whole screen answers "should I be worried about this student, and how do I
 * reach them". So: where they are in the funnel, what they owe, who they build
 * with, and whether their assignments are in — plus a mailto and their Discord
 * handle, because the reason you looked them up is usually that you're about to
 * contact them.
 *
 * It is read-only by design. Every mutation on a person (role changes, fee
 * waivers, account deletion) is consequential and irreversible-ish, and the
 * desktop record is one tap away. "Fully functional from the admin side" means
 * the time-sensitive decisions — application calls and announcements — not
 * every destructive button reachable from a thumb.
 */
export default async function AdminAppPerson(
  props: {
    params: Promise<{ id: string }>;
  }
) {
  const params = await props.params;
  const admin = createAdminClient();

  // One wave, not three. Every read here is keyed on params.id and on nothing
  // the permission check produces, so the guard and all six queries go out
  // together instead of guard -> profile -> the rest. The charges query is the
  // one exception: it is permission-dependent, so it is chained off the guard
  // rather than the batch, which still lets it overlap everything else.
  type PendingCharge = {
    id: string;
    kind: string;
    amount_cents: number;
    description: string;
    status: string;
  };

  const guard = requirePermission("people.view");
  // Awaited inside so this settles to one shape rather than a union of a
  // PostgREST builder and a plain object, which Promise.all cannot destructure.
  const chargesPromise: Promise<PendingCharge[]> = guard.then(async ({ caps: c }) => {
    if (!can(c, "charges.manage") && !can(c, "payments.view")) return [];
    const { data } = await admin
      .from("user_charges")
        .select("id, kind, amount_cents, description, status")
        .eq("user_id", params.id)
        .eq("status", "pending");
    return (data ?? []) as PendingCharge[];
  });

  const [viewer, personRes, appRes, enrollRes, memberRes, charges, assignments] =
    await Promise.all([
      guard,
      admin
        .from("profiles")
        .select("id, full_name, email, role, discord_username, created_at")
        .eq("id", params.id)
        .maybeSingle(),
      admin
        .from("applications")
        .select("id, status, submitted_at, cohort:cohorts(name)")
        .eq("user_id", params.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin
        .from("enrollments")
        .select("enrolled_at, cohort:cohorts(name, starts_on)")
        .eq("user_id", params.id)
      // One row per cohort. Without this an admin opening a returning
      // student's record sees "Not enrolled" for someone plainly enrolled.
        .order("enrolled_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin
        .from("team_members")
        .select("role, team:teams(id, name)")
        .eq("user_id", params.id)
        .limit(1)
        .maybeSingle(),
      chargesPromise,
      loadStudentAssignments(admin, params.id),
    ]);

  const { caps } = viewer;
  const person = personRes.data;
  const application = appRes.data;
  const enrollment = enrollRes.data;
  const membership = memberRes.data;

  // The batch above fetches unconditionally, so the 404 check moved down here.
  // It still runs before anything is rendered.
  if (!person) notFound();

  const appCohort = embed<{ name: string | null }>(application?.cohort);
  const enrollCohort = embed<{ name: string | null; starts_on: string | null }>(
    enrollment?.cohort,
  );
  const team = embed<{ id: string; name: string }>(membership?.team);
  const owed = assignments.items.filter((i) => i.status !== "upcoming");
  const handedIn = owed.filter((i) => isDone(i.status)).length;
  const missing = owed.filter((i) => i.status === "missing").length;

  return (
    <>
      <AppHeader
        title={(person.full_name as string) || "No name"}
        eyebrow={(person.role as string) ?? "student"}
        action={
          <Link
            href="/app/admin/people"
            prefetch={false}
            aria-label="Back to people"
            className="press shrink-0 rounded-lg border border-line px-2.5 py-2 text-ink-soft active:bg-wash"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
        }
      />
      <AppBody>
        {/* Contact first: it's why you're here. */}
        <div className="flex gap-2">
          <a
            href={`mailto:${person.email}`}
            className="press flex h-11 flex-1 items-center justify-center gap-2 rounded-md border border-line bg-wash text-[13px] font-medium text-ink active:scale-[0.99]"
          >
            <Mail className="h-4 w-4" />
            Email
          </a>
          {!!person.discord_username && (
            <div className="flex h-11 flex-1 items-center justify-center gap-2 rounded-md border border-line bg-wash px-3 text-[13px] text-ink-soft">
              <MessageSquare className="h-4 w-4 shrink-0" />
              <span className="truncate font-mono text-[12px]">
                {person.discord_username as string}
              </span>
            </div>
          )}
        </div>
        <p className="mt-2 truncate text-center font-mono text-[11px] text-ink-faint">
          {person.email as string}
        </p>

        {(charges ?? []).length > 0 && (
          <Section title="Owes">
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 sm:px-5">
              {(charges ?? []).map((c) => (
                <Row
                  key={c.id as string}
                  label={c.description as string}
                  value={`${c.kind === "fine" ? "Fine" : "Fee"} · pending`}
                  right={
                    <span className="shrink-0 font-mono text-[13px] font-semibold tabular-nums text-amber-700 dark:text-amber-300">
                      ${((c.amount_cents as number) / 100).toFixed(2)}
                    </span>
                  }
                />
              ))}
            </div>
          </Section>
        )}

        <Section title="Status">
          <div className="rounded-2xl border border-line px-4 sm:px-5">
            <Row
              label="Application"
              value={
                appCohort?.name ??
                (application ? "No cohort assigned" : "Never applied")
              }
              // Gated on the DESTINATION's permission, not this page's. A role
              // with people.view but not applications.view would otherwise tap
              // through and be bounced to /admin by the route guard — a link
              // that looks live and silently throws you somewhere else is worse
              // than plain text.
              href={
                application && can(caps, "applications.view")
                  ? `/admin/applications/${application.id}`
                  : undefined
              }
              right={
                application ? (
                  <StatusBadge status={application.status as string} />
                ) : undefined
              }
            />
            <Row
              label="Enrollment"
              value={
                enrollment
                  ? (enrollCohort?.name ?? "Enrolled")
                  : "Not enrolled"
              }
              muted={!enrollment}
              right={
                enrollment ? (
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                    <LocalTime value={enrollment.enrolled_at as string} mode="date" />
                  </span>
                ) : undefined
              }
            />
            <Row
              label="Team"
              value={team ? team.name : "No team"}
              muted={!team}
              // Same reasoning as the Application row above: /admin/teams
              // requires teams.manage.
              href={
                team && can(caps, "teams.manage")
                  ? `/admin/teams/${team.id}`
                  : undefined
              }
            />
            <Row
              label="Assignments"
              value={
                owed.length
                  ? `${handedIn} of ${owed.length} in${missing ? ` · ${missing} missing` : ""}`
                  : "None yet"
              }
              muted={missing === 0}
              href={owed.length && can(caps, "assignments.manage") ? "/admin/assignments" : undefined}
            />
          </div>
        </Section>

        <Link
          href={`/admin/students/${person.id}`}
          prefetch={false}
          className="press mt-7 flex h-11 items-center justify-center gap-2 rounded-md border border-line bg-wash text-[13px] font-medium text-ink active:scale-[0.99]"
        >
          Full record
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </AppBody>
    </>
  );
}

/** Supabase returns a to-one embed as an object or a single-element array. */
function embed<T>(value: unknown): T | null {
  if (!value) return null;
  return (Array.isArray(value) ? (value[0] ?? null) : value) as T | null;
}
