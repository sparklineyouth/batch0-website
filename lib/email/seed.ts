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
    subject: "Any questions about joining batch0, {{first_name}}?",
    preheader: "The schedule, parent guide, and your next step.",
    body_html:
      "<p>Hi {{first_name}},</p><p>You were accepted to <strong>{{cohort_name}}</strong>. Is the schedule, a parent question, the cost, or checkout holding you back?</p><p><a href=\"{{site_url}}/parents\">The parent guide</a> explains the live schedule, sample work, and how enrollment works. Your enrollment page shows your current total and availability before payment. A seat is confirmed only when enrollment is complete.</p><p>Reply with the main question and we will answer it directly. If the timing no longer works, tell us and we will stop following up.</p>",
    cta_label: "Finish enrolling",
    cta_url: "{{site_url}}/dashboard/accepted",
    // `amount` is the live tuition, resolved when the nudge sends (not when the
    // drip was queued), so it always quotes the current price — see
    // lib/email/pricing-vars. Not required: if a recipient somehow has nothing
    // to quote, the sentence still reads without a broken tag.
    variables: [
      ...COMMON,
      { key: "cohort_name", label: "Cohort name", example: "Cohort 1" },
      { key: "amount", label: "Enrollment fee", example: "$117" },
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
    key: "nudge.interview",
    name: "Book your getting-to-know-you interview",
    description:
      "The invite to a getting-to-know-you interview — for the “Enrolled in a cohort” audience, in the window before their cohort starts. Send it from the composer; the button drops them on /dashboard/calls, where they propose a time and the team schedules it (migration 0061). Pairs with the student-first request card.",
    category: "lifecycle",
    subject: "{{first_name}}, let's book your getting-to-know-you call",
    preheader: "A short, no-pressure call with the batch0 team before kickoff.",
    body_html:
      "<h1>Let's get to know you.</h1><p>Hi {{first_name}},</p><p>Before <strong>{{cohort_name}}</strong> kicks off, we'd love a short, no-pressure video call — just the batch0 team and you. It's a chance to hear what you're building, what you want out of the cohort, and to answer anything on your mind before day one.</p><p>It only takes a minute to set up: pick a time or two that work for you, add a note if there's something you'd like us to know, and we'll confirm the slot. Then it lands in your 1:1 calls, ready to join.</p>",
    cta_label: "Request your interview",
    cta_url: "{{site_url}}/dashboard/calls",
    variables: [
      ...COMMON,
      { key: "cohort_name", label: "Cohort name", example: "Cohort 1" },
    ],
  },
  {
    key: "broadcast.promo",
    name: "10% off — enroll by September 9",
    description:
      "The tuition-sale invite. Send it from the composer to a hand-picked segment before the September 9 deadline — the copy leans on the deadline, so retire it once the promo ends (see lib/promo.ts). Prices and the deadline are variables so they can't drift from what the site charges.",
    category: "broadcast",
    subject: "{{first_name}}, batch0 tuition is {{promo_percent}}% off — through {{deadline}}",
    preheader: "Enroll before {{deadline}} and pay {{sale_price}}, not {{list_price}}.",
    body_html:
      "<h1>{{promo_percent}}% off, but not for long.</h1><p>Hi {{first_name}},</p><p>For a few more days, a seat at batch0 is <strong>{{sale_price}}</strong> instead of <strong>{{list_price}}</strong> — {{promo_percent}}% off. It's the lowest tuition has ever been, and it ends <strong>{{deadline}}</strong>.</p><p>batch0 is a live, online startup accelerator built for high schoolers: you build a real company alongside a cohort, with mentors, weekly sessions, and a Demo Day at the end. Applying is free, and we never take equity — the tuition is the whole cost.</p><p>If you've been on the fence, this is the moment to jump. Lock in the {{promo_percent}}% before {{deadline}} and you're set.</p>",
    cta_label: "Claim {{promo_percent}}% off",
    cta_url: "{{site_url}}/apply",
    // Percent, prices, and deadline are all resolved from the current promo at
    // send time (lib/email/pricing-vars), so the copy can never advertise a
    // discount the site isn't running.
    variables: [
      ...COMMON,
      { key: "promo_percent", label: "Discount percent", example: "10" },
      { key: "sale_price", label: "Sale price", example: "$117" },
      { key: "list_price", label: "List price", example: "$130" },
      { key: "deadline", label: "Offer deadline", example: "September 9" },
    ],
  },
  {
    key: "demo_day.ticket_invite",
    name: "Demo Day ticket",
    description:
      "Sent when an admin sends someone a paid Demo-Day-only ticket (/admin/demo-day/tickets). Edit the copy freely, but leave the button pointed at {{pay_url}} — that link is the ticket. The date and note aren't always known, so keep their {{tag|fallback}} form.",
    category: "transactional",
    subject: "Your batch0 Demo Day ticket — {{amount}}",
    preheader: "A {{amount}} ticket to Demo Day. Pay to confirm your spot.",
    body_html:
      "<h1>You're invited to Demo Day</h1><p>Hi {{first_name}} — the batch0 team has set aside a ticket for you to <strong>Demo Day</strong>, {{demo_day_when|date to be announced}}. It's the day every team pitches what they built.</p><p>This is a ticket to Demo Day only — not enrollment in the cohort. Your ticket is <strong>{{amount}}</strong>. Pay below to confirm your spot; you don't need a batch0 account.</p><p><em>{{note|We'd love to have you there.}}</em></p>",
    cta_label: "Pay {{amount}} & confirm",
    cta_url: "{{pay_url}}",
    variables: [
      ...COMMON,
      { key: "amount", label: "Ticket price", example: "$25", required: true },
      {
        key: "pay_url",
        label: "Payment link",
        example: "https://batch0.org/demo-day/ticket/…",
        required: true,
      },
      { key: "demo_day_when", label: "Demo Day date/time", example: "Saturday, November 14, 2026 at 1:00 PM ET" },
      { key: "cohort_name", label: "Cohort name", example: "Cohort 1" },
      { key: "note", label: "Note from the team", example: "Would love to have you there." },
    ],
  },
  {
    key: "demo_day.ticket_confirmed",
    name: "Demo Day ticket confirmed",
    description: "Sent when Stripe confirms a Demo Day ticket payment.",
    category: "transactional",
    subject: "You're confirmed for batch0 Demo Day",
    preheader: "Payment of {{amount}} received — you're on the list.",
    body_html:
      "<h1>You're confirmed</h1><p>We received your payment of <strong>{{amount}}</strong>, {{first_name}}. You're on the list for <strong>Demo Day</strong>, {{demo_day_when|date to be announced}}.</p><p>{{demo_day_details|We'll email you the joining details before the day.}}</p>",
    variables: [
      ...COMMON,
      { key: "amount", label: "Amount paid", example: "$25", required: true },
      { key: "demo_day_when", label: "Demo Day date/time", example: "Saturday, November 14, 2026 at 1:00 PM ET" },
      { key: "cohort_name", label: "Cohort name", example: "Cohort 1" },
      {
        key: "demo_day_details",
        label: "Where / how to join",
        example: "Where: 123 Main St. Join link: https://zoom.us/j/…",
      },
    ],
  },
  // --- Scholarships (migration 0071, lib/scholarships.ts) -------------------
  //
  // Every optional tag below is written in {{tag|fallback}} form on purpose.
  // sendTemplated falls back to the COMPILED template whenever a tag marked
  // `required` has no value, so marking something required that isn't always
  // known would silently make the admin's edits stop applying for exactly the
  // students whose emails differ most.
  {
    key: "scholarship.received",
    name: "Scholarship application received",
    description:
      "Sent the moment a student submits a scholarship application. Deliberately promises no decision date — students are usually deciding whether they can afford to enroll, and a missed date is worse than no date.",
    category: "transactional",
    subject: "We got your {{scholarship_name}} application",
    preheader: "Your application for the {{scholarship_name}} is in.",
    body_html:
      "<h1>Application received</h1><p>Thanks {{first_name}} — your application for the <strong>{{scholarship_name}}</strong> ({{award_summary}}) is in front of us.</p><p>We read these by hand, so it takes a few days. You'll get an email either way — you don't need to check back.</p><p>One scholarship per student, so hold off on applying to another until you hear from us.</p>",
    cta_label: "See your application",
    cta_url: "{{site_url}}/dashboard/scholarships",
    variables: [
      ...COMMON,
      {
        key: "scholarship_name",
        label: "Scholarship name",
        example: "Need-based grant",
        required: true,
      },
      {
        key: "award_summary",
        label: "What it's worth",
        example: "$50 off tuition",
        required: true,
      },
    ],
  },
  {
    key: "scholarship.awarded",
    name: "Scholarship awarded (money)",
    description:
      "Sent when a money scholarship is awarded. {{fulfillment_line}} is the load-bearing tag: it says either 'your tuition is lower at checkout' or 'this amount is being refunded to your card', depending on whether the student had already paid. Keep it in the body — without it the email can't tell them what actually happens next.",
    category: "transactional",
    subject: "You got the {{scholarship_name}}",
    preheader: "{{amount}} toward your batch0 tuition.",
    body_html:
      "<h1>You got it</h1><p>Congratulations {{first_name}} — you've been awarded the <strong>{{scholarship_name}}</strong>: <strong>{{award_summary}}</strong>.</p><p>{{fulfillment_line}}</p><p>{{perks_line}}</p><p><em>{{note|We're glad you're here.}}</em></p>",
    cta_label: "See your scholarship",
    cta_url: "{{site_url}}/dashboard/scholarships",
    variables: [
      ...COMMON,
      {
        key: "scholarship_name",
        label: "Scholarship name",
        example: "Need-based grant",
        required: true,
      },
      {
        key: "award_summary",
        label: "What it's worth",
        example: "$50 off tuition · 2 extra mentor calls",
        required: true,
      },
      { key: "amount", label: "Award amount", example: "$50", required: true },
      {
        key: "fulfillment_line",
        label: "Discount-or-refund sentence",
        example:
          "Your tuition is now $50 lower. The new price is already applied at checkout.",
        required: true,
      },
      {
        key: "perks_line",
        label: "The perks riding along, if any",
        example:
          "It also comes with: 2 extra mentor calls, AI co-founder boost. Everything is on your scholarship page.",
      },
      { key: "note", label: "Note from the team", example: "Loved your answers." },
    ],
  },
  {
    // The key predates 0074, when the only perk was mentor calls; it's kept so
    // copies admins have already edited stay attached. The template now
    // covers every perks-only award.
    key: "scholarship.awarded_calls",
    name: "Scholarship awarded (perks, no money)",
    description:
      "Sent when a scholarship with no money off tuition is awarded — mentor calls, feedback credits, Demo Day guest tickets, the AI boost, in any mix. {{award_summary}} lists what they got. Its whole job is getting the student to actually use it: a call never booked or a ticket never sent is the failure mode this kind of scholarship exists to avoid.",
    category: "transactional",
    subject: "You got the {{scholarship_name}} — {{award_summary}}",
    preheader: "{{award_summary}}, yours to use.",
    body_html:
      "<h1>You got it</h1><p>Congratulations {{first_name}} — you've been awarded the <strong>{{scholarship_name}}</strong>, on top of everything else in the program: <strong>{{award_summary}}</strong>.</p><p>{{perks_line}}</p><p>None of it expires during the cohort, but none of it does anything sitting unused. Use the first thing this week.</p><p><em>{{note|Make it count.}}</em></p>",
    cta_label: "See your scholarship",
    cta_url: "{{site_url}}/dashboard/scholarships",
    variables: [
      ...COMMON,
      {
        key: "scholarship_name",
        label: "Scholarship name",
        example: "Learner's scholarship",
        required: true,
      },
      {
        key: "award_summary",
        label: "What it's worth",
        example: "3 extra mentor calls · 1 feedback credit",
        required: true,
      },
      {
        key: "perks_line",
        label: "The perks as a sentence",
        example:
          "That's: 3 extra mentor calls, 1 feedback credit. Everything is on your scholarship page.",
        required: true,
      },
      { key: "calls", label: "Number of mentor calls (0 if none)", example: "3" },
      { key: "note", label: "Note from the team", example: "Make it count." },
    ],
  },
  {
    key: "demo_day.guest_ticket",
    name: "Demo Day guest ticket",
    description:
      "Sent to a guest when a scholarship holder sends them one of their complimentary Demo Day tickets. The guest has usually never heard of batch0, so {{host_name}} is the one thing on the email they recognise — keep it near the top. Nothing is owed, so never mention payment.",
    category: "transactional",
    subject: "{{host_name}} has invited you to batch0 Demo Day",
    preheader: "A guest ticket for Demo Day, from {{host_name}}.",
    body_html:
      "<h1>You're on the list</h1><p>{{host_name}} has sent you a guest ticket {{first_name}}. You're in for <strong>Demo Day</strong> — the day every founder in the cohort presents what they built. There's nothing to pay.</p><p><strong>When:</strong> {{demo_day_when|We'll confirm the date shortly}}<br><strong>Where:</strong> {{demo_day_where|Details to follow}}</p><p>{{join_url|We'll email you the joining details before the day.}}</p>",
    cta_label: "See the event",
    cta_url: "{{site_url}}/dashboard/events",
    variables: [
      ...COMMON,
      {
        key: "host_name",
        label: "The founder who sent it",
        example: "Ada Okonkwo",
        required: true,
      },
      { key: "demo_day_when", label: "When Demo Day is", example: "Saturday, November 14 at 1:00 PM ET" },
      { key: "demo_day_where", label: "Where it is", example: "Newark, NJ" },
      { key: "cohort_name", label: "Cohort", example: "Fall 2026" },
      { key: "join_url", label: "Join link for an online event", example: "https://zoom.us/j/…" },
    ],
  },
  {
    key: "scholarship.declined",
    name: "Scholarship declined",
    description:
      "Sent for every decline. Silence here is uniquely bad — the student is often waiting on this answer to decide whether they can enroll at all. Keep the line about their place being unaffected.",
    category: "transactional",
    subject: "Your {{scholarship_name}} application",
    preheader: "We couldn't award this one — your place is unaffected.",
    body_html:
      "<h1>About your scholarship application</h1><p>Hi {{first_name}} — we read your application for the <strong>{{scholarship_name}}</strong> carefully, and we weren't able to award it this time.</p><p><strong>This doesn't change your place at batch0.</strong> Your application and your spot in the cohort are exactly where they were.</p><p><em>{{note|We had more strong applications than spots.}}</em></p><p>If cost is what's standing between you and the program, reply to this email and tell us. We'd rather hear it than lose you over it.</p>",
    cta_label: "See other scholarships",
    cta_url: "{{site_url}}/dashboard/scholarships",
    variables: [
      ...COMMON,
      {
        key: "scholarship_name",
        label: "Scholarship name",
        example: "Merit award",
        required: true,
      },
      {
        key: "note",
        label: "Note from the reviewer",
        example: "We had more strong applications than spots this round.",
      },
    ],
  },
  {
    key: "scholarship.refunded",
    name: "Scholarship refund issued",
    description:
      "Sent only once the Stripe partial refund actually succeeds — never when it's merely queued. Keep the line about enrollment being unchanged: a refund email that reads like a cancellation causes real panic.",
    category: "transactional",
    subject: "{{amount}} refunded — {{scholarship_name}}",
    preheader: "{{amount}} is on its way back to your card.",
    body_html:
      "<h1>{{amount}} is on its way back</h1><p>Hi {{first_name}} — we've refunded <strong>{{amount}}</strong> to the card you paid your batch0 tuition with, as your <strong>{{scholarship_name}}</strong> award.</p><p>Most banks show it within 5–10 business days. It'll appear as a refund against the original charge rather than as a new payment.</p><p><strong>Your enrollment is unchanged.</strong> You're still in the cohort — this is a partial refund of tuition, not a cancellation.</p>",
    cta_label: "See your billing",
    cta_url: "{{site_url}}/dashboard/billing",
    variables: [
      ...COMMON,
      { key: "amount", label: "Refund amount", example: "$50", required: true },
      {
        key: "scholarship_name",
        label: "Scholarship name",
        example: "Need-based grant",
        required: true,
      },
    ],
  },
  {
    key: "scholarship.invite",
    name: "Scholarship invitation",
    description:
      "An admin nudging one student toward one scholarship. Exists because the students most likely to need the need-based award are the least likely to ask for it. Leave the button pointed at {{apply_url}}.",
    category: "lifecycle",
    subject: "A batch0 scholarship you should look at",
    preheader: "{{scholarship_name}} — {{award_summary}}.",
    body_html:
      "<h1>This one's worth a look</h1><p>Hi {{first_name}} — someone on the batch0 team thought the <strong>{{scholarship_name}}</strong> ({{award_summary}}) might be a fit for you.</p><p>It takes a few minutes to apply. Being invited isn't the same as being awarded, but it does mean a human here thinks you have a real shot.</p><p><em>{{note|Worth your time.}}</em></p>",
    cta_label: "Apply for it",
    cta_url: "{{apply_url}}",
    variables: [
      ...COMMON,
      {
        key: "scholarship_name",
        label: "Scholarship name",
        example: "Need-based grant",
        required: true,
      },
      {
        key: "award_summary",
        label: "What it's worth",
        example: "$50 off tuition",
        required: true,
      },
      {
        key: "apply_url",
        label: "Application link",
        example: "https://batch0.org/dashboard/scholarships/need-based-grant",
        required: true,
      },
      { key: "note", label: "Note from the team", example: "Worth your time." },
    ],
  },
  // -------------------------------------------------------------------------
  // Cohort comms — the in-cohort blasts an admin sends from the composer.
  //
  // Everything below targets the "Enrolled in a cohort" audience. Worth
  // knowing before editing the copy: a composer send only resolves the common
  // tags plus the live tuition tags (see lib/email/compose/actions.ts), so
  // anything cohort-specific is written either as plain prose or in the
  // `{{tag|fallback}}` form — the fallback is what actually ships. Copy that
  // depends on a tag nobody fills is copy with a hole in it.
  // -------------------------------------------------------------------------
  {
    key: "cohort.checkin_reminder",
    name: "Weekly check-in reminder",
    description:
      "The nudge to post this week's check-in. Send it from the composer to the “Enrolled in a cohort” audience, or hang it off a weekly scheduled automation — Sunday evening or Monday morning, so it lands with the week. Discord already DMs students who haven't posted (the checkin-nudge cron); this is the email half, and it reaches the ones who never linked Discord.",
    category: "lifecycle",
    subject: "{{first_name}}, your weekly check-in is open",
    preheader: "Three questions, two minutes — what you shipped, what's next, what's in the way.",
    body_html:
      "<h1>Two minutes, three questions.</h1>" +
      "<p>Hi {{first_name}},</p>" +
      "<p>This week's check-in is open. It's three boxes:</p>" +
      "<ul>" +
      "<li><strong>What did you accomplish this week?</strong> Whatever actually happened — shipped a page, ran four interviews, rewrote the pricing. Small counts.</li>" +
      "<li><strong>What's next?</strong> The next concrete thing, not the plan for the whole company.</li>" +
      "<li><strong>Any blockers?</strong> This is the one that matters most. Name what's in the way and someone can move it.</li>" +
      "</ul>" +
      "<p>A mentor reads every check-in and replies on it, so a blocker you write down on Monday usually has an answer attached to it by midweek. One you keep to yourself stays a blocker.</p>" +
      "<p>If this week was a write-off, post that. “Nothing shipped, school ate the week, here's what I'm doing about it” is a real check-in and a useful one — the point is the honest streak, not a highlight reel.</p>",
    cta_label: "Post this week's check-in",
    cta_url: "{{site_url}}/dashboard/checkin",
    variables: COMMON,
  },
  {
    key: "cohort.next_steps",
    name: "Next steps this week",
    description:
      "The weekly “here's what's next” blast for the “Enrolled in a cohort” audience. Written as a standing skeleton — swap the four steps for the real ones before each send, and keep it to four. A list of nine next steps is a list of zero next steps.",
    category: "broadcast",
    subject: "{{first_name}}, here's what's next this week",
    preheader: "Four things, in order. Start with the first one.",
    body_html:
      "<h1>Next steps.</h1>" +
      "<p>Hi {{first_name}},</p>" +
      "<p>Four things this week, in the order they're worth doing:</p>" +
      "<ol>" +
      "<li><strong>Work through this week's module.</strong> It's open in your course now, and everything else this week assumes it.</li>" +
      "<li><strong>Ship this week's deliverable.</strong> Rough and real beats polished and late — you'll get feedback on it, then you fix the top issue.</li>" +
      "<li><strong>Post your check-in.</strong> What you shipped, what's next, what's in the way. A mentor replies on it.</li>" +
      "<li><strong>Bring one question to office hours.</strong> Come with a specific one — “is this pricing insane” gets you further than “any advice?”</li>" +
      "</ol>" +
      "<p>If you're behind, don't try to catch up on all four. Do the deliverable, post the check-in saying you're behind, and we'll sort the rest out with you.</p>" +
      "<p>Stuck on something that isn't in this list? Reply to this email, or put it in your cohort's Discord — someone else is almost certainly stuck on the same thing.</p>",
    cta_label: "Open your dashboard",
    cta_url: "{{site_url}}/dashboard",
    variables: COMMON,
  },
  {
    key: "cohort.week3",
    name: "Week 3 — what to expect",
    description:
      "The week-3 preview, for the “Enrolled in a cohort” audience — send it the weekend before week 3 opens. Deliberately written about the SHAPE of the week (module, deliverable, check-in, office hours, live session) rather than a sprint title, because the week-3 module is cohort-scoped content: open /admin/course, read what week 3 actually is for this cohort, and name it in the second paragraph before you send.",
    category: "broadcast",
    subject: "Week 3 starts Monday — here's what to expect",
    preheader: "The week the idea has to turn into a thing.",
    body_html:
      "<h1>Week 3.</h1>" +
      "<p>Hi {{first_name}},</p>" +
      "<p>Week 3 of {{cohort_name|your cohort}} opens Monday. This is the stretch where it stops being an idea you can describe and starts being a thing you have to put in front of someone — the work shifts from deciding to building, and the deliverable at the end of it is something that exists.</p>" +
      "<p><strong>What lands this week:</strong></p>" +
      "<ul>" +
      "<li><strong>The week 3 module</strong>, in your course — lessons plus the deliverable it's building toward.</li>" +
      "<li><strong>The live session</strong>, on Zoom at the usual time. Recorded, so a conflict isn't a catastrophe, but the live one is where you can interrupt.</li>" +
      "<li><strong>Office hours</strong>, for the specific thing you're stuck on.</li>" +
      "<li><strong>Your check-in</strong>, same three questions as always.</li>" +
      "</ul>" +
      "<p><strong>What's expected of you:</strong> 5–10 focused hours, the deliverable shipped by the end of the week, and a check-in that tells the truth about how it went.</p>" +
      "<p><strong>What's normal right now, and isn't a problem:</strong> wanting to change your idea. Week 3 is when most founders look at what they validated and think “this isn't quite it.” That's the process working, not you failing — but bring it to office hours or your check-in before you rebuild everything on a hunch. A pivot you talked through on Tuesday costs you two days; one you discover on Sunday costs you the week.</p>" +
      "<p>Come in with the module watched and one question you actually want answered. That's the whole prep.</p>",
    cta_label: "Open week 3",
    cta_url: "{{site_url}}/dashboard/course",
    variables: [
      ...COMMON,
      { key: "cohort_name", label: "Cohort name", example: "Cohort 1" },
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
