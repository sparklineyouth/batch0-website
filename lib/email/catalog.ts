/**
 * The catalog: which events an automation can hang off, which merge tags each
 * one supplies, and which template keys the code sends by name.
 *
 * This is the contract between the call sites (which fire events and name
 * templates) and the admin UI (which offers those events and templates in
 * dropdowns). Keeping both sides off one list is what stops the UI advertising
 * a trigger nothing fires, or a variable that never has a value — either of
 * which an admin only discovers when a real email goes out wrong.
 *
 * Client-safe: no server imports, so the automation editor can render the
 * variable pickers without a round trip.
 */

import type { VariableDef } from "./vars";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EmailEventDef = {
  key: string;
  label: string;
  /** What actually causes it — written for the admin choosing a trigger. */
  description: string;
  group: string;
  /** Tags every send from this event can fill. */
  variables: VariableDef[];
};

/** Tags available on every event — resolved from the recipient's profile. */
export const COMMON_VARIABLES: VariableDef[] = [
  { key: "first_name", label: "First name", example: "Alex" },
  { key: "full_name", label: "Full name", example: "Alex Rivera" },
  { key: "email", label: "Email address", example: "alex@example.com" },
  { key: "site_url", label: "Site URL", example: "https://batch0.org" },
  {
    key: "dashboard_url",
    label: "Dashboard URL",
    example: "https://batch0.org/dashboard",
  },
];

const APPLICATION_VARS: VariableDef[] = [
  { key: "cohort_name", label: "Cohort name", example: "Cohort 1" },
  { key: "application_status", label: "Application status", example: "accepted" },
  { key: "review_notes", label: "Reviewer notes", example: "Strong technical founder." },
];

/**
 * Only events that a call site actually fires belong here. An event listed but
 * never emitted is worse than a missing one: an admin builds an automation on
 * it, enables it, and it silently never sends. Add the entry in the same
 * change that adds the `emitEmailEvent` call.
 */
export const EMAIL_EVENTS: EmailEventDef[] = [
  {
    key: "user.signup",
    label: "Account created",
    description: "Someone finishes signing up and confirms their address.",
    group: "Accounts",
    variables: [],
  },
  {
    key: "application.submitted",
    label: "Application submitted",
    description: "An applicant hits submit on the application form.",
    group: "Applications",
    variables: APPLICATION_VARS,
  },
  {
    key: "application.accepted",
    label: "Application accepted",
    description: "A reviewer accepts an applicant into a cohort.",
    group: "Applications",
    variables: [
      ...APPLICATION_VARS,
      { key: "amount", label: "Enrollment fee", example: "$130" },
      { key: "pay_url", label: "Payment link", example: "https://batch0.org/dashboard/accepted" },
    ],
  },
  {
    key: "application.waitlisted",
    label: "Application waitlisted",
    description: "A reviewer moves an applicant to the waitlist.",
    group: "Applications",
    variables: APPLICATION_VARS,
  },
  {
    key: "application.rejected",
    label: "Application rejected",
    description: "A reviewer declines an applicant.",
    group: "Applications",
    variables: APPLICATION_VARS,
  },
  {
    key: "payment.succeeded",
    label: "Payment received",
    description: "Stripe confirms an enrollment payment.",
    group: "Money",
    variables: [
      { key: "amount", label: "Amount paid", example: "$130.00" },
      { key: "cohort_name", label: "Cohort name", example: "Cohort 1" },
      { key: "starts_on", label: "Cohort start date", example: "September 14, 2026" },
    ],
  },
];

const EVENT_BY_KEY = new Map(EMAIL_EVENTS.map((e) => [e.key, e]));

export function eventDef(key: string): EmailEventDef | null {
  return EVENT_BY_KEY.get(key) ?? null;
}

export const EVENT_GROUPS: { label: string; events: EmailEventDef[] }[] =
  Object.values(
    EMAIL_EVENTS.reduce<Record<string, { label: string; events: EmailEventDef[] }>>(
      (acc, e) => {
        (acc[e.group] ??= { label: e.group, events: [] }).events.push(e);
        return acc;
      },
      {},
    ),
  );

// ---------------------------------------------------------------------------
// Template categories
// ---------------------------------------------------------------------------

export const TEMPLATE_CATEGORIES = [
  { value: "transactional", label: "Transactional" },
  { value: "lifecycle", label: "Lifecycle & drip" },
  { value: "broadcast", label: "Broadcast" },
  { value: "internal", label: "Internal / admin" },
  { value: "custom", label: "Custom" },
] as const;

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]["value"];

export function isTemplateCategory(v: string): v is TemplateCategory {
  return TEMPLATE_CATEGORIES.some((c) => c.value === v);
}

/** Slug rules for a template key — the string a call site passes literally. */
export const TEMPLATE_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

export function slugifyTemplateKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "")
    .slice(0, 64);
}

// ---------------------------------------------------------------------------
// Audience segments (scheduled + manual automations, and the compose page)
// ---------------------------------------------------------------------------

export const AUDIENCE_SEGMENTS = [
  { value: "everyone", label: "Everyone with an account" },
  { value: "students", label: "Students" },
  { value: "enrolled", label: "Enrolled in a cohort" },
  { value: "accepted", label: "Accepted, not yet paid" },
  { value: "waitlisted", label: "Waitlisted" },
  { value: "applied", label: "Applied, awaiting a decision" },
  { value: "mentors", label: "Mentors" },
  { value: "admins", label: "Admins" },
] as const;

export type AudienceSegment = (typeof AUDIENCE_SEGMENTS)[number]["value"];

export function isAudienceSegment(v: string): v is AudienceSegment {
  return AUDIENCE_SEGMENTS.some((s) => s.value === v);
}

// ---------------------------------------------------------------------------
// Step conditions
// ---------------------------------------------------------------------------

/**
 * The gates a drip step can carry, evaluated when the mail is about to leave
 * rather than when it was queued.
 *
 * The distinction is the whole point of the feature: a "you haven't paid yet"
 * nudge queued on day 0 for delivery on day 3 must not go to someone who paid
 * on day 1. Queue-time evaluation would send it anyway.
 */
export const STEP_CONDITIONS = [
  {
    value: "always",
    label: "Always send",
    description: "No gate — this step goes out when its delay is up.",
  },
  {
    value: "not_paid",
    label: "Only if they still haven't paid",
    description: "Skips anyone whose enrollment payment has since succeeded.",
  },
  {
    value: "not_enrolled",
    label: "Only if they're still not enrolled",
    description: "Skips anyone who has since joined a cohort roster.",
  },
  {
    value: "still_applicant",
    label: "Only if their application is still undecided",
    description: "Skips anyone who has since been accepted, waitlisted, or declined.",
  },
  {
    value: "no_login_since",
    label: "Only if they haven't signed in since the trigger",
    description: "Skips anyone who has been back to the site in the meantime.",
  },
] as const;

export type StepConditionKind = (typeof STEP_CONDITIONS)[number]["value"];

export function isStepCondition(v: string): v is StepConditionKind {
  return STEP_CONDITIONS.some((c) => c.value === v);
}

// ---------------------------------------------------------------------------
// Delay presets
// ---------------------------------------------------------------------------

export const DELAY_PRESETS = [
  { minutes: 0, label: "Immediately" },
  { minutes: 15, label: "15 minutes later" },
  { minutes: 60, label: "1 hour later" },
  { minutes: 60 * 4, label: "4 hours later" },
  { minutes: 60 * 24, label: "1 day later" },
  { minutes: 60 * 24 * 2, label: "2 days later" },
  { minutes: 60 * 24 * 3, label: "3 days later" },
  { minutes: 60 * 24 * 7, label: "1 week later" },
  { minutes: 60 * 24 * 14, label: "2 weeks later" },
  { minutes: 60 * 24 * 30, label: "30 days later" },
] as const;

export function formatDelay(minutes: number): string {
  const preset = DELAY_PRESETS.find((p) => p.minutes === minutes);
  if (preset) return preset.label;
  if (minutes < 60) return `${minutes} min later`;
  if (minutes < 60 * 24) {
    const h = Math.round((minutes / 60) * 10) / 10;
    return `${h} hr later`;
  }
  const d = Math.round((minutes / (60 * 24)) * 10) / 10;
  return `${d} day${d === 1 ? "" : "s"} later`;
}

// ---------------------------------------------------------------------------
// SMTP presets
// ---------------------------------------------------------------------------

/**
 * Recognised relays, so the settings form is a dropdown before it is three
 * text fields. Lives here rather than next to the settings loader because the
 * form that renders it is a client component, and lib/email/settings.ts pulls
 * in the service-role Supabase client.
 *
 * Port 587 with STARTTLS rather than 465 implicit TLS: both work, and 465 is
 * the one that gets blocked by egress rules on most serverless platforms.
 */
export const SMTP_PRESETS = [
  {
    value: "gmail",
    label: "Gmail / Google Workspace",
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    help: "Turn on 2-Step Verification for the account, then create an App Password (Google Account → Security → App passwords) and paste it below. A normal Gmail password will not work.",
  },
  {
    value: "outlook",
    label: "Outlook / Microsoft 365",
    host: "smtp.office365.com",
    port: 587,
    secure: false,
    help: "Use the mailbox address and an app password. SMTP AUTH has to be enabled for that mailbox in the Microsoft 365 admin centre.",
  },
  {
    value: "custom",
    label: "Other SMTP server",
    host: "",
    port: 587,
    secure: false,
    help: "Any SMTP relay. Port 587 with STARTTLS is the usual choice; tick implicit TLS for a 465-style port.",
  },
] as const;

export type SmtpPreset = (typeof SMTP_PRESETS)[number];
