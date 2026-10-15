import { JsonLd, breadcrumbJsonLd, webPageJsonLd } from "@/lib/schema";

const description =
  "How we treat each other on batch0: the rules for batch0 Chat and session chat in a community of high schoolers, ages 13–18, and what happens when someone breaks them.";

export const metadata = {
  title: "Community Guidelines · batch0",
  description,
  alternates: { canonical: "/community-guidelines" },
};

/**
 * What Discord's #rules channel used to hold, published where a parent can
 * read it before their student joins. The FAQ and batch0 Chat link here.
 *
 * Every rule about who can message whom, and who can read what, is something
 * the product enforces (lib/chat-access.ts, docs/chat.md); keep it that way.
 */
export default function CommunityGuidelinesPage() {
  return (
    <>
      <h1 className="text-4xl font-bold tracking-tight">Community Guidelines</h1>
      <p className="mt-2 text-sm text-ink-faint">
        Last updated: October 15, 2026
      </p>

      <p>
        batch0 is a community of high schoolers, ages 13–18, building their
        first companies alongside the batch0 team, mentors and investors.
        These guidelines apply everywhere people talk on batch0: channels,
        direct messages and group messages in batch0 Chat, and the chat and
        questions in live sessions. They spell out the acceptable use rules
        in our <a href="/terms">Terms of Service</a>.
      </p>

      <h2>Be someone people want to build with</h2>
      <ul>
        <li>Be kind and be direct. Push back on ideas, never on people.</li>
        <li>
          Help where you can: answer questions in #help, and celebrate other
          people&rsquo;s progress in #wins.
        </li>
        <li>
          Give credit. Say where an idea, a quote or a piece of work came
          from.
        </li>
      </ul>

      <h2>Not allowed, anywhere on batch0</h2>
      <ul>
        <li>
          <strong>Harassment and bullying:</strong> insults, threats, piling
          on, or contacting someone again after they asked you to stop.
        </li>
        <li>
          <strong>Hate:</strong> attacking anyone for their race, ethnicity,
          religion, gender, sexual orientation, disability or where they are
          from.
        </li>
        <li>
          <strong>Sexual or violent content</strong>, of any kind.
        </li>
        <li>
          <strong>Other people&rsquo;s private details:</strong> a phone
          number, an address, private photos or messages, shared without
          their permission. Keep your own off public channels too.
        </li>
        <li>
          <strong>Spam and scams:</strong> unsolicited promotion, chain
          messages, or asking anyone for money, passwords or sign-in codes.
        </li>
        <li>
          <strong>Pretending to be someone else</strong>, including someone
          on the batch0 team.
        </li>
        <li>
          <strong>Taking what isn&rsquo;t yours:</strong> posting someone
          else&rsquo;s work as your own, or sharing work that isn&rsquo;t yours
          to share.
        </li>
        <li>
          <strong>Malware and attacks:</strong> harmful links or files, or
          trying to get into batch0 or anyone&rsquo;s account.
        </li>
      </ul>

      <h2>Private messages</h2>
      <ul>
        <li>
          Students can message each other, and the batch0 team, privately.
          Nobody else can read those conversations unless someone in one
          reports a message: a report hands that conversation to the batch0
          team so they can act on it.
        </li>
        <li>
          Mentors, investors and other adults outside the batch0 team
          don&rsquo;t message students privately, and batch0 Chat won&rsquo;t
          let them. They talk with students in channels the batch0 team can
          read. Adults: don&rsquo;t move a conversation with a student
          somewhere else instead, like another app, a phone number or social
          media.
        </li>
      </ul>

      <h2>If something&rsquo;s wrong</h2>
      <ul>
        <li>
          <strong>Report it:</strong> choose Report message in its menu. A
          report goes to the batch0 team, and never to the person it&rsquo;s
          about, even when that is someone on the team. The person you report
          isn&rsquo;t told who reported them. If everyone on the team who
          handles reports is part of what you reported, none of them is shown
          it, and Chat tells you so straight away and who to go to instead.
        </li>
        <li>
          <strong>Block someone</strong> to stop hearing from them. In a direct
          message, neither of you can send once either has blocked the other;
          in channels and groups, their messages are folded away for you.
          They aren&rsquo;t told.
        </li>
        <li>
          <strong>Tell us directly</strong> about anything that worries you,
          whether you are a student or a parent:{" "}
          <a href="/support?topic=concern">report a concern</a> (only a small
          number of senior staff can read it), or email{" "}
          <a href="mailto:hello@batch0.org">hello@batch0.org</a>. If someone
          is in danger right now, contact your local emergency services
          first.
        </li>
      </ul>

      <h2>What the batch0 team does</h2>
      <p>
        The team reads every channel, works every report, and can remove
        messages, mute someone in batch0 Chat for a while or until further
        notice, and, for serious or repeated breaches, suspend or close an
        account, as the Terms of Service allow. Editing or deleting a message
        doesn&rsquo;t hide it from a report: we keep the earlier version so
        the team can still review it (our <a href="/privacy">Privacy Policy</a>{" "}
        explains what we keep). Live sessions may be recorded.
      </p>

      <h2>Contact</h2>
      <div className="mt-8 rounded-xl border border-line bg-wash p-5 text-ink">
        <strong>Questions about these guidelines:</strong> open a request at{" "}
        <a href="/support">batch0.org/support</a>, or email{" "}
        <a href="mailto:hello@batch0.org">hello@batch0.org</a>. A person
        replies.
      </div>

      <JsonLd
        data={webPageJsonLd({
          path: "/community-guidelines",
          name: "Community Guidelines",
          description,
          dateModified: "2026-10-15",
        })}
      />
      <JsonLd
        data={breadcrumbJsonLd([{ name: "Community Guidelines", path: "/community-guidelines" }])}
      />
    </>
  );
}
