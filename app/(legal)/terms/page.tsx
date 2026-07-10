export const metadata = {
  title: "Terms of Service · SparkLine Youth",
  description: "The terms that govern SparkLine Youth, the live online startup accelerator for U.S. high schoolers run by Impetus AI LLC.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <>
      <h1 className="text-4xl font-bold tracking-tight">Terms of Service</h1>
      <p className="mt-2 text-sm text-ink-faint">
        Last updated: May 12, 2026
      </p>

      <p>
        These Terms of Service govern your use of SparkLine Youth
        (sparklineyouth.org), operated by SparkLine Youth. By creating an account
        or using the platform, you agree to these terms.
      </p>

      <h2>Eligibility</h2>
      <p>
        SparkLine Youth is intended for U.S. high schoolers, generally ages 13–18.
        If you are under 18, you must have permission from a parent or legal
        guardian to use the platform.
      </p>

      <h2>Accounts</h2>
      <p>
        You're responsible for keeping your password secure and for all
        activity under your account. Don't share your credentials. Notify us
        promptly if you believe your account has been compromised.
      </p>

      <h2>Payments</h2>
      <p>
        SparkLine Youth charges a one-time enrollment fee per cohort. All payments
        are processed by Stripe. Prices are listed in USD. See our{" "}
        <a href="/refund-policy">refund policy</a> for refund terms.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Don't use SparkLine Youth to harass other users, infringe intellectual
        property, distribute malware, or attempt to compromise the
        platform's security.
      </p>

      <h2>Content you upload</h2>
      <p>
        You retain ownership of anything you upload (drafts, files, pitch
        decks, submissions). You grant SparkLine Youth a limited license to host
        and display your content for the purpose of running the program.
      </p>

      <h2>Your ideas, your IP, your company</h2>
      <p>
        You own 100% of your idea, your intellectual property, and any
        company you build during or after the program. SparkLine Youth does
        <strong> not</strong> take equity, royalties, revenue share, or
        any ownership interest in your business as a condition of
        participating. We don't claim your IP, we don't license your work
        to third parties, and we don't sell information about your idea.
        Mentors, instructors, and staff are bound by the same rule.
      </p>
      <p>
        The only thing we ask: permission to attribute. We may publicly
        mention that a project, founder, or company "was built at
        SparkLine Youth" or "started in a SparkLine Youth cohort" — for example, in
        case studies, alumni lists, social posts, and our website. This
        is attribution only and creates no ownership, partnership, or
        agency relationship between SparkLine Youth and your business. If you'd
        prefer not to be named publicly, email{" "}
        <a href="mailto:sparklineyouth@gmail.com">
          sparklineyouth@gmail.com
        </a>{" "}
        and we'll honor that.
      </p>

      <h2>Termination</h2>
      <p>
        You can delete your account at any time from your settings page.
        SparkLine Youth may suspend or terminate accounts that violate these
        terms.
      </p>

      <h2>Disclaimer</h2>
      <p>
        SparkLine Youth is provided "as is" without warranties. We don't
        guarantee investment outcomes — Demo Day connects students with
        real investors, but funding is at the investors' discretion.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms?{" "}
        <a href="mailto:sparklineyouth@gmail.com">
          sparklineyouth@gmail.com
        </a>
      </p>
    </>
  );
}
