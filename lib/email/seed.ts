import { createAdminClient } from "@/lib/supabase/admin";
import type { VariableDef } from "@/lib/email/vars";

/**
 * The system templates — database copies of the emails the app already sends
 * from lib/email/templates.ts.
 *
 * Seeding these is what turns "the app sends fifteen emails" into "an admin
 * can edit the fifteen emails the app sends". Until a row exists for a key,
 * `sendTemplated` falls back to the compiled version, which is correct but
 * invisible: nothing shows up at /admin/email/templates for an admin to
 * change. The seed makes them visible, pre-filled with the copy that's
 * already going out, so the first edit is a tweak rather than a blank page.
 *
 * Idempotent and non-destructive: seeding only ever inserts. An existing row
 * is left exactly as the admin last saved it, which is the whole point — a
 * redeploy must never quietly revert someone's edits.
 */

const COMMON: VariableDef[] = [
  { key: "first_name", label: "First name", example: "Alex" },
  { key: "full_name", label: "Full name", example: "Alex Rivera" },
  { key: "site_url", label: "Site URL", example: "https://batch0.org" },
];

type Seed = {
  key: string;
  name: string;
  description: string;
  category: string;
  subject: string;
  preheader?: string;
  body_html: string;
  cta_label?: string;
  cta_url?: string;
  variables: VariableDef[];
};

export const SYSTEM_TEMPLATES: Seed[] = [
  {
    key: "auth.welcome",
    name: "Welcome",
    description: "Sent once, when someone confirms their account.",
    category: "transactional",
    subject: "Welcome to batch0",
    preheader: "Your account is ready.",
    body_html:
      "<h1>Welcome, {{first_name}}.</h1><p>Your batch0 account is ready. Apply when you're ready — applications are reviewed on a rolling basis.</p>",
    cta_label: "Start your application",
    cta_url: "{{site_url}}/apply",
    variables: COMMON,
  },
  {
    key: "auth.password_reset",
    name: "Password reset",
    description:
      "The reset link. Edit the copy freely, but leave the button pointed at {{reset_url}} — without it nobody can reset anything.",
    category: "transactional",
    subject: "Reset your batch0 password",
    preheader: "A link to set a new password. Expires in an hour.",
    body_html:
      "<h1>Reset your password</h1><p>Use the button below to set a new password for your batch0 account. It works once and expires in {{expires_minutes}} minutes.</p><p>If you didn't ask for this, you can ignore this email — your password won't change until someone opens the link.</p>",
    cta_label: "Set a new password",
    cta_url: "{{reset_url}}",
    variables: [
      ...COMMON,
      {
        key: "reset_url",
        label: "Reset link",
        example: "https://batch0.org/auth/confirm?token=…",
        required: true,
      },
      { key: "expires_minutes", label: "Expiry (minutes)", example: "60" },
    ],
  },
  {
    key: "application.received",
    name: "Application received",
    description: "Acknowledgement, sent the moment an application is submitted.",
    category: "transactional",
    subject: "We got your batch0 application",
    preheader: "We'll review and get back to you soon.",
    body_html:
      "<h1>Application received</h1><p>Thanks, {{first_name}} — we have your application and will review it within a few days. You'll get an email when there's a decision.</p>",
    cta_label: "View application",
    cta_url: "{{site_url}}/dashboard/application",
    variables: COMMON,
  },
  {
    key: "application.accepted",
    name: "Application accepted",
    description: "The acceptance. Sent when a reviewer accepts an applicant.",
    category: "transactional",
    subject: "You're in — accepted to batch0",
    preheader: "Pay {{amount}} to lock in your seat.",
    body_html:
      "<h1>You're in.</h1><p>Welcome to <strong>{{cohort_name}}</strong>, {{first_name}}. Your one-time enrollment fee is <strong>{{amount}}</strong>. Pay below to lock in your seat.</p>",
    cta_label: "Pay &amp; enroll",
    cta_url: "{{site_url}}/dashboard/accepted",
    variables: [
      ...COMMON,
      { key: "cohort_name", label: "Cohort name", example: "Cohort 1", required: true },
      { key: "amount", label: "Enrollment fee", example: "$130", required: true },
    ],
  },
  {
    key: "application.waitlisted",
    name: "Application waitlisted",
    description: "Sent when a reviewer moves an applicant to the waitlist.",
    category: "transactional",
    subject: "You're on the batch0 waitlist",
    preheader: "Not a no — a seat may still open up.",
    body_html:
      "<h1>You're on the waitlist</h1><p>Hi {{first_name}},</p><p>Your application to <strong>{{cohort_name}}</strong> made the cut for the waitlist. That's not a no — seats open when admitted applicants don't enroll, and waitlisted applications are the first we return to.</p><p>There's nothing you need to do. If a seat opens, you'll get an acceptance email with payment instructions; if the cohort fills, we'll tell you that too.</p>",
    cta_label: "View your application",
    cta_url: "{{site_url}}/dashboard/application",
    variables: [
      ...COMMON,
      { key: "cohort_name", label: "Cohort name", example: "Cohort 1", required: true },
      { key: "review_notes", label: "Reviewer notes", example: "Strong idea, thin traction." },
    ],
  },
  {
    key: "application.rejected",
    name: "Application declined",
    description: "Sent when a reviewer declines an applicant.",
    category: "transactional",
    subject: "Update on your batch0 application",
    preheader: "Decision on your application.",
    body_html:
      "<p>Hi {{first_name}},</p><p>Thanks for applying to batch0. After reviewing your application, we're unable to offer you a seat in this cohort. We hope you'll apply again next time.</p>",
    variables: [
      ...COMMON,
      { key: "review_notes", label: "Reviewer notes", example: "" },
    ],
  },
  {
    key: "payment.receipt",
    name: "Payment receipt",
    description: "Sent when Stripe confirms an enrollment payment.",
    category: "transactional",
    subject: "Payment received — you're enrolled",
    preheader: "You're enrolled in batch0.",
    body_html:
      "<h1>Enrolled</h1><p>We received your payment of <strong>{{amount}}</strong> for {{cohort_name}}. Welcome aboard, {{first_name}}.</p>",
    cta_label: "Open your dashboard",
    cta_url: "{{site_url}}/dashboard",
    variables: [
      ...COMMON,
      { key: "amount", label: "Amount paid", example: "$130.00", required: true },
      { key: "cohort_name", label: "Cohort name", example: "Cohort 1", required: true },
      { key: "starts_on", label: "Cohort start date", example: "September 14, 2026" },
    ],
  },
  {
    key: "nudge.unpaid",
    name: "Payment nudge",
    description:
      "Not sent by the app — build a drip on the “Application accepted” event and use this as a later step.",
    category: "lifecycle",
    subject: "Your batch0 seat is still open, {{first_name}}",
    preheader: "A quick reminder to finish enrolling.",
    body_html:
      "<p>Hi {{first_name}},</p><p>Your seat in <strong>{{cohort_name}}</strong> is still held, but it isn't locked in until the enrollment fee is paid. It takes a minute.</p><p>If something's in the way — timing, cost, anything — reply to this email and tell us. We'd rather sort it out than lose you.</p>",
    cta_label: "Finish enrolling",
    cta_url: "{{site_url}}/dashboard/accepted",
    variables: [
      ...COMMON,
      { key: "cohort_name", label: "Cohort name", example: "Cohort 1" },
    ],
  },
  {
    key: "nudge.draft",
    name: "Finish your application",
    description:
      "For the “Application in draft, not yet submitted” audience — a nudge to people who started an application but never hit submit. Send it from the composer, or use it as a step on a drip.",
    category: "lifecycle",
    subject: "Your batch0 application is almost there, {{first_name}}",
    preheader: "You started an application — a few minutes finishes it.",
    body_html:
      "<p>Hi {{first_name}},</p><p>You started a batch0 application but haven't submitted it yet — it's still sitting in draft. Applications are reviewed on a rolling basis, so the sooner you finish, the sooner we can take a look.</p><p>It only takes a few minutes to pick up where you left off. If something stopped you — a question you weren't sure how to answer, timing, anything — just reply to this email and we'll help.</p>",
    cta_label: "Finish your application",
    cta_url: "{{site_url}}/apply",
    variables: COMMON,
  },
  {
    key: "broadcast.promo",
    name: "40% off — enroll by September 9",
    description:
      "The tuition-sale invite. Send it from the composer to a hand-picked segment before the September 9 deadline — the copy leans on the deadline, so retire it once the promo ends (see lib/promo.ts). Prices and the deadline are variables so they can't drift from what the site charges.",
    category: "broadcast",
    subject: "{{first_name}}, batch0 tuition is 40% off — through {{deadline}}",
    preheader: "Enroll before {{deadline}} and pay {{sale_price}}, not {{list_price}}.",
    body_html:
      "<h1>40% off, but not for long.</h1><p>Hi {{first_name}},</p><p>For a few more days, a seat at batch0 is <strong>{{sale_price}}</strong> instead of <strong>{{list_price}}</strong> — 40% off. It's the lowest tuition has ever been, and it ends <strong>{{deadline}}</strong>.</p><p>batch0 is a live, online startup accelerator built for high schoolers: you build a real company alongside a cohort, with mentors, weekly sessions, and a Demo Day at the end. Applying is free, and we never take equity — the tuition is the whole cost.</p><p>If you've been on the fence, this is the moment to jump. Lock in the 40% before {{deadline}} and you're set.</p>",
    cta_label: "Claim 40% off",
    cta_url: "{{site_url}}/apply",
    variables: [
      ...COMMON,
      { key: "sale_price", label: "Sale price", example: "$78" },
      { key: "list_price", label: "List price", example: "$129.99" },
      { key: "deadline", label: "Offer deadline", example: "September 9" },
    ],
  },
  {
    key: "broadcast.blank",
    name: "Blank branded email",
    description:
      "An empty starting point in the house style — for one-off sends and broadcasts.",
    category: "broadcast",
    subject: "",
    body_html: "<p>Hi {{first_name}},</p><p></p>",
    variables: COMMON,
  },
];

export type SeedReport = {
  inserted: string[];
  skipped: string[];
  error?: string;
};

/**
 * Insert any system template that doesn't exist yet.
 *
 * Called from the templates page's "Restore built-in templates" button. Runs
 * key-by-key rather than as one bulk upsert so that a single bad row can't
 * take the whole seed down, and so the report can tell an admin exactly what
 * it added.
 */
export async function seedSystemTemplates(
  createdBy: string | null,
): Promise<SeedReport> {
  const report: SeedReport = { inserted: [], skipped: [] };
  try {
    const admin = createAdminClient();
    const { data: existing, error } = await admin
      .from("email_templates")
      .select("key");
    if (error) return { ...report, error: error.message };
    const have = new Set((existing ?? []).map((r: any) => r.key));

    const toInsert = SYSTEM_TEMPLATES.filter((t) => {
      if (have.has(t.key)) {
        report.skipped.push(t.key);
        return false;
      }
      return true;
    });
    if (toInsert.length === 0) return report;

    // One insert for the whole set rather than one round trip per template.
    const { data, error: insertError } = await admin
      .from("email_templates")
      .insert(
        toInsert.map((t) => ({
          key: t.key,
          name: t.name,
          description: t.description,
          category: t.category,
          subject: t.subject,
          preheader: t.preheader ?? null,
          body_html: t.body_html,
          cta_label: t.cta_label ?? null,
          cta_url: t.cta_url ?? null,
          variables: t.variables,
          is_system: true,
          enabled: true,
          created_by: createdBy,
          updated_by: createdBy,
        })),
      )
      .select("key");
    if (insertError) return { ...report, error: insertError.message };
    report.inserted.push(...(data ?? []).map((r: any) => r.key));

    return report;
  } catch (err: any) {
    return { ...report, error: err?.message ?? "Seed failed" };
  }
}
