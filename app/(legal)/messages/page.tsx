import { JsonLd, breadcrumbJsonLd, webPageJsonLd } from "@/lib/schema";

const description =
  "How batch0 text messages work — who gets them, how often, what they cost, and exactly how to stop them. Reply STOP to any message to unsubscribe.";

export const metadata = {
  title: "Text Messages · batch0",
  description,
  alternates: { canonical: "/messages" },
};

/**
 * /messages — the URL printed in every HELP reply (HELP_REPLY, lib/sms/consent.ts).
 *
 * Written for one reader: someone holding a phone, looking at a text from a
 * number they don't recognise, who wants out. So the STOP instruction is the
 * first thing on the page, above every explanation of what batch0 is — a person
 * trying to unsubscribe should never have to read a program pitch to find the
 * word. Everything else is ordered by how likely it is to be the next question.
 *
 * Every factual claim here has to match the transport, because this page is what
 * a carrier's vetting team reads and what we'd be held to. Keep it in sync with
 * lib/sms/consent.ts and lib/sms/keywords.ts (keywords, replies),
 * lib/sms/policy.ts (program texts only, the age floor), and
 * app/api/webhooks/sms/route.ts (what actually happens to an inbound message) —
 * and with the privacy policy's "Text messages" section, which
 * lib/sms-consent-policy.test.ts locks.
 *
 * Static on purpose (scripts/verify-static.mjs): it reads nothing per request.
 */
export default function MessagesPage() {
  return (
    <>
      <h1 className="text-4xl font-bold tracking-tight">Text Messages</h1>
      <p className="mt-2 text-sm text-ink-faint">
        Last updated: October 17, 2026
      </p>

      <div className="mt-8 rounded-xl border border-line bg-wash p-5 text-ink">
        <strong>To stop these texts:</strong> reply <strong>STOP</strong> to any
        message from us. That unsubscribes the number you replied from —
        immediately, and from every text we send. You don&rsquo;t have to
        explain, and you don&rsquo;t need an account.
      </div>

      <p>
        batch0 is a live online startup accelerator for high schoolers, operated
        by Sparkline Youth LLC. We text from one US toll-free number, and only to
        a number whose owner ticked a box that is specifically about texting, on
        their batch0 account, at batch0.org/dashboard/phone. Having a number on
        file is not enough: a number we already held gets nothing until
        someone opts it in.
      </p>

      <h2>What we send</h2>
      <p>
        Program messages only: a session starting, a schedule change, a
        deadline, something time-sensitive about your application or your
        cohort — the same things we would email you about.{" "}
        <strong>We do not send promotional or marketing texts.</strong> Texts
        go to the student&rsquo;s own number, and we don&rsquo;t offer them to
        applicants under 13; we reach them by email instead.
      </p>

      <h2>How often, and what it costs</h2>
      <p>
        Message frequency varies with the cohort calendar — more in the week a
        cohort starts, little or nothing between cohorts. Message and data rates
        may apply, charged by your mobile carrier; batch0 doesn&rsquo;t charge
        for texts. Carriers are not liable for delayed or undelivered messages.
      </p>
      <p>
        We don&rsquo;t text overnight. A message that comes up outside 9am–8pm in
        your number&rsquo;s time zone waits and goes out the next morning
        instead.
      </p>

      <h2>How to stop</h2>
      <p>
        Reply <strong>STOP</strong> to any message from us.{" "}
        <strong>UNSUBSCRIBE</strong>, <strong>CANCEL</strong>,{" "}
        <strong>END</strong>, <strong>QUIT</strong>, <strong>REVOKE</strong>{" "}
        and <strong>OPT OUT</strong> work the same way, and so does saying it in
        a sentence — &ldquo;please stop texting me&rdquo;, &ldquo;wrong
        number&rdquo;. You&rsquo;ll get one confirmation text and then nothing
        further.
      </p>
      <p>
        You can also turn texts off at batch0.org/dashboard/phone, or tell us
        any other way: a reply to one of our emails, a request at{" "}
        <a href="/support?topic=privacy">batch0.org/support</a>, or{" "}
        <a href="mailto:hello@batch0.org">hello@batch0.org</a>. We act on those
        within 10 business days. A parent or guardian can
        ask us to stop texting their student&rsquo;s number the same way.
      </p>
      <p>
        Opting out takes effect for every message, not just the one you replied
        to, and anything already queued for that number is canceled. Opting out
        of texts doesn&rsquo;t remove you from the program, change what
        you&rsquo;ve paid, or stop the emails you need to take part — we reach
        you by email instead.
      </p>

      <h2>How to start again</h2>
      <p>
        Reply <strong>START</strong> from the same number. That restores exactly
        what that number had before — program messages, nothing wider. If the
        number was never subscribed, START does nothing except send you our
        contact details; you&rsquo;d need to opt in from your batch0 account. A
        number that opted out by text, or that someone asked us to stop
        texting, can only be turned back on from the phone itself, by replying
        START.
      </p>

      <h2>Reaching a person</h2>
      <p>
        Our sending number isn&rsquo;t monitored — a reply that isn&rsquo;t one
        of the keywords above and isn&rsquo;t asking us to stop gets an
        automatic answer saying so and pointing you at email. For anything else,
        open a request at{" "}
        <a href="/support">batch0.org/support</a> or email{" "}
        <a href="mailto:hello@batch0.org">hello@batch0.org</a>. A human reads
        both. Reply <strong>HELP</strong> to any text if you just need our name
        and contact details sent back to you.
      </p>
      <p>
        If a number has changed hands and you&rsquo;re getting texts meant for
        someone else, reply STOP or &ldquo;wrong number&rdquo; and we&rsquo;ll
        suppress it.
      </p>

      <h2>Your number and your privacy</h2>
      <p>
        <strong>
          We do not sell, rent, share, or transfer phone numbers, SMS opt-in
          data, or SMS consent information to any third party for marketing or
          any other purpose.
        </strong>{" "}
        Twilio transmits our messages for us: it receives the number solely to
        deliver the text. When you opt in we keep a record of the exact words
        you agreed to, when, and the IP address and browser it came from, so we
        can show the text we sent was one you asked for. The full detail is in
        our <a href="/privacy">Privacy Policy</a>, and the terms that govern
        texting are in our <a href="/terms">Terms of Service</a>.
      </p>
      <p>
        Agreeing to texts is not a condition of applying, being accepted,
        enrolling, or buying anything from us.
      </p>

      <JsonLd
        data={webPageJsonLd({
          path: "/messages",
          name: "Text Messages",
          description,
          dateModified: "2026-10-17",
        })}
      />
      <JsonLd
        data={breadcrumbJsonLd([{ name: "Text messages", path: "/messages" }])}
      />
    </>
  );
}
