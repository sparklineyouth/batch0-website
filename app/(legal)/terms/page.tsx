export const metadata = { title: "Terms of Service · SparkLine" };

export default function TermsPage() {
  return (
    <>
      <h1 className="text-4xl font-bold tracking-tight">Terms of Service</h1>
      <p className="mt-2 text-sm text-white/50">
        Last updated: {new Date().getFullYear()}
      </p>

      <p>
        These Terms of Service govern your use of SparkLine
        (sparklineyouth.org), operated by SparkLine. By creating an account
        or using the platform, you agree to these terms.
      </p>

      <h2>Eligibility</h2>
      <p>
        SparkLine is intended for U.S. high schoolers, generally ages 13–18.
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
        SparkLine charges a one-time enrollment fee per cohort. All payments
        are processed by Stripe. Prices are listed in USD. See our{" "}
        <a href="/refund-policy">refund policy</a> for refund terms.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Don't use SparkLine to harass other users, infringe intellectual
        property, distribute malware, or attempt to compromise the
        platform's security.
      </p>

      <h2>Content you upload</h2>
      <p>
        You retain ownership of anything you upload (drafts, files, pitch
        decks, submissions). You grant SparkLine a limited license to host
        and display your content for the purpose of running the program.
      </p>

      <h2>Termination</h2>
      <p>
        You can delete your account at any time from your settings page.
        SparkLine may suspend or terminate accounts that violate these
        terms.
      </p>

      <h2>Disclaimer</h2>
      <p>
        SparkLine is provided "as is" without warranties. We don't
        guarantee investment outcomes — Demo Day connects students with
        real investors, but funding is at the investors' discretion.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms?{" "}
        <a href="mailto:sparkline.youth@gmail.com">
          sparkline.youth@gmail.com
        </a>
      </p>
    </>
  );
}
