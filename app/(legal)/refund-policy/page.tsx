import { JsonLd, breadcrumbJsonLd, webPageJsonLd } from "@/lib/schema";

const description =
  "batch0 refund terms — a 48-hour full-refund window on tuition, then all sales are final. Applies to payments made through Stripe and PayPal.";

export const metadata = {
  title: "Refund Policy · batch0",
  description,
  alternates: { canonical: "/refund-policy" },
};

export default function RefundPolicyPage() {
  return (
    <>
      <h1 className="text-4xl font-bold tracking-tight">Refund Policy</h1>
      <p className="mt-2 text-sm text-ink-faint">
        Last updated: September 15, 2026
      </p>

      <p>
        <strong>The short version:</strong> you have 48 hours from the
        moment you pay tuition to change your mind and get every cent back.
        After that, all sales are final. Demo Day tickets are final sale
        from the start. There are no partial refunds, no prorating, no
        credits, and no exceptions for anything on your side of the table.
        By paying, you agree to this policy.
      </p>

      <h2>What this covers</h2>
      <p>
        This policy applies to every payment made to batch0 — cohort
        tuition, Demo Day tickets, and anything else we charge for —
        whether you pay through Stripe or PayPal. The processor you used
        doesn't change the terms; it only changes how the money travels
        back.
      </p>

      <h2>The 48-hour window</h2>
      <p>
        You may request a full refund of tuition within 48 hours of payment,
        for any reason. To be valid, your request must meet all of the
        following:
      </p>
      <ul>
        <li>
          It's emailed to{" "}
          <a href="mailto:hello@batch0.org">hello@batch0.org</a> from the
          email address on your batch0 account.
        </li>
        <li>
          The subject line is &ldquo;Refund request&rdquo; and the body
          includes your Stripe or PayPal receipt or transaction ID.
        </li>
        <li>
          It reaches our inbox within 48 hours of the payment timestamp on
          your Stripe or PayPal receipt.
        </li>
      </ul>
      <p>
        The 48 hours are 48 consecutive clock hours, not business days, and
        they run from the moment the processor confirms the charge — not
        from when you got access, first logged in, or opened the receipt.
        Pay at 3:00 PM on a Tuesday and the window closes at 3:00 PM on
        Thursday. The time your email arrives on our server is the time
        that counts.
      </p>
      <p>
        Requests sent any other way — a Discord message, a social DM, a
        text to a team member, a reply in an unrelated thread, a PayPal
        dispute, or a card chargeback — are not refund requests under this
        policy and do not stop the clock.
      </p>
      <p>
        We don't extend the window and we don't ask why you're leaving. A
        valid request inside 48 hours is refunded in full. A request that
        arrives at 48 hours and one minute is not.
      </p>

      <h2>After 48 hours: all sales are final</h2>
      <p>
        Once the window closes, your payment is non-refundable,
        non-transferable, and non-creditable. That holds regardless of:
      </p>
      <ul>
        <li>whether your cohort has started;</li>
        <li>
          how many sessions you attended, or whether you attended any;
        </li>
        <li>how far you got, what you built, or whether you finished;</li>
        <li>
          whether you raised money, got into another program, found a
          co-founder, or didn't — batch0 does not guarantee any outcome,
          and disappointment with an outcome is not grounds for a refund;
        </li>
        <li>
          a change in your schedule, circumstances, priorities, or
          interest;
        </li>
        <li>
          problems with your own hardware, internet connection, software,
          or time zone;
        </li>
        <li>your removal from the program for breaching our terms;</li>
        <li>
          a later change in our pricing, regional pricing, discounts, or
          promotions;
        </li>
        <li>
          a later change to the program's curriculum, mentors, speakers,
          schedule, or format, which we reserve the right to make.
        </li>
      </ul>
      <p>
        Withdrawing from the program after the window is a forfeiture of
        the fee, not a cancellation of it.
      </p>

      <h2>Demo Day tickets</h2>
      <p>
        Demo Day tickets are final sale from the moment of purchase. They
        can't be refunded, exchanged for another date, or transferred to
        another person. Not attending doesn't entitle you to a refund.
      </p>

      <h2>The one exception we make</h2>
      <p>
        If batch0 cancels your cohort before it starts and doesn't offer you
        a place in a later one, we refund your tuition in full. If we cancel
        a Demo Day outright and don't reschedule it, we refund the ticket in
        full. That's it. Rescheduling a session, changing a mentor or
        speaker, moving a date, or running a session online instead of in
        person is not a cancellation.
      </p>

      <h2>Chargebacks and PayPal disputes</h2>
      <p>
        Filing a card chargeback or a PayPal dispute instead of — or on top
        of — following this policy is a breach of our terms. If you do:
      </p>
      <ul>
        <li>
          your account access is suspended immediately while the dispute is
          open;
        </li>
        <li>
          we contest it with our records, including your acceptance, your
          payment receipt, your login history, and your session attendance;
        </li>
        <li>
          if the dispute is decided in your favor anyway, your enrollment is
          terminated permanently and you won't be admitted to any future
          cohort.
        </li>
      </ul>
      <p>
        If you think a charge is actually wrong — a duplicate, or an amount
        that doesn't match your receipt — email us first. Billing errors on
        our end are corrected promptly and never need a dispute.
      </p>

      <h2>How refunds are paid</h2>
      <p>
        Approved refunds go back only to the original payment method,
        through the processor you paid with. We don't refund to a different
        card, a different PayPal account, a bank transfer, cash, a check,
        crypto, or store credit — even if the original method is closed. If
        it's closed, your bank or PayPal reroutes the funds; that's between
        you and them.
      </p>
      <ul>
        <li>
          <strong>Stripe (card):</strong> we issue the refund within 5
          business days of approval. It usually appears on your statement
          in 5–10 business days, depending on your bank.
        </li>
        <li>
          <strong>PayPal:</strong> we issue the refund within 5 business
          days of approval. PayPal returns it to the funding source you
          used — a PayPal balance is usually credited right away; a card- or
          bank-funded payment can take up to 30 days to post, on PayPal's
          timeline, not ours.
        </li>
      </ul>
      <p>
        Refunds are issued in the currency and amount we charged. If your
        bank or PayPal converted currency, charged a foreign transaction fee,
        or the exchange rate moved between your payment and your refund, we
        don't cover the difference.
      </p>

      <h2>Discounts, passes, and regional pricing</h2>
      <p>
        A refund cancels your enrollment. Any discount, founder pass,
        promotional rate, or regional price you had is consumed by that
        enrollment and isn't reinstated. If you reapply later, you pay
        whatever the price is then.
      </p>

      <h2>Discretion and precedent</h2>
      <p>
        Anything we do outside this policy is a one-time courtesy, not a
        right. It doesn't change this policy, doesn't extend to anyone
        else, and doesn't obligate us to do it again — for you or for
        anyone. Nobody on the batch0 team can promise a refund in a call,
        a chat, or a DM; only a written confirmation from{" "}
        <a href="mailto:hello@batch0.org">hello@batch0.org</a> counts.
      </p>

      <h2>Changes to this policy</h2>
      <p>
        We may update this policy. The version that applies to you is the
        one published here at the time of your payment. Changes don't apply
        retroactively to payments already made.
      </p>

      <h2>Your legal rights</h2>
      <p>
        Nothing here limits rights you have under consumer protection law
        that can't be waived by agreement. Where such a law grants you more
        than this policy does, the law applies to that extent and no
        further.
      </p>

      <h2>Questions</h2>
      <p>
        <a href="mailto:hello@batch0.org">hello@batch0.org</a>
      </p>

      <JsonLd
        data={webPageJsonLd({
          path: "/refund-policy",
          name: "Refund Policy",
          description,
          dateModified: "2026-09-15",
        })}
      />
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Refund policy", path: "/refund-policy" },
        ])}
      />
    </>
  );
}
