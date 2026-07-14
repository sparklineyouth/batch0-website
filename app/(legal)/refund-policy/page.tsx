export const metadata = {
  title: "Refund Policy · batch0",
  description: "batch0 tuition refund terms — what is refundable, when, and how to request one.",
  alternates: { canonical: "/refund-policy" },
};

export default function RefundPolicyPage() {
  return (
    <>
      <h1 className="text-4xl font-bold tracking-tight">Refund Policy</h1>
      <p className="mt-2 text-sm text-ink-faint">
        Last updated: May 12, 2026
      </p>

      <p>
        We want everyone to be happy with batch0. Here's how refunds work.
      </p>

      <h2>Full refund within 7 days</h2>
      <p>
        If you're not satisfied for any reason, you can request a full
        refund within 7 days of payment. Email us at{" "}
        <a href="mailto:hello@batch0.org">
          hello@batch0.org
        </a>{" "}
        from the email tied to your account.
      </p>

      <h2>After the cohort starts</h2>
      <p>
        Once your cohort begins, refunds are at our discretion. We're
        reasonable — if life happens, write to us.
      </p>

      <h2>How refunds are processed</h2>
      <p>
        Refunds go back to the original payment method via Stripe. They
        typically appear within 5–10 business days.
      </p>

      <h2>Questions</h2>
      <p>
        <a href="mailto:hello@batch0.org">
          hello@batch0.org
        </a>
      </p>
    </>
  );
}
