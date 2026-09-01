import { buildEnvelopes, joinNames, personalize, pickParentEmail } from "../app/admin/email/blast/shared.ts";

let fails = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${ok ? "" : `\n         got ${a}\n         want ${e}`}`);
  if (!ok) fails++;
}

const alex = { email: "alex@school.edu", full_name: "Alex Rivera", parentEmail: "mum@home.com" };
const sam  = { email: "sam@school.edu",  full_name: "Sam Rivera",  parentEmail: "mum@home.com" }; // sibling
const jo   = { email: "jo@school.edu",   full_name: "Jo Patel",    parentEmail: null };           // no parent
const kim  = { email: "kim.parent@home.com", full_name: "Kim Chen", parentEmail: "KIM.PARENT@home.com" }; // same addr, diff case

console.log("\nstudents only\n");
eq("uses student addresses", buildEnvelopes([alex, sam, jo], "students").map(e => e.email),
   ["alex@school.edu", "sam@school.edu", "jo@school.edu"]);
eq("ignores parent addresses", buildEnvelopes([alex], "students").map(e => e.kind), ["student"]);

console.log("\nparents only\n");
const parents = buildEnvelopes([alex, sam, jo], "parents");
eq("siblings collapse to one parent email", parents.map(e => e.email), ["mum@home.com"]);
eq("both children named", parents[0].students.sort(), ["Alex", "Sam"]);
eq("parent is greeted neutrally", parents[0].greet, "there");
eq("no-parent student is dropped", parents.length, 1);

console.log("\nboth\n");
const both = buildEnvelopes([alex, sam, jo], "both");
eq("student + parent addresses, parent deduped", both.map(e => e.email),
   ["alex@school.edu", "mum@home.com", "sam@school.edu", "jo@school.edu"]);
eq("no address appears twice", new Set(both.map(e => e.email.toLowerCase())).size, both.length);

console.log("\nstudent address == parent address\n");
const same = buildEnvelopes([kim], "both");
eq("collapses to one send", same.length, 1);
eq("student wins over parent", same[0].kind, "student");
eq("…so they're greeted by name", same[0].greet, "Kim");

console.log("\ntoken filling\n");
eq("{{student}} joins two names", joinNames(["Alex", "Sam"]), "Alex and Sam");
eq("{{student}} joins three", joinNames(["Alex", "Sam", "Jo"]), "Alex, Sam, and Jo");
eq("both tokens fill", personalize("Hi {{name}}, re {{student}}.", "there", "Alex and Sam"),
   "Hi there, re Alex and Sam.");

console.log("\nparent email from multiple applications\n");
eq("furthest-along application wins", pickParentEmail([
  { status: "draft",    parent_email: "old@home.com",  created_at: "2026-01-01" },
  { status: "enrolled", parent_email: "current@home.com", created_at: "2025-01-01" },
]), "current@home.com");
eq("most recent breaks a tie", pickParentEmail([
  { status: "submitted", parent_email: "older@home.com", created_at: "2025-01-01" },
  { status: "submitted", parent_email: "newer@home.com", created_at: "2026-01-01" },
]), "newer@home.com");
eq("blank parent emails ignored", pickParentEmail([
  { status: "enrolled", parent_email: "   ", created_at: "2026-01-01" },
  { status: "draft",    parent_email: "real@home.com", created_at: "2025-01-01" },
]), "real@home.com");
eq("none returns null", pickParentEmail([{ status: "draft", parent_email: null }]), null);

console.log(fails === 0 ? "\nAll dedupe checks passed.\n" : `\n${fails} failed.\n`);
process.exit(fails ? 1 : 0);
