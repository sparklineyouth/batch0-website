import { test } from "node:test";
import assert from "node:assert/strict";
import {
  foldMessages,
  summarize,
  dailySeries,
  byTemplate,
  topLinks,
  byClient,
  classifyClient,
  latency,
  problemRecipients,
  fmtPct,
  fmtDuration,
  type EmailEventRow,
} from "./email/metrics.ts";

// Run with `npm test`.
//
// The metrics page has no other reviewer: nobody cross-checks a dashboard
// against the mail server, so a rate that is quietly double the truth can sit
// there for months. These cover the cases that made it wrong before — an event
// counted instead of a message, an open whose send predates the window, a bar
// series that counts a delivery as a second send.

const T = (day: number, hour = 12) =>
  `2026-08-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;

function ev(
  event_type: string,
  id: string | null,
  at: string,
  extra: Partial<EmailEventRow> = {},
): EmailEventRow {
  return {
    event_type,
    subject: "Welcome to batch0",
    recipient: "a@example.com",
    resend_email_id: id,
    occurred_at: at,
    ...extra,
  };
}

test("a message opened five times counts as one opened message", () => {
  const rows = [
    ev("email.sent", "e1", T(1)),
    ev("email.delivered", "e1", T(1, 13)),
    ...Array.from({ length: 5 }, (_, i) => ev("email.opened", "e1", T(2, i))),
  ];
  const s = summarize(foldMessages(rows).values());
  assert.equal(s.sent, 1);
  assert.equal(s.delivered, 1);
  assert.equal(s.opened, 1, "opened counts messages, not open events");
  assert.equal(s.totalOpens, 5, "the raw event total is still available");
  assert.equal(s.openRate, 1);
});

test("sent and delivered for one message is one send, not two", () => {
  const rows = [ev("email.sent", "e1", T(1)), ev("email.delivered", "e1", T(1, 13))];
  assert.equal(summarize(foldMessages(rows).values()).sent, 1);
  // Same rule in the chart series, which used to double every bar by counting
  // both events.
  const series = dailySeries(rows, 3, new Date(T(3)));
  const day1 = series.find((d) => d.key === "2026-08-01")!;
  assert.equal(day1.sent, 1);
  assert.equal(day1.delivered, 1);
});

test("an open whose send predates the window doesn't inflate the denominator", () => {
  // The send happened before the 30-day cutoff, so only the open is in `rows`.
  const s = summarize(foldMessages([ev("email.opened", "old", T(2))]).values());
  assert.equal(s.sent, 0, "we never saw it go out, so it isn't a send in this window");
  assert.equal(s.opened, 1);
  assert.equal(s.openRate, null, "no denominator means no rate, not a divide by zero");
});

test("events with no email id are counted, not dropped", () => {
  // Dropping them shrinks the denominator, which makes every rate look better
  // than it is — the worst possible direction for a bug on this page.
  const rows = [ev("email.sent", null, T(1)), ev("email.sent", null, T(1, 14))];
  assert.equal(summarize(foldMessages(rows).values()).sent, 2);
});

test("an open on a later day lands on that day, not on the send day", () => {
  const rows = [ev("email.delivered", "e1", T(1)), ev("email.opened", "e1", T(3))];
  const series = dailySeries(rows, 5, new Date(T(5)));
  assert.equal(series.find((d) => d.key === "2026-08-01")!.opened, 0);
  assert.equal(series.find((d) => d.key === "2026-08-03")!.opened, 1);
});

test("bounces split permanent from transient", () => {
  const rows = [
    ev("email.sent", "e1", T(1)),
    ev("email.bounced", "e1", T(1), { bounce_type: "Permanent" }),
    ev("email.sent", "e2", T(1)),
    ev("email.bounced", "e2", T(1), { bounce_type: "Transient" }),
  ];
  const s = summarize(foldMessages(rows).values());
  assert.equal(s.bounced, 2);
  assert.equal(s.hardBounced, 1);
  assert.equal(s.softBounced, 1);
  assert.equal(s.bounceRate, 1);
});

test("click-to-open is clicks over openers, not over delivered", () => {
  const rows = [
    ...["e1", "e2", "e3", "e4"].flatMap((id) => [
      ev("email.sent", id, T(1)),
      ev("email.delivered", id, T(1)),
    ]),
    ev("email.opened", "e1", T(2)),
    ev("email.opened", "e2", T(2)),
    ev("email.clicked", "e1", T(2)),
  ];
  const s = summarize(foldMessages(rows).values());
  assert.equal(s.openRate, 0.5);
  assert.equal(s.clickRate, 0.25);
  assert.equal(s.clickToOpenRate, 0.5);
});

test("template grouping prefers the tag and falls back to the subject", () => {
  const rows = [
    ev("email.sent", "e1", T(1), {
      subject: "You're in — Jane Doe",
      template_key: "application.accepted",
    }),
    ev("email.sent", "e2", T(1), {
      subject: "You're in — John Roe",
      template_key: "application.accepted",
    }),
    // Untagged (sent over SMTP, or before tagging shipped): the personalized
    // tails have to collapse or one template becomes one row per recipient.
    ev("email.sent", "e3", T(1), { subject: "Payment received for Ada L" }),
    ev("email.sent", "e4", T(1), { subject: "Payment received for Alan T" }),
  ];
  const groups = byTemplate(foldMessages(rows).values());
  const tagged = groups.find((g) => g.label === "application.accepted")!;
  assert.equal(tagged.sent, 2);
  assert.equal(tagged.exact, true);

  const guessed = groups.find((g) => g.label === "Payment received")!;
  assert.equal(guessed.sent, 2, "personalized subjects collapse to one row");
  assert.equal(guessed.exact, false);
});

test("a group is only exact when every message in it was tagged", () => {
  const rows = [
    ev("email.sent", "e1", T(1), { subject: "Welcome", template_key: "Welcome" }),
    ev("email.sent", "e2", T(1), { subject: "Welcome" }),
  ];
  const g = byTemplate(foldMessages(rows).values()).find((x) => x.label === "Welcome")!;
  assert.equal(g.sent, 2);
  assert.equal(g.exact, false);
});

test("top links rank by clicks and count distinct messages", () => {
  const rows = [
    ev("email.clicked", "e1", T(1), { click_link: "https://batch0.org/apply" }),
    ev("email.clicked", "e1", T(1, 13), { click_link: "https://batch0.org/apply" }),
    ev("email.clicked", "e2", T(1), { click_link: "https://batch0.org/apply" }),
    ev("email.clicked", "e3", T(1), { click_link: "https://batch0.org/faq" }),
  ];
  const [first, second] = topLinks(rows);
  assert.equal(first.url, "https://batch0.org/apply");
  assert.equal(first.clicks, 3);
  assert.equal(first.messages, 2, "one person clicking twice is one message");
  assert.equal(second.clicks, 1);
});

test("pixel-prefetching clients are flagged so the open rate can be read as a ceiling", () => {
  assert.deepEqual(classifyClient("GoogleImageProxy (via ggpht.com)"), {
    client: "Gmail (image proxy)",
    proxied: true,
  });
  assert.equal(classifyClient("Mozilla/5.0 (Macintosh) Mail/16.0").proxied, true);
  assert.equal(classifyClient("Mozilla/5.0 (Windows NT 10.0) Chrome/120").proxied, false);
  assert.equal(classifyClient(null).client, "Unknown");
  assert.equal(classifyClient("   ").client, "Unknown");

  const rows = [
    ev("email.opened", "e1", T(1), { user_agent: "GoogleImageProxy" }),
    ev("email.opened", "e2", T(1), { user_agent: "GoogleImageProxy" }),
    ev("email.clicked", "e3", T(1), { user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS)" }),
  ];
  const [top] = byClient(rows);
  assert.equal(top.client, "Gmail (image proxy)");
  assert.equal(top.opens, 2);
});

test("latency medians ignore impossible negative gaps", () => {
  const rows = [
    ev("email.sent", "e1", T(1, 0)),
    ev("email.delivered", "e1", T(1, 1)),
    ev("email.opened", "e1", T(1, 3)),
    // Reordered webhook delivery: the "sent" timestamp arrives after the
    // delivery. A negative duration is nonsense, not a fast delivery.
    ev("email.delivered", "e2", T(1, 0)),
    ev("email.sent", "e2", T(1, 5)),
  ];
  const l = latency(foldMessages(rows).values());
  assert.equal(l.toDelivery, 3600_000);
  assert.equal(l.toOpen, 2 * 3600_000);
  assert.equal(l.toClick, null);
});

test("problem addresses keep one row per address, worst first", () => {
  const rows = [
    ev("email.bounced", "e1", T(1), {
      recipient: "dead@example.com",
      bounce_type: "Permanent",
      bounce_subtype: "NoEmail",
    }),
    ev("email.bounced", "e2", T(3), {
      recipient: "dead@example.com",
      bounce_type: "Permanent",
    }),
    ev("email.complained", "e3", T(2), { recipient: "annoyed@example.com" }),
  ];
  const p = problemRecipients(rows);
  assert.equal(p.length, 2);
  assert.equal(p[0].email, "annoyed@example.com", "a spam complaint outranks a bounce");
  assert.equal(p[1].email, "dead@example.com");
  assert.equal(p[1].at, T(3), "keeps the most recent occurrence");
});

test("formatters degrade rather than printing NaN", () => {
  assert.equal(fmtPct(null), "—");
  assert.equal(fmtPct(0.5), "50%");
  assert.equal(fmtPct(0.0123, 1), "1.2%");
  assert.equal(fmtDuration(null), "—");
  assert.equal(fmtDuration(450), "450ms");
  assert.equal(fmtDuration(45_000), "45s");
  assert.equal(fmtDuration(4_500), "4.5s", "a decimal only where it carries information");
  assert.equal(fmtDuration(3 * 3600_000), "3.0h");
});
