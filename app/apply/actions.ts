"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { sendTemplated, emitEmailEvent } from "@/lib/email/dispatch";
import { notify } from "@/lib/notifications";
import { checkRateLimit } from "@/lib/rate-limit";
import { canBypassClosedApplications, hasFounderPass } from "@/lib/founder-pass";
import { autoAdmitOnSubmit } from "@/lib/admissions";
import { planReapply, selectCohortId } from "@/lib/reapply";
import {
  postChannelMessage,
  applicationEmbed,
  getDiscordSettings,
} from "@/lib/discord";
import { env } from "@/lib/env";

// Optional URL: empty string allowed, otherwise must be a valid URL
const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) => v === "" || /^https?:\/\/.+/.test(v),
    "Must be a full URL starting with http:// or https://",
  )
  .optional()
  .or(z.literal(""));

const optionalString = (max = 200) =>
  z.string().trim().max(max).optional().or(z.literal(""));

// Submit-time schema — strict. Mirrors the client validation in
// application-form.tsx so error messages match on both sides.
const SubmitSchema = z
  .object({
    full_name: z.string().trim().min(1, "Required").max(120),
    age: z.coerce.number().int().min(10).max(25),
    grade: optionalString(40),
    school: optionalString(160),
    city: optionalString(120),
    country: optionalString(120),
    parent_email: z
      .string()
      .trim()
      .max(160)
      .refine(
        (v) => v === "" || /^\S+@\S+\.\S+$/.test(v),
        "Must be a valid email",
      )
      .optional()
      .or(z.literal("")),
    why_join: z
      .string()
      .trim()
      .min(40, "Tell us at least a couple sentences")
      .max(2000),
    startup_idea: optionalString(2000),
    experience: optionalString(2000),
    hours_per_week: z.coerce
      .number()
      .int()
      .min(0)
      .max(168)
      .optional()
      .or(z.literal("")),
    team_size: z.coerce
      .number()
      .int()
      .min(1, "Pick a team size")
      .max(5, "Pick a team size"),
    referral_source: optionalString(200),
    referral_code: optionalString(32),
    linkedin_url: optionalUrl,
    resume_url: optionalUrl,
    portfolio_url: optionalUrl,
    // Optional explicit cohort target — when the apply page exposes a
    // cohort picker, the chosen id is shipped along with the rest of
    // the form fields.
    cohort_id: optionalString(64),
  })
  // Parent/guardian email is required when the applicant is under 18.
  // Our Terms of Service claim parental consent for minors; enforcing
  // it at the schema closes the gap between policy and product.
  .superRefine((data, ctx) => {
    if (data.age < 18 && !data.parent_email) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parent_email"],
        message: "Required if you're under 18",
      });
    }
  });

// Draft-time schema — much looser. Drafts can be incomplete; we only
// reject pathological values (too long, malformed URLs).
const DraftSchema = z.object({
  full_name: optionalString(120),
  age: z
    .union([z.coerce.number().int().min(0).max(120), z.literal("")])
    .optional(),
  grade: optionalString(40),
  school: optionalString(160),
  city: optionalString(120),
  country: optionalString(120),
  parent_email: z
    .string()
    .trim()
    .max(160)
    .refine(
      (v) => v === "" || /^\S+@\S+\.\S+$/.test(v),
      "Must be a valid email",
    )
    .optional()
    .or(z.literal("")),
  why_join: optionalString(2000),
  startup_idea: optionalString(2000),
  experience: optionalString(2000),
  hours_per_week: z
    .union([z.coerce.number().int().min(0).max(168), z.literal("")])
    .optional(),
  team_size: z
    .union([z.coerce.number().int().min(1).max(5), z.literal("")])
    .optional(),
  referral_source: optionalString(200),
  referral_code: optionalString(32),
  linkedin_url: optionalUrl,
  resume_url: optionalUrl,
  portfolio_url: optionalUrl,
  cohort_id: optionalString(64),
});

type ActionResult = {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  applicationId?: string;
  savedAt?: string;
  /** Set on submit when a virtual founder pass admitted them outright. */
  autoAdmitted?: boolean;
};

/** The admin-pinned active cohort, or null. Not validated as open here — the
 *  caller only ever looks it up inside a list that already is. */
async function getPinnedCohortId(
  supabase: ReturnType<typeof createClient>,
): Promise<string | null> {
  const { data: setting } = await supabase
    .from("site_settings")
    .select("value")
    .eq("key", "active_cohort_id")
    .maybeSingle();
  return typeof setting?.value === "string" && setting.value.length > 0
    ? (setting.value as string)
    : null;
}

async function getActiveCohortId(
  supabase: ReturnType<typeof createClient>,
): Promise<string | null> {
  const { data: open } = await supabase
    .from("cohorts")
    .select("id, name, starts_on")
    .in("status", ["upcoming", "active"])
    .order("starts_on", { ascending: true });
  return selectCohortId(open ?? [], [await getPinnedCohortId(supabase)]);
}

async function upsertApplication(
  formData: FormData,
  submit: boolean,
): Promise<ActionResult> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in" };

  const raw = Object.fromEntries(formData.entries());
  const schema = submit ? SubmitSchema : DraftSchema;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]?.toString() ?? "_";
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return {
      ok: false,
      error: submit
        ? "Please fix the highlighted fields."
        : "Some fields couldn't be saved.",
      fieldErrors,
    };
  }

  if (submit) {
    // Block submit if applications are closed.
    const { data: openSetting } = await supabase
      .from("site_settings")
      .select("value")
      .eq("key", "applications_open")
      .maybeSingle();
    if (openSetting?.value === false) {
      // Founder pass holders can submit during the early-access window. This
      // has to be re-checked server-side even though app/apply/page.tsx
      // already gated the render: the page check only decides what to draw,
      // and a client can post here directly.
      const early = await canBypassClosedApplications(
        createAdminClient(),
        user.id,
      );
      if (!early) {
        return {
          ok: false,
          error: "Applications are currently closed.",
        };
      }
    }
  }

  const data = parsed.data as Record<string, any>;

  // Everything the reapply rules need, in one wave. The history is EVERY
  // application (not just the newest) because a decline shuts that cohort for
  // good — see lib/reapply.ts.
  const [{ data: history }, { data: openCohorts }, pinnedId, holdsPass] =
    await Promise.all([
      supabase
        .from("applications")
        .select("id, status, cohort_id, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("cohorts")
        .select("id, name, starts_on")
        .in("status", ["upcoming", "active"])
        .order("starts_on", { ascending: true }),
      getPinnedCohortId(supabase),
      hasFounderPass(createAdminClient(), user.id),
    ]);

  const applications = history ?? [];
  const existing = applications[0] ?? null;
  const plan = planReapply({
    cohorts: openCohorts ?? [],
    history: applications,
    latestStatus: existing?.status ?? null,
    holdsPass,
  });

  // Lifecycle gate, re-checked here even though app/apply/page.tsx already
  // decided what to render: the page decides what to DRAW, and a client can
  // post to this action directly.
  if (plan.stage === "locked") {
    return {
      ok: false,
      error: "Your application is already in review or decided.",
    };
  }

  // Which cohort this application is FOR. Same order as the picker — explicit
  // pick, then the draft's own cohort, then the admin-pinned one, then the most
  // upcoming — and resolved against `plan.allowed` rather than the raw open
  // list. That last part is the fix: a declined applicant used to be able to
  // post the id of the very cohort that declined them and land a second
  // application in the same reviewer's queue.
  const requested = typeof data.cohort_id === "string" ? data.cohort_id : "";
  const draftCohortId =
    existing?.status === "draft" ? (existing as any).cohort_id ?? null : null;
  const cohortId = selectCohortId(plan.allowed, [
    requested,
    draftCohortId,
    pinnedId,
  ]);

  // A submit with nowhere to go must fail loudly rather than quietly attaching
  // itself to whatever cohort happened to sort first. Drafts are let through
  // with a null cohort — they're not an application yet, and autosave failing
  // mid-sentence would be worse than a draft that gets its cohort on submit.
  if (submit && !cohortId) {
    return {
      ok: false,
      error:
        plan.blocked.length > 0
          ? `You've already had a decision on ${plan.blocked
              .map((c) => c.name)
              .join(" and ")}. Applying again means a different cohort, and there isn't one open yet — we'll email you when the next one opens.`
          : "No cohort is open for applications right now.",
    };
  }

  const payload = {
    user_id: user.id,
    cohort_id: cohortId,
    status: submit ? "submitted" : "draft",
    submitted_at: submit ? new Date().toISOString() : null,
    full_name: data.full_name || null,
    age:
      data.age === "" || data.age === undefined ? null : Number(data.age),
    grade: data.grade || null,
    school: data.school || null,
    city: data.city || null,
    country: data.country || null,
    parent_email: data.parent_email || null,
    why_join: data.why_join || null,
    startup_idea: data.startup_idea || null,
    experience: data.experience || null,
    hours_per_week:
      data.hours_per_week === "" || data.hours_per_week === undefined
        ? null
        : Number(data.hours_per_week),
    team_size:
      data.team_size === "" || data.team_size === undefined
        ? null
        : Number(data.team_size),
    referral_source: data.referral_source || null,
    referral_code:
      typeof data.referral_code === "string" && data.referral_code
        ? data.referral_code.toLowerCase().slice(0, 32)
        : undefined,
    linkedin_url: data.linkedin_url || null,
    resume_url: data.resume_url || null,
    portfolio_url: data.portfolio_url || null,
  };
  // Don't blow away an existing referral_code with undefined on later saves.
  if (payload.referral_code === undefined) delete (payload as any).referral_code;

  let applicationId: string;

  // Lifecycle handling, from the stage lib/reapply.ts already resolved:
  //   - "draft"   → update in place
  //   - "reapply" → INSERT a brand-new application so the student can apply to
  //                 a different cohort without disturbing the historical
  //                 record (admin review pages keep showing both)
  //   - "new"     → INSERT the first one
  //   - "locked"  → returned above; those move by admin action, not by another
  //                 self-serve write
  if (plan.stage === "draft") {
    const { error } = await supabase
      .from("applications")
      .update(payload)
      .eq("id", existing!.id);
    if (error) return { ok: false, error: error.message };
    applicationId = existing!.id;
  } else {
    const { data: created, error } = await supabase
      .from("applications")
      .insert(payload)
      .select("id")
      .single();
    if (error) return { ok: false, error: error.message };
    applicationId = created!.id;
  }

  // The auto-admit perk: a virtual founder pass turns "submitted" into
  // "accepted" right here, before the applicant's own confirmation email is
  // composed below, so the two can't contradict each other. A no-op for
  // everyone else, and best-effort — see lib/admissions.ts.
  let autoAdmitted = false;
  if (submit) {
    const result = await autoAdmitOnSubmit(createAdminClient(), {
      applicationId,
      userId: user.id,
    });
    autoAdmitted = result.admitted;
  }

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/accepted");
  revalidatePath("/dashboard/application");
  revalidatePath("/apply");

  // Send "we got it" email + notify admins on first submission.
  if (submit) {
    try {
      const { data: profile } = await supabase
        .from("profiles")
        .select("full_name, email")
        .eq("id", user.id)
        .maybeSingle();
      // An auto-admitted applicant already has an acceptance in their inbox
      // (lib/admissions.ts sent it moments ago). "Thanks — we'll review and
      // email you with a decision" arriving right after "you're in" doesn't
      // read as thorough, it reads as a bug, and it makes the seat look
      // provisional. So the whole applicant-facing half of this block is
      // skipped for them; the admin-facing half below still runs.
      if (user.email && !autoAdmitted) {
        // Best-effort: the applicant confirmation must never affect the
        // submit result. sendTemplated already returns (rather than throws)
        // when no transport is configured or the send errors; the extra
        // .catch is belt-and-suspenders so a thrown error here can't skip the
        // admin notifications below or surface to the student. Prefers the
        // admin-editable `application.received` template and falls back to the
        // compiled copy.
        const emailRes = await sendTemplated("application.received", {
          to: user.email,
          toName: profile?.full_name ?? null,
          userId: user.id,
          fallback: () =>
            Templates.applicationReceived({ name: profile?.full_name ?? null }),
        }).catch((err) => {
          console.error("[apply] applicant email threw", err);
          return { ok: false as const, reason: "threw" };
        });
        if (!emailRes.ok) {
          console.warn(
            "[apply] applicant confirmation email not sent:",
            emailRes.reason,
          );
        }
      }
      // Awaited rather than fired-and-forgotten: a serverless invocation can
      // be frozen the moment its response is returned, and a floating promise
      // here would drop the enqueue silently. emitEmailEvent swallows its own
      // failures, so awaiting it can't fail the operation it reports on.
      if (!autoAdmitted) {
        await emitEmailEvent("application.submitted", {
          email: user.email,
          name: profile?.full_name ?? null,
          userId: user.id,
          dedupeSeed: `application.submitted:${user.id}`,
        });
        await notify({
          userId: user.id,
          type: "application_submitted",
          title: "Application submitted",
          body: "We'll review and email you with a decision.",
          link: "/dashboard/application",
        });
      }
      // Notify all admins so they see it in their bell + email. This one runs
      // either way: an auto-admit is exactly the event staff most want to see
      // land, and it is the only admission nobody on the team clicked.
      const admin = createAdminClient();
      const { data: admins } = await admin
        .from("profiles")
        .select("id, email, full_name")
        .eq("role", "admin");
      for (const a of admins ?? []) {
        await notify({
          userId: a.id,
          type: "admin_new_application",
          title: autoAdmitted
            ? "Founder pass auto-admitted"
            : "New application received",
          body: autoAdmitted
            ? `${profile?.full_name ?? profile?.email ?? "Someone"} applied and was admitted automatically by their virtual founder pass.`
            : `${profile?.full_name ?? profile?.email ?? "Someone"} just applied.`,
          link: `/admin/applications/${applicationId}`,
        });
      }
      // Mirror to the admin Discord feed so staff have one place to watch.
      try {
        const settings = await getDiscordSettings();
        if (settings.adminFeedChannelId) {
          let cohortName: string | null = null;
          if (cohortId) {
            const { data: c } = await admin
              .from("cohorts")
              .select("name")
              .eq("id", cohortId)
              .maybeSingle();
            cohortName = c?.name ?? null;
          }
          await postChannelMessage(settings.adminFeedChannelId, {
            embeds: [
              applicationEmbed({
                name: profile?.full_name ?? user.email ?? "applicant",
                email: profile?.email ?? user.email ?? null,
                cohortName,
                link: `${env.siteUrl}/admin/applications/${applicationId}`,
              }),
            ],
          });
        }
      } catch (err) {
        console.error("[apply] discord cross-post failed", err);
      }
    } catch (err) {
      console.error("[apply] post-submit notifications failed", err);
    }
  }

  return {
    ok: true,
    applicationId,
    savedAt: new Date().toISOString(),
    autoAdmitted,
  };
}

export async function saveDraftAction(
  _: ActionResult | null,
  formData: FormData,
) {
  // Throttle draft saves — without this, a runaway autosave loop or a
  // bot hammering the form burns DB writes + audit log + revalidation.
  // 30/min per user covers normal typing comfortably.
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    const rl = await checkRateLimit({
      kind: "apply-draft",
      identifier: user.id,
      limit: 30,
      windowSeconds: 60,
    });
    if (!rl.ok) {
      return {
        ok: false,
        errors: { _form: "Too many edits in a row — wait a moment." },
      } as ActionResult;
    }
  }
  return upsertApplication(formData, false);
}

export async function submitApplicationAction(
  _: ActionResult | null,
  formData: FormData,
) {
  const result = await upsertApplication(formData, true);
  // An auto-admitted holder lands on the page that takes their money rather
  // than on "we'll be in touch" — the seat is granted, the only thing left is
  // to lock it in.
  if (result.ok && result.autoAdmitted) redirect("/dashboard/accepted");
  if (result.ok) redirect("/dashboard/application?submitted=1");
  return result;
}

/**
 * Attach a referral code to the user's draft application without
 * touching any other fields. Used by the apply form on mount when a
 * `?ref=` query param or stashed localStorage code is present —
 * sending only `referral_code` through the regular draft save would
 * blow away every other field on the row.
 */
export async function attachReferralCodeAction(code: string) {
  // Hard gate: when the admin turns referrals off, ignore any attempt
  // to attach a code so the feature is truly inert.
  const { getSiteConfig } = await import("@/lib/site-config");
  const cfg = await getSiteConfig();
  if (!cfg.settings.referralsEnabled) return { ok: false };

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  const trimmed = code.trim().toLowerCase().slice(0, 32);
  if (!trimmed) return { ok: false };

  // Reject self-referral (a user clicking their own link) so it can't inflate
  // their own recruiter stats.
  const { data: self } = await supabase
    .from("profiles")
    .select("referral_code")
    .eq("id", user.id)
    .maybeSingle();
  if (self?.referral_code && self.referral_code.toLowerCase() === trimmed) {
    return { ok: false };
  }

  const { data: existing } = await supabase
    .from("applications")
    .select("id, status, referral_code")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    if (existing.referral_code) return { ok: true };
    if (existing.status !== "draft") return { ok: false };
    const { error } = await supabase
      .from("applications")
      .update({ referral_code: trimmed })
      .eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  // No application yet: create a fresh draft with just the code so we
  // remember it. Cohort attachment happens on the next real save.
  const cohortId = await getActiveCohortId(supabase);
  const { error } = await supabase.from("applications").insert({
    user_id: user.id,
    cohort_id: cohortId,
    status: "draft",
    referral_code: trimmed,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
