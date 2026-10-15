import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CHECKLIST, parseChecklist } from "./kickoff.ts";

test("the default checklist sends students to #general and their cohort's channel", () => {
  const chat = DEFAULT_CHECKLIST.find((i) => i.href === "/chat");
  assert.ok(chat);
  // #general is every accepted student plus mentors and investors; the
  // cohort meets in its own channel (0101).
  assert.match(chat.label, /#general and your cohort's channel/);
});

test("a checklist saved before Chat loses its Discord row's words, and keeps the rest", () => {
  const saved = [
    { label: "Work through Before One", href: "/dashboard/resources" },
    { label: "Link Discord and meet your cohort", href: "/dashboard/community" },
    { label: "Join the cohort Discord!", href: "/dashboard/community" },
    { label: "Start your team", href: "/dashboard/team" },
  ];
  assert.deepEqual(parseChecklist(saved), [
    { label: "Work through Before One", href: "/dashboard/resources" },
    { label: "Say hi in #general and your cohort's channel", href: "/chat" },
    { label: "Say hi in #general and your cohort's channel", href: "/chat" },
    { label: "Start your team", href: "/dashboard/team" },
  ]);
});

test("checklist rows still need a label and a safe link", () => {
  assert.equal(parseChecklist([{ label: "x", href: "javascript:alert(1)" }]), null);
  assert.equal(parseChecklist([{ label: "", href: "/chat" }]), null);
  assert.equal(parseChecklist("nope"), null);
  assert.deepEqual(parseChecklist([{ label: " Chat ", href: " /chat " }]), [{ label: "Chat", href: "/chat" }]);
});
