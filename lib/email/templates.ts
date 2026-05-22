import { env } from "@/lib/env";

/** Shared HTML wrapper for all transactional emails. */
function layout(args: {
  preheader?: string;
  body: string;
  cta?: { url: string; label: string };
}) {
  const cta = args.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:32px 0">
         <tr><td style="border-radius:8px;background:#facc15">
           <a href="${args.cta.url}" style="display:inline-block;padding:12px 22px;font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:600;color:#000;text-decoration:none;border-radius:8px">
             ${args.cta.label}
           </a>
         </td></tr>
       </table>`
    : "";
  const preheader = args.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;color:transparent">${escape(
        args.preheader,
      )}</div>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;color:#e7e7e7;font-family:Inter,-apple-system,Arial,sans-serif">
${preheader}
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#0a0a0a;padding:32px 16px">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" width="560" style="max-width:560px;background:#111;border-radius:16px;border:1px solid rgba(255,255,255,0.08);overflow:hidden">
      <tr><td style="padding:28px 32px 16px 32px">
        <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em">
          Spark<span style="color:#facc15">Line</span> Youth
        </div>
      </td></tr>
      <tr><td style="padding:0 32px 32px 32px;font-size:15px;line-height:1.55;color:#e7e7e7">
        ${args.body}
        ${cta}
      </td></tr>
      <tr><td style="padding:18px 32px;border-top:1px solid rgba(255,255,255,0.06);font-size:12px;color:#888">
        <a href="${env.siteUrl}" style="color:#facc15;text-decoration:none">${env.siteUrl.replace(/^https?:\/\//, "")}</a> · Questions?
        <a href="mailto:${env.contactEmail}" style="color:#facc15;text-decoration:none">${env.contactEmail}</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function escape(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export const Templates = {
  welcome: (args: { name?: string | null }) => ({
    subject: "Welcome to SparkLine Youth",
    html: layout({
      preheader: "Your account is ready.",
      body: `
        <h1 style="margin:0 0 12px 0;font-size:22px;color:#fff">Welcome${args.name ? `, ${escape(args.name)}` : ""}.</h1>
        <p>Your SparkLine Youth account is ready. Apply when you're ready — applications are reviewed on a rolling basis.</p>
      `,
      cta: { url: `${env.siteUrl}/apply`, label: "Start your application" },
    }),
  }),

  applicationReceived: (args: { name?: string | null }) => ({
    subject: "We got your SparkLine Youth application",
    html: layout({
      preheader: "We'll review and get back to you soon.",
      body: `
        <h1 style="margin:0 0 12px 0;font-size:22px;color:#fff">Application received</h1>
        <p>Thanks${args.name ? `, ${escape(args.name)}` : ""} — we have your application and will review it within a few days. You'll get an email when there's a decision.</p>
      `,
      cta: { url: `${env.siteUrl}/dashboard/application`, label: "View application" },
    }),
  }),

  applicationAccepted: (args: { name?: string | null; cohortName: string; priceCents: number }) => ({
    subject: "You're in — accepted to SparkLine Youth",
    html: layout({
      preheader: `Pay $${(args.priceCents / 100).toFixed(0)} to lock in your seat.`,
      body: `
        <h1 style="margin:0 0 12px 0;font-size:22px;color:#facc15">You're in.</h1>
        <p>Welcome to <strong>${escape(args.cohortName)}</strong>${args.name ? `, ${escape(args.name)}` : ""}. Your one-time enrollment fee is <strong>$${(args.priceCents / 100).toFixed(0)}</strong>. Pay below to lock in your seat.</p>
      `,
      cta: { url: `${env.siteUrl}/dashboard/application`, label: "Pay & enroll" },
    }),
  }),

  applicationRejected: (args: { name?: string | null; notes?: string | null }) => ({
    subject: "Update on your SparkLine Youth application",
    html: layout({
      preheader: "Decision on your application.",
      body: `
        <p>Hi${args.name ? ` ${escape(args.name)}` : ""},</p>
        <p>Thanks for applying to SparkLine Youth. After reviewing your application, we're unable to offer you a seat in this cohort. We hope you'll apply again next time.</p>
        ${args.notes ? `<p style="margin-top:16px;padding:12px;border-left:3px solid rgba(255,255,255,0.2);color:#bbb">${escape(args.notes)}</p>` : ""}
      `,
    }),
  }),

  paymentReceipt: (args: { name?: string | null; amountCents: number; cohortName: string }) => ({
    subject: "Payment received — you're enrolled",
    html: layout({
      preheader: "You're enrolled in SparkLine Youth.",
      body: `
        <h1 style="margin:0 0 12px 0;font-size:22px;color:#facc15">Enrolled</h1>
        <p>We received your payment of <strong>$${(args.amountCents / 100).toFixed(2)}</strong> for ${escape(args.cohortName)}. Your course access is unlocked. Welcome aboard${args.name ? `, ${escape(args.name)}` : ""}.</p>
      `,
      cta: { url: `${env.siteUrl}/dashboard/course`, label: "Open course" },
    }),
  }),

  weeklyDigest: (args: {
    apps: number;
    accepted: number;
    paid: number;
    revenue: number;
  }) => ({
    subject: "SparkLine Youth weekly digest",
    html: layout({
      preheader: `${args.apps} apps · ${args.paid} new enrollments · $${(args.revenue / 100).toFixed(0)} revenue`,
      body: `
        <h1 style="margin:0 0 12px 0;font-size:20px;color:#fff">Weekly digest</h1>
        <ul style="padding-left:18px">
          <li>${args.apps} new applications</li>
          <li>${args.accepted} accepted</li>
          <li>${args.paid} new enrollments</li>
          <li>$${(args.revenue / 100).toFixed(2)} revenue</li>
        </ul>
      `,
      cta: { url: `${env.siteUrl}/admin`, label: "Open admin panel" },
    }),
  }),

  eventReminder: (args: {
    title: string;
    startsAt: string;
    zoomUrl: string | null;
  }) => ({
    subject: `Coming up: ${args.title}`,
    html: layout({
      preheader: new Date(args.startsAt).toLocaleString(),
      body: `
        <h1 style="margin:0 0 12px 0;font-size:20px;color:#fff">${escape(args.title)}</h1>
        <p>Starts <strong>${new Date(args.startsAt).toLocaleString()}</strong>.</p>
        ${args.zoomUrl ? `<p>Join: <a href="${args.zoomUrl}" style="color:#facc15">${escape(args.zoomUrl)}</a></p>` : ""}
      `,
      cta: { url: `${env.siteUrl}/dashboard/events`, label: "All events" },
    }),
  }),

  /**
   * Weekly "students who went quiet" digest for mentors + admins.
   * Lists each at-risk student with the assigned mentor's name (or a
   * placeholder when unassigned) so the recipient knows whose turn it
   * is to reach out.
   */
  atRiskDigest: (args: {
    recipientName: string | null;
    scope: "admin" | "mentor";
    cohortName: string | null;
    students: Array<{
      name: string;
      cohortName: string | null;
      mentorName: string | null;
      weeksSilent: number;
    }>;
  }) => {
    const rows = args.students
      .map(
        (s) => `
          <li style="margin:0 0 10px 0">
            <strong style="color:#fff">${escape(s.name)}</strong>
            ${s.cohortName ? `<span style="color:#888"> · ${escape(s.cohortName)}</span>` : ""}
            <br>
            <span style="color:#bbb">${s.weeksSilent} week${s.weeksSilent === 1 ? "" : "s"} without a check-in${
              s.mentorName
                ? ` · mentor <strong style="color:#fff">${escape(s.mentorName)}</strong>`
                : args.scope === "admin"
                  ? " · <span style=\"color:#facc15\">no mentor assigned</span>"
                  : ""
            }</span>
          </li>`,
      )
      .join("");
    const subjectScope =
      args.scope === "mentor"
        ? "your students"
        : args.cohortName
          ? args.cohortName
          : "the cohort";
    return {
      subject: `At-risk check: ${subjectScope}`,
      html: layout({
        preheader: `${args.students.length} student${args.students.length === 1 ? "" : "s"} flagged this week`,
        body: `
          <h1 style="margin:0 0 12px 0;font-size:20px;color:#fff">Quiet for ${args.students[0]?.weeksSilent ?? 2}+ weeks</h1>
          <p>The following${args.scope === "mentor" ? " students you mentor" : ""} haven't checked in for two weeks running. A quick DM tends to be enough to pull them back.</p>
          <ul style="padding-left:18px;margin:18px 0 0 0">${rows}</ul>
        `,
        cta: {
          url: `${env.siteUrl}${args.scope === "mentor" ? "/mentor/students" : "/admin/students"}`,
          label: args.scope === "mentor" ? "Open mentor panel" : "Open admin panel",
        },
      }),
    };
  },

  /**
   * "Your card is expiring soon" — fires from the daily card-expiring
   * cron when a customer's default payment method is within 30 days of
   * expiring. Includes a deep link into the Stripe customer portal so
   * the student can update without contacting support.
   */
  cardExpiring: (args: {
    name?: string | null;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    portalUrl: string;
  }) => ({
    subject: "Your card on file is expiring",
    html: layout({
      preheader: `${args.brand} •••• ${args.last4} expires ${args.expMonth}/${String(args.expYear).slice(-2)}`,
      body: `
        <h1 style="margin:0 0 12px 0;font-size:20px;color:#fff">Heads up${args.name ? `, ${escape(args.name)}` : ""}</h1>
        <p>Your <strong>${escape(args.brand)} ${args.last4}</strong> on file expires <strong>${args.expMonth}/${String(args.expYear).slice(-2)}</strong>. If you don't update it, any upcoming fees or fines on your account may fail to charge.</p>
        <p style="margin-top:10px;color:#888">No payment is being charged right now — this is just a heads-up.</p>
      `,
      cta: { url: args.portalUrl, label: "Update card" },
    }),
  }),

  /**
   * Weekly cohort highlights — one email per active cohort, sent to
   * every enrolled student. Pulls real check-in copy so the cohort
   * sees what teammates have been shipping, not generic platitudes.
   */
  cohortDigest: (args: {
    cohortName: string;
    weekRange: string;
    totals: {
      checkins: number;
      activeStudents: number;
      enrolled: number;
    };
    highlights: { name: string | null; accomplished: string }[];
    upcomingEvents: { title: string; startsAt: string }[];
  }) => {
    const highlightItems = args.highlights
      .map(
        (h) => `
          <li style="margin:0 0 12px 0">
            <strong style="color:#fff">${escape(h.name ?? "A student")}</strong>
            <br>
            <span style="color:#bbb">${escape(h.accomplished)}</span>
          </li>`,
      )
      .join("");
    const eventItems = args.upcomingEvents
      .map(
        (e) =>
          `<li style="margin:0 0 6px 0;color:#bbb">${escape(e.title)} · <span style="color:#888">${new Date(e.startsAt).toLocaleString()}</span></li>`,
      )
      .join("");
    return {
      subject: `${args.cohortName} · what shipped this week`,
      html: layout({
        preheader: `${args.totals.checkins} check-ins from ${args.totals.activeStudents} students`,
        body: `
          <h1 style="margin:0 0 6px 0;font-size:22px;color:#fff">This week in ${escape(args.cohortName)}</h1>
          <p style="color:#888;margin:0 0 18px 0">${escape(args.weekRange)}</p>
          <p style="margin:0 0 18px 0">${args.totals.activeStudents} of ${args.totals.enrolled} students checked in. Here's what they shipped:</p>
          ${
            args.highlights.length > 0
              ? `<ul style="padding-left:18px;margin:0 0 20px 0">${highlightItems}</ul>`
              : `<p style="color:#888">No check-ins this week — be the first next week.</p>`
          }
          ${
            args.upcomingEvents.length > 0
              ? `<h2 style="font-size:14px;color:#facc15;margin:24px 0 10px 0;text-transform:uppercase;letter-spacing:0.08em">Coming up</h2>
                 <ul style="padding-left:18px;margin:0">${eventItems}</ul>`
              : ""
          }
        `,
        cta: {
          url: `${env.siteUrl}/dashboard`,
          label: "Open dashboard",
        },
      }),
    };
  },

  /**
   * Demo Day team recap — sent to founders after admin generates the
   * per-team recap. Includes weighted leaderboard rank, average judge
   * score, and the AI-written narrative.
   */
  demoDayRecap: (args: {
    teamName: string;
    rank: number | null;
    totalTeams: number;
    weightedPct: number | null;
    reactionCount: number;
    summary: string;
    teamSlug?: string | null;
  }) => ({
    subject: `Demo Day recap — ${args.teamName}`,
    html: layout({
      preheader:
        args.rank != null
          ? `Ranked #${args.rank} of ${args.totalTeams}`
          : "Your Demo Day recap is here",
      body: `
        <h1 style="margin:0 0 12px 0;font-size:22px;color:#facc15">Demo Day recap</h1>
        <p>Here's how ${escape(args.teamName)} landed.</p>
        <div style="margin:18px 0;padding:14px 16px;border:1px solid rgba(255,255,255,0.08);border-radius:12px">
          ${
            args.rank != null
              ? `<p style="margin:0;color:#fff;font-size:16px"><strong>#${args.rank}</strong> of ${args.totalTeams} teams</p>`
              : ""
          }
          ${
            args.weightedPct != null
              ? `<p style="margin:6px 0 0 0;color:#bbb">Weighted score: <strong style="color:#fff">${args.weightedPct.toFixed(1)}%</strong></p>`
              : ""
          }
          <p style="margin:6px 0 0 0;color:#bbb">Audience reactions: <strong style="color:#fff">${args.reactionCount}</strong></p>
        </div>
        <p style="white-space:pre-wrap">${escape(args.summary)}</p>
      `,
      cta: args.teamSlug
        ? {
            url: `${env.siteUrl}/teams/${args.teamSlug}`,
            label: "Open team page",
          }
        : { url: `${env.siteUrl}/dashboard`, label: "Open dashboard" },
    }),
  }),

  /**
   * Founder weekly recap for parents + mentors. Summarizes the team's
   * activity that week — check-ins, milestones, blockers — in plain
   * language so parents can follow along without needing an account.
   */
  founderWeeklyRecap: (args: {
    teamName: string;
    weekRange: string;
    summary: string;
    headlines: string[];
    blockers: string[];
  }) => {
    const headlineItems = args.headlines
      .map(
        (h) =>
          `<li style="margin:0 0 6px 0;color:#ddd">${escape(h)}</li>`,
      )
      .join("");
    const blockerItems = args.blockers
      .map(
        (b) =>
          `<li style="margin:0 0 6px 0;color:#ddd">${escape(b)}</li>`,
      )
      .join("");
    return {
      subject: `Weekly recap — ${args.teamName}`,
      html: layout({
        preheader: `What ${args.teamName} did this week`,
        body: `
          <h1 style="margin:0 0 6px 0;font-size:20px;color:#fff">${escape(args.teamName)} — weekly recap</h1>
          <p style="color:#888;margin:0 0 18px 0">${escape(args.weekRange)}</p>
          <p style="white-space:pre-wrap">${escape(args.summary)}</p>
          ${
            args.headlines.length > 0
              ? `<h2 style="font-size:13px;color:#facc15;margin:20px 0 6px 0;text-transform:uppercase;letter-spacing:0.08em">Wins</h2>
                 <ul style="padding-left:18px;margin:0">${headlineItems}</ul>`
              : ""
          }
          ${
            args.blockers.length > 0
              ? `<h2 style="font-size:13px;color:#facc15;margin:20px 0 6px 0;text-transform:uppercase;letter-spacing:0.08em">Blockers</h2>
                 <ul style="padding-left:18px;margin:0">${blockerItems}</ul>`
              : ""
          }
        `,
      }),
    };
  },

  /**
   * SAFE-offer notification. Sent to all team members when an investor
   * sends an offer through the platform. Body intentionally short — the
   * legal terms live in the offer document, not the email.
   */
  safeOfferSent: (args: {
    teamName: string;
    investorName: string | null;
    amountCents: number;
    valuationCapCents: number | null;
    offerId: string;
  }) => ({
    subject: `${args.investorName ?? "Someone"} sent ${args.teamName} a SAFE`,
    html: layout({
      preheader: `Offer: $${(args.amountCents / 100).toLocaleString()}`,
      body: `
        <h1 style="margin:0 0 12px 0;font-size:22px;color:#facc15">SAFE offer received</h1>
        <p><strong>${escape(args.investorName ?? "An investor")}</strong> sent a SAFE to <strong>${escape(args.teamName)}</strong>:</p>
        <ul style="padding-left:18px;margin:14px 0">
          <li>Amount: <strong style="color:#fff">$${(args.amountCents / 100).toLocaleString()}</strong></li>
          ${
            args.valuationCapCents != null
              ? `<li>Valuation cap: <strong style="color:#fff">$${(args.valuationCapCents / 100).toLocaleString()}</strong></li>`
              : ""
          }
        </ul>
        <p>Open the offer to review and sign. Show it to a parent / guardian / advisor first — this is a real legal document even if you don't accept right away.</p>
      `,
      cta: {
        url: `${env.siteUrl}/dashboard/team/offers/${args.offerId}`,
        label: "Review the offer",
      },
    }),
  }),
};
