import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import {
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  SUPPORT_EMAIL_KEYS,
  TICKET_CATEGORIES,
  defaultPriorityFor,
  formatReceivedAt,
  isSensitiveCategory,
  type TicketCategory,
  type TicketChannel,
} from "./support-access.ts";

// Run with `npm test`.
//
// Every support email exists twice: the compiled fallback in
// lib/email/templates.ts, and the admin-editable row seeded from
// lib/email/seed.ts that wins whenever it exists. The database copy has no
// conditionals, so the sentences that depend on the ticket travel as
// variables — and the interpolator leaves an unresolved `{{tag}}` in the email
// verbatim. An earlier draft of these rows did exactly that: every non-refund
// requester's receipt said "{{refund_note}}" in the middle of it, and the team
// alert silently lost its refund-deadline paragraph.
//
// So each seed is rendered here through the REAL renderer (sanitize →
// interpolate → style → wrap, lib/email/render.ts) with the variables the
// REAL builders produce (support*Vars in lib/email/templates.ts — the same
// calls lib/support.ts makes), for every category and every way a ticket can
// arrive, and a single surviving "{{" fails the suite. The compiled fallback
// is rendered from the same input alongside it.

// The seed module imports the service-role client for the "Restore built-in
// templates" action; nothing here touches a database, so it gets a stub that
// throws if anything tries. Every other `@/` import resolves to the real file.
const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const hook = (nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    if (specifier === "@/lib/supabase/admin") {
      return {
        url: fake("export const createAdminClient=()=>{throw new Error('no database in this test')};"),
        shortCircuit: true,
      };
    }
    if (specifier.startsWith("@/")) {
      return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    }
    return next(specifier, context);
  },
});
const { SYSTEM_TEMPLATES } = await import("./email/seed.ts");
const { renderTemplate } = await import("./email/render.ts");
const T = await import("./email/templates.ts");
test.after(() => hook.deregister());

type Rendered = { subject: string; html: string; text: string; missing: string[] };

function seed(key: string) {
  const row = SYSTEM_TEMPLATES.find((t: { key: string }) => t.key === key);
  assert.ok(row, `no seed row for ${key}`);
  return row;
}

/**
 * What sendTemplated() merges under the caller's variables (baseVariables in
 * lib/email/dispatch.ts, which can't be imported here without its transport).
 */
function base(name: string | null) {
  const first = (name ?? "").trim().split(/\s+/)[0] || "there";
  return {
    email: "alex@example.com",
    full_name: name ?? "",
    first_name: first,
    name: first,
    site_url: "https://batch0.org",
    dashboard_url: "https://batch0.org/dashboard",
    contact_email: "hello@batch0.org",
  };
}

function render(key: string, vars: Record<string, string>, name: string | null = "Alex"): Rendered {
  const row = seed(key);
  return renderTemplate(
    {
      key: row.key,
      subject: row.subject,
      preheader: row.preheader ?? null,
      body_html: row.body_html,
      cta_label: row.cta_label ?? null,
      cta_url: row.cta_url ?? null,
      variables: row.variables,
    },
    { ...base(name), ...vars },
  );
}

function assertComplete(label: string, out: { subject: string; html: string; text?: string }) {
  for (const [part, value] of Object.entries(out)) {
    if (typeof value !== "string") continue;
    assert.ok(!value.includes("{{"), `${label}: ${part} has an unresolved tag:\n${value}`);
    assert.ok(!/\bundefined\b/.test(value), `${label}: ${part} says "undefined"`);
    assert.ok(!/>\s*null\s*</.test(value), `${label}: ${part} prints null`);
  }
}

const REFERENCE = "B0-4F2A-9C7K";
const THREAD = `https://batch0.org/support/t/${"a".repeat(43)}`;
const RECEIVED = formatReceivedAt("2026-10-01T13:30:00.000Z");
// Line breaks and markup, because a person's request has both: the breaks
// must survive and the markup must arrive escaped.
const BODY = "The video in week 2 won't play.\nIt spins forever.\n\nTried Chrome & Safari <both>.";

const ARRIVALS: { label: string; channel: TicketChannel; staffLogged: boolean }[] = [
  { label: "filed on the web", channel: "web", staffLogged: false },
  { label: "filed in the app", channel: "app", staffLogged: false },
  { label: "logged from an email", channel: "email", staffLogged: true },
  { label: "logged from a call", channel: "phone", staffLogged: true },
  { label: "logged from elsewhere", channel: "other", staffLogged: true },
];

function receivedInput(category: TicketCategory, a: (typeof ARRIVALS)[number], name: string | null = "Alex") {
  return {
    name,
    reference: REFERENCE,
    category,
    categoryLabel: CATEGORY_LABELS[category],
    channel: a.channel,
    staffLogged: a.staffLogged,
    subject: "Week 2 video",
    body: BODY,
    receivedAt: RECEIVED,
    threadUrl: THREAD,
  };
}

// ---------------------------------------------------------------------------

test("every key the sender uses has a seed row", () => {
  for (const key of Object.values(SUPPORT_EMAIL_KEYS)) seed(key);
});

test("the receipt renders completely for every category and every way a request arrives", () => {
  for (const category of TICKET_CATEGORIES) {
    for (const a of ARRIVALS) {
      const label = `${category}, ${a.label}`;
      const input = receivedInput(category, a);
      const out = render(SUPPORT_EMAIL_KEYS.received, T.supportReceivedVars(input));
      assert.deepEqual(out.missing, [], label);
      assertComplete(label, out);

      assert.ok(out.subject.includes(REFERENCE), label);
      assert.ok(out.html.includes(REFERENCE), label);
      assert.ok(out.html.includes(RECEIVED), `${label}: the received time is the point of this email`);
      // The body keeps its line breaks, escaped, in a pre-wrap paragraph.
      assert.match(out.html, /white-space:pre-wrap">The video in week 2 won't play\.\nIt spins forever\.\n\nTried Chrome &amp; Safari &lt;both&gt;\./, label);
      assert.ok(out.text.includes("It spins forever.\n\nTried Chrome & Safari <both>."), `${label}: text part`);

      const refund = out.html.includes("48 hours from payment");
      assert.equal(refund, category === "refund", `${label}: the refund-clock paragraph is for refunds only`);
      const emergency = out.html.includes("call 911") && out.html.includes("988");
      assert.equal(emergency, category === "concern", `${label}: the emergency numbers are for concerns`);
      assert.equal(
        out.html.includes("logged the request you sent us"),
        a.staffLogged,
        `${label}: the logged-on-your-behalf line`,
      );
      if (a.staffLogged) assert.ok(out.html.includes(`on ${RECEIVED}`), label);
      if (a.channel === "email") assert.ok(out.html.includes("sent us by email"), label);
      if (a.channel === "phone") assert.ok(out.html.includes("sent us by phone"), label);

      // The compiled fallback says the same things from the same input.
      const compiled = T.Templates.supportTicketReceived(input);
      assertComplete(`${label} (compiled)`, compiled);
      assert.ok(compiled.html.includes(RECEIVED), label);
      assert.equal(compiled.html.includes("48 hours from payment"), category === "refund", label);
      assert.equal(compiled.html.includes("988"), category === "concern", label);
      assert.ok(compiled.text.includes(RECEIVED), `${label}: the text part carries the time too`);
    }
  }
});

test("the receipt greets someone with no name on file without a hole", () => {
  const input = receivedInput("billing", ARRIVALS[0], null);
  const out = render(SUPPORT_EMAIL_KEYS.received, T.supportReceivedVars(input), null);
  assertComplete("no name", out);
  assert.ok(out.html.includes("Hi there,"));
  const compiled = T.Templates.supportTicketReceived(input);
  assertComplete("no name (compiled)", compiled);
  assert.ok(!compiled.html.includes("Hi ,"));
});

test("the team alert renders for every non-confidential category, refunds with their clock", () => {
  for (const category of TICKET_CATEGORIES.filter((c) => !isSensitiveCategory(c))) {
    for (const a of ARRIVALS) {
      const label = `${category}, ${a.label}`;
      const input = {
        reference: REFERENCE,
        category,
        categoryLabel: CATEGORY_LABELS[category],
        priorityLabel: PRIORITY_LABELS[defaultPriorityFor(category)],
        subject: "Week 2 video",
        requesterLabel: "Alex Rivera <alex@example.com>",
        receivedAt: RECEIVED,
        adminUrl: "https://batch0.org/admin/support/1234",
        channel: a.channel,
        staffLogged: a.staffLogged,
        loggedBy: a.staffLogged ? "Sam Staff" : null,
      };
      const out = render(SUPPORT_EMAIL_KEYS.internal, T.supportInternalVars(input), null);
      assert.deepEqual(out.missing, [], label);
      assertComplete(label, out);
      assert.ok(out.subject.startsWith("[support] "), label);
      assert.ok(!out.html.includes(BODY.slice(0, 20)), `${label}: never the request body`);
      // The paragraph the earlier draft's database copy dropped.
      assert.equal(out.html.includes("48-hour window"), category === "refund", label);
      assert.equal(out.html.includes("Logged by Sam Staff"), a.staffLogged, label);
      const compiled = T.Templates.supportTicketInternal(input);
      assertComplete(`${label} (compiled)`, compiled);
      assert.equal(compiled.html.includes("48-hour window"), category === "refund", label);
    }
  }
});

test("a confidential concern's team alert names nothing but the reference", () => {
  const row = seed(SUPPORT_EMAIL_KEYS.concernInternal);
  const tags = [...`${row.subject} ${row.preheader ?? ""} ${row.body_html} ${row.cta_url ?? ""}`.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tags)].sort(), ["admin_url", "reference"]);

  const input = { reference: REFERENCE, adminUrl: "https://batch0.org/admin/support/1234" };
  const out = render(SUPPORT_EMAIL_KEYS.concernInternal, T.supportConcernInternalVars(input), null);
  assert.deepEqual(out.missing, []);
  assertComplete("concern alert", out);
  assert.ok(out.html.includes(`A confidential concern was filed (${REFERENCE}). Open it in the admin.`));
  const compiled = T.Templates.supportConcernInternal(input);
  assertComplete("concern alert (compiled)", compiled);
  assert.ok(compiled.subject.includes("Confidential concern"));
});

test("the reply email renders, and says so when the reply also resolved it", () => {
  for (const resolved of [false, true]) {
    const input = {
      name: "Alex",
      reference: REFERENCE,
      subject: "Week 2 video",
      replierName: "Sam",
      reply: "Try this:\n1. Reload\n2. Clear cache",
      threadUrl: THREAD,
      resolved,
    };
    const out = render(SUPPORT_EMAIL_KEYS.replied, T.supportRepliedVars(input));
    assert.deepEqual(out.missing, []);
    assertComplete(`replied, resolved=${resolved}`, out);
    assert.match(out.html, /white-space:pre-wrap">Try this:\n1\. Reload\n2\. Clear cache/);
    assert.equal(out.html.includes("marked this request resolved"), resolved);
    const compiled = T.Templates.supportTicketReplied(input);
    assertComplete(`replied, resolved=${resolved} (compiled)`, compiled);
    assert.equal(compiled.html.includes("marked this request resolved"), resolved);
  }
});

test("the resolved email renders with the team's note, the automatic note, or neither", () => {
  for (const [label, extra, expect] of [
    ["auto", { note: null, auto: true }, "after 7 days without a reply"],
    ["with a note", { note: "Refund issued.\nAllow 5–10 days.", auto: false }, "Refund issued.\nAllow 5–10 days."],
    ["plain", { note: null, auto: false }, "nothing more you need to do"],
  ] as const) {
    const input = { name: "Alex", reference: REFERENCE, subject: "Refund", threadUrl: THREAD, ...extra };
    const out = render(SUPPORT_EMAIL_KEYS.resolved, T.supportResolvedVars(input));
    assert.deepEqual(out.missing, [], label);
    assertComplete(label, out);
    assert.ok(out.html.includes(expect), label);
    assert.ok(out.subject.startsWith("Resolved:"), "resolved is reopenable — never say closed");
    const compiled = T.Templates.supportTicketResolved(input);
    assertComplete(`${label} (compiled)`, compiled);
    assert.ok(compiled.html.includes(expect), label);
  }
});

test("the overdue digest lists confidential concerns by reference only", () => {
  const input = {
    asOf: RECEIVED,
    queueUrl: "https://batch0.org/admin/support",
    items: [
      {
        reference: "B0-AAAA-2222",
        sensitive: true,
        priorityLabel: "Urgent",
        categoryLabel: "Report a concern",
        subject: "SECRET SUBJECT",
        waitingFor: "6h 0m",
        overdueBy: "2h 0m",
        adminUrl: "https://batch0.org/admin/support/1",
      },
      {
        reference: "B0-BBBB-2222",
        sensitive: false,
        priorityLabel: "Normal",
        categoryLabel: "Tech help",
        subject: "Video <won't> play",
        waitingFor: "50h 0m",
        overdueBy: "2h 0m",
        adminUrl: "https://batch0.org/admin/support/2",
      },
    ],
  };
  const out = render(SUPPORT_EMAIL_KEYS.overdueDigest, T.supportDigestVars(input), null);
  assert.deepEqual(out.missing, []);
  assertComplete("digest", out);
  assert.ok(out.subject.includes("2 requests"));
  assert.ok(!out.html.includes("SECRET SUBJECT"));
  assert.ok(out.html.includes("Confidential concern B0-AAAA-2222"));
  assert.ok(out.html.includes("Video &lt;won't&gt; play"), "subjects arrive escaped");
  const compiled = T.Templates.supportOverdueDigest(input);
  assertComplete("digest (compiled)", compiled);
  assert.ok(!compiled.html.includes("SECRET SUBJECT"));
  assert.ok(!compiled.text?.includes("SECRET SUBJECT"));
});
