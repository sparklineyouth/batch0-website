import { test } from "node:test";
import assert from "node:assert/strict";
import { exactEmailLookup, MAX_INVITES_PER_PASTE, parseInviteEmails, TEAM_MAX_MEMBERS } from "./team-invites.ts";

// Run with `npm test`. What the Team tab's "By email" box sends to
// inviteStudentsByEmail (app/dashboard/team/actions.ts).

test("one address per line, or comma/semicolon separated, lowercased and de-duplicated", () => {
  assert.deepEqual(parseInviteEmails("Ada@School.edu\nbob@school.edu, cy@school.edu;ada@school.edu"), {
    emails: ["ada@school.edu", "bob@school.edu", "cy@school.edu"],
    invalid: [],
    overflow: [],
  });
});

test("a To line copied from an email client: names are ignored, brackets stripped", () => {
  assert.deepEqual(
    parseInviteEmails('Ada Lovelace <ada@school.edu>, "Bob" <bob@school.edu>'),
    { emails: ["ada@school.edu", "bob@school.edu"], invalid: [], overflow: [] },
  );
  // A sentence-final full stop isn't part of the address.
  assert.deepEqual(parseInviteEmails("invite ada@school.edu.").emails, ["ada@school.edu"]);
});

test("something with an @ that isn't an address is reported, not sent", () => {
  assert.deepEqual(parseInviteEmails("ada@school, @bob, bob@school.edu"), {
    emails: ["bob@school.edu"],
    invalid: ["ada@school", "@bob"],
    overflow: [],
  });
});

test("one paste invites at most everyone but the sender; the rest wait", () => {
  assert.equal(MAX_INVITES_PER_PASTE, TEAM_MAX_MEMBERS - 1);
  const six = Array.from({ length: 6 }, (_, i) => `p${i}@school.edu`).join("\n");
  const parsed = parseInviteEmails(six);
  assert.equal(parsed.emails.length, MAX_INVITES_PER_PASTE);
  assert.deepEqual(parsed.overflow, ["p4@school.edu", "p5@school.edu"]);
});

test("nothing pasted is nothing to send", () => {
  assert.deepEqual(parseInviteEmails("   \n , "), { emails: [], invalid: [], overflow: [] });
  assert.deepEqual(parseInviteEmails("just a name"), { emails: [], invalid: [], overflow: [] });
});

test("an address is looked up literally: LIKE wildcards are escaped, * is matched exactly", () => {
  assert.deepEqual(exactEmailLookup("Ada@School.edu"), { op: "ilike", value: "ada@school.edu" });
  assert.deepEqual(exactEmailLookup("%@batch0.org"), { op: "ilike", value: "\\%@batch0.org" });
  assert.deepEqual(exactEmailLookup("jo_n@school.edu"), { op: "ilike", value: "jo\\_n@school.edu" });
  assert.deepEqual(exactEmailLookup("a\\b@school.edu"), { op: "ilike", value: "a\\\\b@school.edu" });
  // PostgREST reads * as % and can't escape it.
  assert.deepEqual(exactEmailLookup("a*@school.edu"), { op: "eq", value: "a*@school.edu" });
});
