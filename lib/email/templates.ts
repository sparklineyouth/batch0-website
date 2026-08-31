import { env } from "@/lib/env";
import { fmtDateOnly } from "@/lib/pre-cohort";
import { emailLayout as layout, escapeEmail as escape } from "@/lib/email/layout";

// The shell and the escaper live in lib/email/layout.ts so the compiled
// templates below and the admin-authored ones in `email_templates` render
// inside the same chrome. See lib/email/render.ts for the database path.

/**
 * The brushed-silver Founder Pass card, as an email-safe table.
 *
 * Every email client is a different browser from 2003, so the "shine" and the
 * "float" are each built twice — once properly, once as something that still
 * looks deliberate when the proper version is thrown away:
 *
 *   SHINE   `background` carries a multi-stop linear-gradient whose bright
 *           band at 48-52% is the highlight raking across the metal. Apple
 *           Mail, iOS Mail and Outlook.com render it; Gmail's web client and
 *           Outlook's Word engine drop background-image entirely — which is
 *           why the same cell also carries a `bgcolor` of the gradient's mid
 *           tone. Those clients show a clean solid-silver card rather than a
 *           transparent hole, and nothing looks broken.
 *
 *   FLOAT   `box-shadow` does the real lift where it's supported. Underneath,
 *           two decorative rows fake it everywhere else: a 3px darker band
 *           reading as the card's milled edge, then a soft radial fade for the
 *           cast shadow. Where gradients are stripped, the second row collapses
 *           to blank space and the edge alone still reads as thickness.
 *
 * Nothing load-bearing lives here. The card carries the serial, the tier and
 * the holder's name — all of which appear again as plain text in the body and
 * in the text/plain part — so a client that renders none of this still
 * delivers a complete, redeemable pass. The code is deliberately NOT on the
 * card: it has to survive on the worst possible client.
 */
function silverPassCard(args: {
  serial: string;
  code: string;
  tierLabel: string;
  holder?: string | null;
}) {
  // Mid-tone of the gradient below. Whatever this is, it must be light enough
  // for the near-black wordmark to stay legible, because in Gmail this colour
  // IS the card.
  const SILVER_FALLBACK = "#c6ccd5";
  const SILVER_GRADIENT =
    "linear-gradient(135deg," +
    "#fbfcfd 0%," +
    "#e2e6ec 14%," +
    "#b6bec9 30%," +
    "#9aa3b0 42%," +
    "#f6f8fa 50%," + // the highlight raking across
    "#a8b1bd 58%," +
    "#c8ced7 74%," +
    "#eef1f5 90%," +
    "#dde1e8 100%)";

  const holder = (args.holder ?? "").trim();

  return `
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:4px 0 28px 0">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="380" style="max-width:380px;width:100%">
        <tr>
          <td bgcolor="${SILVER_FALLBACK}" style="background:${SILVER_FALLBACK};background:${SILVER_GRADIENT};border-radius:14px;padding:22px 24px;box-shadow:0 18px 38px rgba(0,0,0,0.55);">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td align="left" style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:17px;font-weight:700;letter-spacing:-0.01em;color:#14161a;">
                  batch<span style="color:#9a7200">0</span>
                </td>
                <td align="right" style="font-family:Inter,Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#5c636e;">
                  Founder Pass
                </td>
              </tr>
              <tr>
                <td colspan="2" style="padding:22px 0 0 0;font-family:Inter,Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#5c636e;">
                  Code
                </td>
              </tr>
              <tr>
                <td colspan="2" style="padding:4px 0 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:30px;font-weight:700;letter-spacing:0.12em;color:#14161a;line-height:1.05;word-break:break-all;">
                  ${escape(args.code)}
                </td>
              </tr>
              <tr>
                <td colspan="2" style="padding:14px 0 0 0;">
                  <div style="height:1px;background:rgba(20,22,26,0.18);line-height:1px;font-size:0">&nbsp;</div>
                </td>
              </tr>
              <tr>
                <td align="left" style="padding:12px 0 0 0;font-family:Inter,Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#3d434c;">
                  ${escape(args.tierLabel)}
                  <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:0.06em;color:#5c636e;">&nbsp;&nbsp;${escape(args.serial)}</span>
                </td>
                <td align="right" style="padding:12px 0 0 0;font-family:Inter,Arial,sans-serif;font-size:11px;color:#5c636e;">
                  ${holder ? escape(holder) : "&nbsp;"}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Milled edge: the card's thickness, so it reads as an object even
             with every gradient and shadow stripped. -->
        <tr><td style="padding:0 6px"><div style="height:3px;background:#6e7681;border-radius:0 0 10px 10px;line-height:3px;font-size:0">&nbsp;</div></td></tr>
        <!-- Cast shadow. Collapses to blank space where radial-gradient is
             unsupported, which costs nothing. -->
        <tr><td><div style="height:16px;background:radial-gradient(ellipse at 50% 0%, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0) 72%);line-height:16px;font-size:0">&nbsp;</div></td></tr>
      </table>
    </td></tr>
  </table>`;
}

export const Templates = {
  /**
   * Admin-composed blast email (the /admin/email/blast composer). Body
   * arrives as plain text — blank lines become paragraphs, single
   * newlines become line breaks, and everything is escaped since admins
   * write copy, not HTML. Personalization ({{name}}) happens before
   * this is called, per recipient.
   */
  blast: (args: {
    bodyText: string;
    preheader?: string | null;
    cta?: { url: string; label: string } | null;
  }) => ({
    html: layout({
      preheader: args.preheader ?? undefined,
      body: args.bodyText
        .trim()
        .split(/\n{2,}/)
        .map(
          (p) =>
            `<p style="margin:0 0 14px 0">${escape(p).replace(/\n/g, "<br>")}</p>`,
        )
        .join(""),
      cta: args.cta ?? undefined,
    }),
  }),

  /**
   * Password reset. The link is a one-time recovery token minted by
   * `auth.admin.generateLink` and pointed at our own /auth/confirm route —
   * see app/(auth)/forgot-password/actions.ts. Supabase's built-in mailer is
   * deliberately not used: it sends an unbranded message from a Supabase
   * address, and its free-tier limit (a couple of emails an hour, project-
   * wide) means most reset requests silently never arrive.
   *
   * The URL is printed in full underneath the button because reset mail is
   * the one email people open in a client that strips buttons, and a reset
   * they can't complete is a locked-out user emailing support.
   */
  passwordReset: (args: { url: string; expiresInMinutes?: number }) => ({
    subject: "Reset your batch0 password",
    html: layout({
      preheader: "A link to set a new password. Expires in an hour.",
      body: `
        <h1 style="margin:0 0 12px 0;font-size:22px;color:#fff">Reset your password</h1>
        <p>Use the link below to set a new password for your batch0 account. It works once and expires in ${
          args.expiresInMinutes ?? 60
        } minutes.</p>
        <p style="color:#888">If you didn't ask for this, you can ignore this email — your password won't change until someone opens the link.</p>
      `,
      cta: { url: args.url, label: "Set a new password" },
      footNote: `Button not working? Paste this into your browser:<br><a href="${args.url}" style="color:#ffbb00;text-decoration:none">${args.url}</a>`,
    }),
    text: `Reset your batch0 password

Open this link to set a new password. It works once and expires in ${
      args.expiresInMinutes ?? 60
    } minutes:

${args.url}

If you didn't ask for this, ignore this email — your password won't change until someone opens the link.

${env.siteUrl}`,
  }),

  welcome: (args: { name?: string | null }) => ({
    subject: "Welcome to batch0",
    html: layout({
      preheader: "Your account is ready.",
      body: `
        <h1 style="margin:0 0 12px 0;font-size:22px;color:#fff">Welcome${args.name ? `, ${escape(args.name)}` : ""}.</h1>
        <p>Your batch0 account is ready. Apply when you're ready — applications are reviewed on a rolling basis.</p>
      `,
      cta: { url: `${env.siteUrl}/apply`, label: "Start your application" },
    }),
  }),

  applicationReceived: (args: { name?: string | null }) => ({
    subject: "We got your batch0 application",
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
    subject: "You're in — accepted to batch0",
    html: layout({
      preheader: `Pay $${(args.priceCents / 100).toFixed(0)} to lock in your seat.`,
      body: `
        <h1 style="margin:0 0 12px 0;font-size:22px;color:#ffbb00">You're in.</h1>
        <p>Welcome to <strong>${escape(args.cohortName)}</strong>${args.name ? `, ${escape(args.name)}` : ""}. Your one-time enrollment fee is <strong>$${(args.priceCents / 100).toFixed(0)}</strong>. Pay below to lock in your seat.</p>
      `,
      cta: { url: `${env.siteUrl}/dashboard/accepted`, label: "Pay & enroll" },
    }),
  }),

  applicationWaitlisted: (args: {
    name?: string | null;
    cohortName: string;
    notes?: string | null;
  }) => ({
    subject: "You're on the batch0 waitlist",
    html: layout({
      preheader: "Not a no — a seat may still open up.",
      body: `
        <h1 style="margin:0 0 12px 0;font-size:22px;color:#fff">You're on the waitlist</h1>
        <p>Hi${args.name ? ` ${escape(args.name)}` : ""},</p>
        <p>Your application to <strong>${escape(args.cohortName)}</strong> made the cut for the waitlist. That's not a no — seats open when admitted applicants don't enroll, and waitlisted applications are the first we return to.</p>
        <p>There's nothing you need to do. If a seat opens, you'll get an acceptance email with payment instructions; if the cohort fills, we'll tell you that too.</p>
        ${args.notes ? `<p style="margin-top:16px;padding:12px;border-left:3px solid rgba(255,255,255,0.2);color:#bbb">${escape(args.notes)}</p>` : ""}
      `,
      cta: { url: `${env.siteUrl}/dashboard/application`, label: "View your application" },
    }),
  }),

  applicationRejected: (args: { name?: string | null; notes?: string | null }) => ({
    subject: "Update on your batch0 application",
    html: layout({
      preheader: "Decision on your application.",
      body: `
        <p>Hi${args.name ? ` ${escape(args.name)}` : ""},</p>
        <p>Thanks for applying to batch0. After reviewing your application, we're unable to offer you a seat in this cohort. We hope you'll apply again next time.</p>
        ${args.notes ? `<p style="margin-top:16px;padding:12px;border-left:3px solid rgba(255,255,255,0.2);color:#bbb">${escape(args.notes)}</p>` : ""}
      `,
    }),
  }),

  /**
   * "Your Founder Pass feedback is ready" — sent when the team delivers a
   * feedback-credit request. The written feedback lives on the pass page (it's
   * often long and formatted), so this just points the holder to it.
   */
  founderPassFeedbackReady: (args: {
    name?: string | null;
    topicLabel: string;
  }) => ({
    subject: "Your Founder Pass feedback is ready",
    html: layout({
      preheader: `Feedback on your ${args.topicLabel.toLowerCase()}.`,
      body: `
        <h1 style="margin:0 0 12px 0;font-size:20px;color:#ffbb00">Your feedback is ready</h1>
        <p>Hi${args.name ? ` ${escape(args.name)}` : ""}, we've written up feedback on your <strong>${escape(args.topicLabel.toLowerCase())}</strong>. Read it on your pass.</p>
      `,
      cta: { url: `${env.siteUrl}/pass`, label: "Read your feedback" },
    }),
  }),

  /**
   * A virtual Founder Pass — the code itself, sent to someone who was never
   * handed a printed card (app/admin/passes/actions.ts, migrations 0054/0055).
   *
   * This email IS the pass. Everything else in this file points at something
   * the recipient can go and re-read; here the code exists in exactly two
   * places, this message and the admin's screen at the moment of sending, and
   * the database holds only a peppered hash of it.
   *
   * So the code is printed THREE times, on purpose, each surviving a
   * different kind of client:
   *
   *   1. On the card, as its hero line — the thing it is, rendered as the
   *      object it stands for.
   *   2. In the footnote, as plain inline text — this is the copy that
   *      survives a client which strips gradients, rounded corners and
   *      background images, i.e. the card collapsing to a grey box.
   *   3. In the text/plain part, for clients rendering no HTML at all.
   *
   * It is deliberately NOT hidden behind the CTA button alone. Nobody should
   * ever be unable to redeem because their mail client is old.
   *
   * `perkLines` comes from tierPerkLines() rather than being written here, so
   * this email, the admin preview and the holder's own pass page quote one
   * source. An email promising a credit the pass page doesn't show is worse
   * than no email.
   *
   * `note` is the admin's own line about why this person is getting one. It
   * is escaped and rendered as a quote, never as the subject or a header —
   * it's an internal aside made visible, not copy we wrote for the recipient.
   */
  founderPassInvite: (args: {
    code: string;
    serial: number;
    tierLabel: string;
    perkLines: string[];
    /** True for the tier every printed card carries — see the subject below. */
    isStandard: boolean;
    recipientName?: string | null;
    note?: string | null;
  }) => {
    const redeemUrl = `${env.siteUrl}/pass?code=${encodeURIComponent(args.code)}`;
    const serialLabel = `#${String(args.serial).padStart(3, "0")}`;
    const first = (args.recipientName ?? "").trim().split(/\s+/)[0] ?? "";
    const greeting = first ? `Hi ${escape(first)},` : "Hi,";
    return {
      // The tier only earns a place in the subject line when it's actually
      // special. "Your batch0 Founder Pass — standard" reads as a downgrade of
      // something that isn't one, and standard is what a printed card carries.
      subject: args.isStandard
        ? "Your batch0 Founder Pass"
        : `Your batch0 Founder Pass — ${args.tierLabel.toLowerCase()}`,
      html: layout({
        preheader: `Pass ${serialLabel} · ${args.tierLabel} · redeem it at ${env.siteUrl.replace(/^https?:\/\//, "")}/pass`,
        body: `
          ${silverPassCard({
            serial: serialLabel,
            code: args.code.toUpperCase(),
            tierLabel: args.tierLabel,
            holder: args.recipientName ?? null,
          })}
          <h1 style="margin:0 0 12px 0;font-size:22px;color:#ffbb00">Your Founder Pass</h1>
          <p>${greeting} someone at batch0 ${first ? "put a Founder Pass in your name" : "set a Founder Pass aside for you"} — <strong>${escape(serialLabel)}</strong>, issued as <strong>${escape(args.tierLabel)}</strong>. It's the same pass that comes on our 3D-printed cards; this one skipped the plastic.</p>
          <p style="margin:0 0 10px 0">The button below opens your pass with the code already filled in — you don't have to type it. It binds the pass to your account, and carries:</p>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 18px 0">
            ${args.perkLines
              .map(
                (line) =>
                  `<tr>
                     <td width="18" valign="top" style="padding:3px 0;color:#ffbb00;font-size:14px;line-height:1.55">&bull;</td>
                     <td valign="top" style="padding:3px 0;font-size:15px;line-height:1.55;color:#e7e7e7">${escape(line)}</td>
                   </tr>`,
              )
              .join("")}
          </table>
          <p style="color:#bbb">Plus everything every pass carries: the Founder Toolkit, a public founder profile at your serial, the Discord role, and one chance to build your way back in if we say no.</p>
          ${
            args.note
              ? `<p style="margin-top:16px;padding:12px;border-left:3px solid rgba(255,255,255,0.2);color:#bbb">${escape(args.note)}</p>`
              : ""
          }
          <p style="color:#888">One account, one pass — the code stops working the moment it's claimed, so keep it to yourself.</p>
        `,
        cta: { url: redeemUrl, label: "Redeem your pass" },
        footNote: `Button not working? Go to <a href="${env.siteUrl}/pass" style="color:#ffbb00;text-decoration:none">${env.siteUrl.replace(/^https?:\/\//, "")}/pass</a> and enter <strong>${escape(args.code.toUpperCase())}</strong> by hand.`,
      }),
      text: `Your batch0 Founder Pass${args.isStandard ? "" : ` — ${args.tierLabel}`}

${first ? `Hi ${first},` : "Hi,"} someone at batch0 ${first ? `put Founder Pass ${serialLabel} in your name` : `set Founder Pass ${serialLabel} aside for you`}, issued as ${args.tierLabel}.

Your code: ${args.code.toUpperCase()}

Redeem it here: ${redeemUrl}
Or go to ${env.siteUrl}/pass and type the code in by hand.

This pass carries:
${args.perkLines.map((l) => `  - ${l}`).join("\n")}

Plus everything every pass carries: the Founder Toolkit, a public founder
profile at your serial, the Discord role, and one chance to build your way
back in if we say no.
${args.note ? `\n${args.note}\n` : ""}
One account, one pass — the code stops working the moment it's claimed.`,
    };
  },

  // `startsOn` is set only when the cohort hasn't kicked off yet — before
  // then the course is still locked, so the receipt points at kickoff
  // instead of a page the student would just get bounced from.
  paymentReceipt: (args: {
    name?: string | null;
    amountCents: number;
    cohortName: string;
    startsOn?: string | null;
  }) => ({
    subject: "Payment received — you're enrolled",
    html: layout({
      preheader: "You're enrolled in batch0.",
      body: `
        <h1 style="margin:0 0 12px 0;font-size:22px;color:#ffbb00">Enrolled</h1>
        <p>We received your payment of <strong>$${(args.amountCents / 100).toFixed(2)}</strong> for ${escape(args.cohortName)}. ${
          args.startsOn
            ? `Your seat is locked in. Kickoff is <strong>${escape(fmtDateOnly(args.startsOn) ?? "coming soon")}</strong> — until then your kickoff page, Discord, your team page, and the pre-cohort resources are open.`
            : "Your course access is unlocked."
        } Welcome aboard${args.name ? `, ${escape(args.name)}` : ""}.</p>
      `,
      cta: args.startsOn
        ? { url: `${env.siteUrl}/dashboard/kickoff`, label: "See kickoff details" }
        : { url: `${env.siteUrl}/dashboard/course`, label: "Open course" },
    }),
  }),

  weeklyDigest: (args: {
    apps: number;
    accepted: number;
    paid: number;
    revenue: number;
  }) => ({
    subject: "batch0 weekly digest",
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
        ${args.zoomUrl ? `<p>Join: <a href="${args.zoomUrl}" style="color:#ffbb00">${escape(args.zoomUrl)}</a></p>` : ""}
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
                  ? " · <span style=\"color:#ffbb00\">no mentor assigned</span>"
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
              ? `<h2 style="font-size:14px;color:#ffbb00;margin:24px 0 10px 0;text-transform:uppercase;letter-spacing:0.08em">Coming up</h2>
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
        <h1 style="margin:0 0 12px 0;font-size:22px;color:#ffbb00">Demo Day recap</h1>
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
              ? `<h2 style="font-size:13px;color:#ffbb00;margin:20px 0 6px 0;text-transform:uppercase;letter-spacing:0.08em">Wins</h2>
                 <ul style="padding-left:18px;margin:0">${headlineItems}</ul>`
              : ""
          }
          ${
            args.blockers.length > 0
              ? `<h2 style="font-size:13px;color:#ffbb00;margin:20px 0 6px 0;text-transform:uppercase;letter-spacing:0.08em">Blockers</h2>
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
        <h1 style="margin:0 0 12px 0;font-size:22px;color:#ffbb00">SAFE offer received</h1>
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
