import { JsonLd, breadcrumbJsonLd, webPageJsonLd } from "@/lib/schema";

export const metadata = {
  title: "Privacy Policy · batch0",
  description: "How batch0 collects, uses, and protects student and parent data.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <>
      <h1 className="text-4xl font-bold tracking-tight">Privacy Policy</h1>
      <p className="mt-2 text-sm text-ink-faint">
        Last updated: October 15, 2026
      </p>

      <p>
        We collect the minimum personal information needed to run the
        batch0 program, and we never sell your data. batch0 is operated by
        Sparkline Youth LLC and was formerly known as Sparkline Youth — the
        name changed, but the entity holding your data did not.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account info:</strong> name, email, password (hashed via
          Supabase Auth).
        </li>
        <li>
          <strong>Application info:</strong> what you submit on
          /apply — age, grade, school, phone number, parent email, links.
        </li>
        <li>
          <strong>Contact info:</strong> a phone number, so we can reach you
          by call or text about your application and time-sensitive program
          logistics (e.g. kickoff). Accepted students who applied before we
          collected it are asked for it separately. We use it only to run the
          program — we don&rsquo;t use it for marketing, and we never sell it.
          See <a href="#sms">Text messages</a> below.
        </li>
        <li>
          <strong>Payment info:</strong> we don't store your card. Stripe
          handles all payment data.
        </li>
        <li>
          <strong>Program usage:</strong> lesson progress, assignment submissions,
          links to your team's Google Drive files, and what you post in a
          webinar's chat or Q&amp;A.
        </li>
        <li>
          <strong>batch0 Chat:</strong> the messages, files, reactions and
          pins you post in channels, direct messages and group messages, and
          which conversations you&rsquo;ve read. Who can read a channel:
          <ul>
            <li>
              #announcements, #general, #wins and #help: every accepted or
              enrolled student, and every mentor, investor and other account
              that isn&rsquo;t a student. Anyone who can read them can see
              who else can, by name.
            </li>
            <li>
              Your cohort&rsquo;s channel: your cohort&rsquo;s enrolled
              students, and the mentors assigned to any of them.
            </li>
            <li>
              Your team&rsquo;s channel: your team, and the mentors assigned
              to anyone on it.
            </li>
            <li>
              The batch0 team reads every channel, and can add people to any
              channel.
            </li>
          </ul>
          A direct or group message can be read only by the people in it,
          until one of them reports a message; reporting hands that
          conversation to the batch0 team so they can act on it. Students can
          message each other, and the batch0 team, privately. Mentors,
          investors and other adults outside the batch0 team can&rsquo;t
          message students privately: they talk with students only in
          channels the batch0 team can read, or in a group that includes
          someone from the batch0 team. When you edit or delete a
          message, we keep the earlier version so a report can still be
          reviewed. When an account is deleted, we blank the messages it
          posted in Chat and delete their earlier versions and files, and we
          delete its direct messages and team-thread posts from before Chat,
          except a message someone reported, or any message in a direct or
          group conversation someone reported: those we keep, with their
          earlier versions and files, as evidence of what was reported.
        </li>
        <li>
          <strong>Retired features:</strong> we still hold what was posted or
          uploaded in parts of batch0 we have since retired: the team thread
          (its messages now appear in your team&rsquo;s channel in Chat, and
          go when the account that posted them is deleted),
          lesson comments, discussions, weekly check-ins, office hours bookings
          and their recap notes, and files uploaded to batch0 before files
          moved to Google Drive.
        </li>
        <li>
          <strong>Call and webinar recordings:</strong> 1:1 calls and webinars
          may be recorded, as video and audio of what is on screen and what is
          said. The room shows when it is recording. A call&rsquo;s recording
          can be watched by the people on that call and by batch0
          administrators. A webinar&rsquo;s recording can be watched by the
          staff who run events and, after the webinar, by the people it was
          open to.
        </li>
        <li>
          <strong>Support requests:</strong> the messages and files you send
          us when you ask for help, plus technical details recorded with a
          request — your browser, and the page you were on when you reported
          a problem. Within batch0, only staff with support access can read
          them, and reports of a confidential concern are restricted to a
          small number of senior staff. We keep them for as long as we need
          to resolve them, and keep refund and privacy requests as a record
          of what was asked and when.
        </li>
        <li>
          <strong>Operational logs:</strong> standard server logs (IP, user
          agent) for security and debugging.
        </li>
        <li>
          <strong>Site analytics:</strong> pages viewed, referring site,
          device type, and approximate (city-level) location, via Google
          Analytics and Vercel Analytics. Used in aggregate to understand
          which pages help people — never to build an advertising profile.
        </li>
        <li>
          <strong>Campaign source:</strong> if you arrive through one of our
          tagged Google Search ads, a first-party cookie remembers the campaign
          label, landing page path, and visit time for up to 30 days. If you then
          start an application, we save that source with the application and
          compare it with actual tuition payments and refunds, including a
          parent paying on another device. This feature does not send student
          identity or payment results to an advertising platform, or store
          advertising click identifiers or search terms.
        </li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>To run the application + payment + course flow.</li>
        <li>To send transactional emails about your account and the program.</li>
        <li>
          To contact you — by email or phone — about your application and
          time-sensitive program logistics.
        </li>
        <li>To improve the platform and protect against abuse.</li>
      </ul>

      <h2>Who we share with</h2>
      <ul>
        <li>
          <strong>Service providers</strong> we use to operate the platform:
          Supabase (database + auth + storage), Stripe (payments), Resend
          (email), Anthropic (AI co-founder), Vercel (hosting + analytics),
          Google Analytics (site analytics). They process data on our behalf
          only.
        </li>
        <li>
          <strong>Mentors and investors</strong> see what you choose to
          publish (e.g. a public team profile), and what is posted in the
          batch0 Chat channels they can read, listed above.
        </li>
      </ul>

      <h2 id="sms">Text messages (SMS)</h2>
      <p>
        We text you only about the program you applied to or are enrolled in:
        application status, kickoff and session logistics, deadline reminders,
        and anything else time-sensitive. These are the same things we would
        email you about.
      </p>
      <p>
        <strong>We do not send promotional or marketing texts.</strong> We
        will not start sending them to a number already on file. If we ever
        add them, they will require a separate opt-in that you actively
        choose, and declining will have no effect on your application, your
        place in the program, or anything you pay.
      </p>
      <p>
        <strong>
          We do not sell, rent, share, or transfer phone numbers, SMS opt-in
          data, or SMS consent information to any third party — including
          sponsors, partners, and affiliates — for marketing or any other
          purpose.
        </strong>{" "}
        A number reaches a third party only when that provider is delivering
        the message for us.
      </p>
      <p>
        <strong>Stopping texts.</strong> Reply STOP to any message, or tell us
        any other reasonable way — a reply to one of our emails, a request at{" "}
        <a href="/support?topic=privacy">batch0.org/support</a>, or{" "}
        <a href="mailto:hello@batch0.org">hello@batch0.org</a>. We act on it
        within 10 business days and send at most one confirmation message.
        Message frequency varies with the cohort calendar, and message and
        data rates may apply. Stopping texts does not remove you from the
        program — we reach you by email instead.
      </p>
      <p>
        We keep a record of the number, when and how you gave it to us, and
        any request to stop, for as long as you are in the program and
        afterward as needed to show we honored what you asked for.
      </p>

      <h2>Your rights</h2>
      <p>
        You can update your profile in{" "}
        <a href="/dashboard/settings">settings</a>. You can&rsquo;t delete
        your account there: account deletion, a copy of your data, or a
        correction to something we hold goes through a request, and our team
        does it for you. Open one at{" "}
        <a href="/support?topic=privacy">batch0.org/support</a> and choose
        &ldquo;Privacy &amp; my data&rdquo; — you&rsquo;ll get a reference
        number and a dated record of when you asked, which matters for a
        request with a legal clock on it. Emailing{" "}
        <a href="mailto:hello@batch0.org">hello@batch0.org</a> works too.
      </p>
      <div className="mt-8 rounded-xl border border-line bg-wash p-5 text-ink">
        <strong>To exercise a data right:</strong> open a request at{" "}
        <a href="/support?topic=privacy">batch0.org/support</a> or email{" "}
        <a href="mailto:hello@batch0.org">hello@batch0.org</a> — for a copy
        of your data, a correction, or account deletion. Either way, both
        sides have a dated record of when you asked.
      </div>

      <h2>Minors</h2>
      <p>
        Many of our students are under 18. We rely on parental consent
        captured during application, and every applicant under 18 gives us a
        parent or guardian email.
      </p>
      <p>
        A parent or guardian can see what we hold on their student, correct
        it, ask us to delete it, or tell us to stop calling or texting the
        student&rsquo;s number — at{" "}
        <a href="/support?topic=privacy">batch0.org/support</a> or{" "}
        <a href="mailto:hello@batch0.org">hello@batch0.org</a>. We treat a
        request from a parent or guardian the same as one from the student.
      </p>

      <h2>Your ideas and IP</h2>
      <p>
        Anything you upload — pitch decks, business plans, customer
        research, code, drafts — belongs to you. batch0 will never
        sell, license, or share the substance of your idea with third
        parties for their own use. We don't take equity in your company
        and we don't claim ownership of your IP. The only public
        reference we may make is attribution (e.g. "built at batch0").
        Full terms are in our <a href="/terms">Terms of Service</a>.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy, or about data we hold on you:{" "}
        <a href="/support?topic=privacy">batch0.org/support</a>, or{" "}
        <a href="mailto:hello@batch0.org">hello@batch0.org</a>.
      </p>

      <JsonLd
        data={webPageJsonLd({
          path: "/privacy",
          name: "Privacy Policy",
          description:
            "How batch0 collects, uses, and protects student and parent data.",
          dateModified: "2026-10-15",
        })}
      />
      <JsonLd data={breadcrumbJsonLd([{ name: "Privacy", path: "/privacy" }])} />
    </>
  );
}
