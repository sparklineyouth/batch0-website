export const metadata = {
  title: "Privacy Policy · Sparkline Youth",
  description: "How Sparkline Youth (Impetus AI LLC) collects, uses, and protects student and parent data.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <>
      <h1 className="text-4xl font-bold tracking-tight">Privacy Policy</h1>
      <p className="mt-2 text-sm text-ink-faint">
        Last updated: May 12, 2026
      </p>

      <p>
        We collect the minimum personal information needed to run the
        Sparkline Youth program, and we never sell your data.
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
          (email), Anthropic (AI co-founder), Vercel (hosting). They process
          data on our behalf only.
        </li>
        <li>
          <strong>Mentors and investors</strong> only see what you choose to
          publish (e.g. a public team profile).
        </li>
      </ul>

      <h2>Your rights</h2>
      <p>
        You can update your profile or delete your account from{" "}
        <a href="/dashboard/settings">settings</a>. You can email us to
        request a copy of your data or full deletion at{" "}
        <a href="mailto:hello@sparklineyouth.org">
          hello@sparklineyouth.org
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
        research, code, drafts — belongs to you. Sparkline Youth will never
        sell, license, or share the substance of your idea with third
        parties for their own use. We don't take equity in your company
        and we don't claim ownership of your IP. The only public
        reference we may make is attribution (e.g. "built at Sparkline Youth").
        Full terms are in our <a href="/terms">Terms of Service</a>.
      </p>

      <h2>Contact</h2>
      <p>
        Questions:{" "}
        <a href="mailto:hello@sparklineyouth.org">
          hello@sparklineyouth.org
        </a>
      </p>
    </>
  );
}
