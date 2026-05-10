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
          Spark<span style="color:#facc15">Line</span>
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
    subject: "Welcome to SparkLine",
    html: layout({
      preheader: "Your account is ready.",
      body: `
        <h1 style="margin:0 0 12px 0;font-size:22px;color:#fff">Welcome${args.name ? `, ${escape(args.name)}` : ""}.</h1>
        <p>Your SparkLine account is ready. Apply when you're ready — applications are reviewed on a rolling basis.</p>
      `,
      cta: { url: `${env.siteUrl}/apply`, label: "Start your application" },
    }),
  }),

  applicationReceived: (args: { name?: string | null }) => ({
    subject: "We got your SparkLine application",
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
    subject: "You're in — accepted to SparkLine",
    html: layout({
      preheader: "Pay $97 to lock in your seat.",
      body: `
        <h1 style="margin:0 0 12px 0;font-size:22px;color:#facc15">You're in.</h1>
        <p>Welcome to <strong>${escape(args.cohortName)}</strong>${args.name ? `, ${escape(args.name)}` : ""}. Your one-time enrollment fee is <strong>$${(args.priceCents / 100).toFixed(0)}</strong>. Pay below to lock in your seat.</p>
      `,
      cta: { url: `${env.siteUrl}/dashboard/application`, label: "Pay & enroll" },
    }),
  }),

  applicationRejected: (args: { name?: string | null; notes?: string | null }) => ({
    subject: "Update on your SparkLine application",
    html: layout({
      preheader: "Decision on your application.",
      body: `
        <p>Hi${args.name ? ` ${escape(args.name)}` : ""},</p>
        <p>Thanks for applying to SparkLine. After reviewing your application, we're unable to offer you a seat in this cohort. We hope you'll apply again next time.</p>
        ${args.notes ? `<p style="margin-top:16px;padding:12px;border-left:3px solid rgba(255,255,255,0.2);color:#bbb">${escape(args.notes)}</p>` : ""}
      `,
    }),
  }),

  paymentReceipt: (args: { name?: string | null; amountCents: number; cohortName: string }) => ({
    subject: "Payment received — you're enrolled",
    html: layout({
      preheader: "You're enrolled in SparkLine.",
      body: `
        <h1 style="margin:0 0 12px 0;font-size:22px;color:#facc15">Enrolled</h1>
        <p>We received your payment of <strong>$${(args.amountCents / 100).toFixed(2)}</strong> for ${escape(args.cohortName)}. Your course access is unlocked. Welcome aboard${args.name ? `, ${escape(args.name)}` : ""}.</p>
      `,
      cta: { url: `${env.siteUrl}/dashboard/course`, label: "Open course" },
    }),
  }),

  assignmentPosted: (args: { title: string; cohortName: string; dueAt: string | null; assignmentId: string }) => ({
    subject: `New assignment: ${args.title}`,
    html: layout({
      preheader: args.dueAt ? `Due ${new Date(args.dueAt).toLocaleString()}` : "New homework posted",
      body: `
        <h1 style="margin:0 0 12px 0;font-size:20px;color:#fff">${escape(args.title)}</h1>
        <p>A new assignment has been posted in ${escape(args.cohortName)}.</p>
        ${args.dueAt ? `<p>Due <strong>${new Date(args.dueAt).toLocaleString()}</strong>.</p>` : ""}
      `,
      cta: {
        url: `${env.siteUrl}/dashboard/assignments/${args.assignmentId}`,
        label: "Open assignment",
      },
    }),
  }),

  assignmentGraded: (args: { title: string; grade: string | null; assignmentId: string }) => ({
    subject: `Graded: ${args.title}`,
    html: layout({
      preheader: args.grade ? `Grade: ${args.grade}` : "Your submission was graded",
      body: `
        <p>Your submission for <strong>${escape(args.title)}</strong> has been graded${args.grade ? ` — <strong>${escape(args.grade)}</strong>` : ""}. View the feedback below.</p>
      `,
      cta: {
        url: `${env.siteUrl}/dashboard/assignments/${args.assignmentId}`,
        label: "View feedback",
      },
    }),
  }),

  assignmentDueSoon: (args: { title: string; dueAt: string; assignmentId: string }) => ({
    subject: `Reminder: ${args.title} due soon`,
    html: layout({
      preheader: `Due ${new Date(args.dueAt).toLocaleString()}`,
      body: `
        <p><strong>${escape(args.title)}</strong> is due <strong>${new Date(args.dueAt).toLocaleString()}</strong>. Don't forget to submit.</p>
      `,
      cta: {
        url: `${env.siteUrl}/dashboard/assignments/${args.assignmentId}`,
        label: "Open assignment",
      },
    }),
  }),

  weeklyDigest: (args: {
    apps: number;
    accepted: number;
    paid: number;
    revenue: number;
  }) => ({
    subject: "SparkLine weekly digest",
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
};
