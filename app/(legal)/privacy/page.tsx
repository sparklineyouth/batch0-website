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
        Last updated: August 5, 2026
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
          /apply — age, grade, school, parent email, links.
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
          <strong>Operational logs:</strong> standard server logs (IP, user
          agent) for security and debugging.
        </li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>To run the application + payment + course flow.</li>
        <li>To send transactional emails about your account and the program.</li>
        <li>To improve the platform and protect against abuse.</li>
      </ul>

      <h2>Who we share with</h2>
      <ul>
        <li>
          <strong>Service providers</strong> we use to operate the platform:
          Supabase (database + auth + storage), Stripe (payments), Resend
          (email), Anthropic (AI co-founder), Vercel (hosting + analytics),
          Google (Google Analytics). They process data on our behalf only.
        </li>
        <li>
          <strong>Mentors and investors</strong> only see what you choose to
          publish (e.g. a public team profile).
        </li>
      </ul>

      <h2>Cookies and analytics</h2>
      <p>
        We use two analytics tools to understand how people find and use the
        site, so we can make it better. Neither is used for advertising, and
        we do not sell or share this data with advertisers.
      </p>
      <ul>
        <li>
          <strong>Vercel Analytics</strong> measures page traffic without
          cookies and without tracking you across other websites.
        </li>
        <li>
          <strong>Google Analytics</strong> sets cookies in your browser to
          recognise return visits. It records things like which pages you
          viewed, roughly where in the world you are, and what kind of device
          and browser you used. We have not enabled Google&apos;s advertising
          or remarketing features, so this data is not used to target ads at
          you.
        </li>
      </ul>
      <p>
        We do not send your name, email address, or anything else that
        identifies you personally to Google Analytics. It is switched off
        entirely on our staff-only admin pages.
      </p>
      <p>
        You can opt out at any time. Most browsers let you block or delete
        cookies in their settings, and Google publishes a browser add-on that
        turns Google Analytics off everywhere at{" "}
        <a
          href="https://tools.google.com/dlpage/gaoptout"
          target="_blank"
          rel="noopener noreferrer"
        >
          tools.google.com/dlpage/gaoptout
        </a>
        . Blocking analytics does not affect your application or your place in
        the program.
      </p>
      <p>
        Students and parents in the UK or EU: if you would like us to delete
        analytics data associated with your visits, email us and we will do
        it.
      </p>

      <h2>Your rights</h2>
      <p>
        You can update your profile or delete your account from{" "}
        <a href="/dashboard/settings">settings</a>. You can email us to
        request a copy of your data or full deletion at{" "}
        <a href="mailto:hello@batch0.org">
          hello@batch0.org
        </a>
        .
      </p>

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
        Questions:{" "}
        <a href="mailto:hello@batch0.org">
          hello@batch0.org
        </a>
      </p>

      <JsonLd
        data={webPageJsonLd({
          path: "/privacy",
          name: "Privacy Policy",
          description:
            "How batch0 collects, uses, and protects student and parent data.",
          dateModified: "2026-05-12",
        })}
      />
      <JsonLd data={breadcrumbJsonLd([{ name: "Privacy", path: "/privacy" }])} />
    </>
  );
}
