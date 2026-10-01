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
        Last updated: October 1, 2026
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
          about your application and time-sensitive program logistics (e.g.
          kickoff). Accepted students who applied before we collected it are
          asked for it separately. We use it only to run the program — we don't
          use it for marketing, and we never sell it.
        </li>
        <li>
          <strong>Payment info:</strong> we don't store your card. Stripe
          handles all payment data.
        </li>
        <li>
          <strong>Program usage:</strong> lesson progress, weekly check-ins,
          team threads, comments, and files you upload to your drive.
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
          <strong>Mentors and investors</strong> only see what you choose to
          publish (e.g. a public team profile).
        </li>
      </ul>

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
        captured during application.
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
          dateModified: "2026-10-01",
        })}
      />
      <JsonLd data={breadcrumbJsonLd([{ name: "Privacy", path: "/privacy" }])} />
    </>
  );
}
