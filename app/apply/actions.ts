"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { notify } from "@/lib/notifications";
import { checkRateLimit } from "@/lib/rate-limit";
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
};

async function getActiveCohortId(
  supabase: ReturnType<typeof createClient>,
): Promise<string | null> {
  // 1) Honor admin-pinned active_cohort_id site setting.
  const { data: setting } = await supabase
    .from("site_settings")
    .select("value")
    .eq("key", "active_cohort_id")
    .maybeSingle();
  const pinned =
    typeof setting?.value === "string" && setting.value.length > 0
      ? (setting.value as string)
      : null;
  if (pinned) {
    const { data } = await supabase
      .from("cohorts")
      .select("id")
      .eq("id", pinned)
      .in("status", ["upcoming", "active"])
      .maybeSingle();
    if (data?.id) return data.id;
  }
  // 2) Fall back to next upcoming/active cohort by start date.
  const { data: cohort } = await supabase
    .from("cohorts")
    .select("id")
    .in("status", ["upcoming", "active"])
    .order("starts_on", { ascending: true })
    .limit(1)
    .maybeSingle();
  return cohort?.id ?? null;
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
      return {
        ok: false,
        error: "Applications are currently closed.",
      };
    }
  }

  const data = parsed.data as Record<string, any>;
  // Prefer the user's explicit pick. Fall back to the admin-pinned /
  // next-upcoming active cohort. Validate the pick is an open cohort
  // so a client can't ride a stale id onto a closed one.
  let cohortId: string | null = null;
  const requested = typeof data.cohort_id === "string" ? data.cohort_id : "";
  if (requested) {
    const { data: pickedRow } = await supabase
      .from("cohorts")
      .select("id")
      .eq("id", requested)
      .in("status", ["upcoming", "active"])
      .maybeSingle();
    if (pickedRow?.id) cohortId = pickedRow.id;
  }
  if (!cohortId) cohortId = await getActiveCohortId(supabase);

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

  // Find the most recent application for this user.
  const { data: existing } = await supabase
    .from("applications")
    .select("id, status")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let applicationId: string;

  // Lifecycle handling:
  //   - draft → update in place
  //   - rejected or withdrawn → INSERT a brand-new application so the
  //     student can apply to a different cohort without disturbing the
  //     historical record (admin review pages keep showing both)
  //   - submitted / accepted / paid / enrolled → block (those need
  //     admin action, not another self-serve write)
  if (existing) {
    if (existing.status === "draft") {
      const { error } = await supabase
        .from("applications")
        .update(payload)
        .eq("id", existing.id);
      if (error) return { ok: false, error: error.message };
      applicationId = existing.id;
    } else if (
      existing.status === "rejected" ||
      existing.status === "withdrawn"
    ) {
      const { data: created, error } = await supabase
        .from("applications")
        .insert(payload)
        .select("id")
        .single();
      if (error) return { ok: false, error: error.message };
      applicationId = created!.id;
    } else {
      return {
        ok: false,
        error: "Your application is already in review or decided.",
      };
    }
  } else {
    const { data: created, error } = await supabase
      .from("applications")
      .insert(payload)
      .select("id")
      .single();
    if (error) return { ok: false, error: error.message };
    applicationId = created!.id;
  }

  revalidatePath("/dashboard");
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
      const t = Templates.applicationReceived({
        name: profile?.full_name ?? null,
      });
      if (user.email) {
        // Best-effort: the applicant confirmation must never affect the
        // submit result. sendEmail already returns (rather than throws) when
        // Resend is unconfigured or errors; the extra .catch is belt-and-
        // suspenders so a thrown error here can't skip the admin notifications
        // below or surface to the student. Requires RESEND_API_KEY +
        // RESEND_FROM (verified domain) to actually deliver.
        const emailRes = await sendEmail({
          to: user.email,
          subject: t.subject,
          html: t.html,
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
      await notify({
        userId: user.id,
        type: "application_submitted",
        title: "Application submitted",
        body: "We'll review and email you with a decision.",
        link: "/dashboard/application",
      });
      // Notify all admins so they see it in their bell + email.
      const admin = createAdminClient();
      const { data: admins } = await admin
        .from("profiles")
        .select("id, email, full_name")
        .eq("role", "admin");
      for (const a of admins ?? []) {
        await notify({
          userId: a.id,
          type: "admin_new_application",
          title: "New application received",
          body: `${profile?.full_name ?? profile?.email ?? "Someone"} just applied.`,
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
