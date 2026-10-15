import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STUDENT_NAV_LAYOUT,
  STUDENT_NAV_MAX,
  isStudentHrefVisible,
  TEAM_TOOL_HREFS,
  isTeamToolVisible,
  type StudentNavContext,
} from "./student-nav.ts";
import { PRE_COHORT_ALLOWED_HREFS, isPreCohortAllowedPath } from "./pre-cohort.ts";

const HREFS = STUDENT_NAV_LAYOUT.flatMap((g) => g.items.map((i) => i.href));

function visible(ctx: StudentNavContext): string[] {
  return HREFS.filter((h) => isStudentHrefVisible(h, ctx));
}

function* everyContext(): Generator<StudentNavContext> {
  for (let bits = 0; bits < 16; bits++) {
    yield {
      enrolled: !!(bits & 1),
      preCohort: !!(bits & 2),
      referralsEnabled: !!(bits & 4),
      demoDayTicket: !!(bits & 8),
    };
  }
}

test(`no student sees more than ${STUDENT_NAV_MAX} links`, () => {
  for (const ctx of everyContext()) {
    const v = visible(ctx);
    assert.ok(v.length <= STUDENT_NAV_MAX, `${JSON.stringify(ctx)} → ${v.length}: ${v.join(", ")}`);
  }
});

test("every link is unique and Home is always there", () => {
  assert.equal(new Set(HREFS).size, HREFS.length);
  for (const ctx of everyContext()) assert.ok(visible(ctx).includes("/dashboard"));
});

test("pre-cohort shows only what middleware lets through", () => {
  for (const ctx of everyContext()) {
    if (!ctx.preCohort) continue;
    for (const h of visible(ctx)) assert.ok(PRE_COHORT_ALLOWED_HREFS.has(h), h);
  }
});

const ALL_ON = { referralsEnabled: true, demoDayTicket: false };

test("enrolled, cohort running: the program, not the lifecycle", () => {
  assert.deepEqual(visible({ ...ALL_ON, enrolled: true, preCohort: false }), [
    "/dashboard",
    "/chat",
    "/dashboard/course",
    "/dashboard/assignments",
    "/dashboard/team",
    "/dashboard/events",
    "/dashboard/calls",
    "/dashboard/resources",
    "/dashboard/announcements",
    "/dashboard/billing",
    "/dashboard/support",
    "/dashboard/settings",
  ]);
});

test("enrolled, counting down: kickoff, team, scholarships; no course yet", () => {
  const v = visible({ ...ALL_ON, enrolled: true, preCohort: true });
  for (const h of ["/dashboard/kickoff", "/dashboard/team", "/dashboard/scholarships", "/dashboard/referrals"]) {
    assert.ok(v.includes(h), h);
  }
  for (const h of ["/dashboard/course", "/dashboard/assignments", "/dashboard/events", "/dashboard/application"]) {
    assert.ok(!v.includes(h), h);
  }
});

test("applicant: application and account pages; Events only with a ticket", () => {
  const v = visible({ ...ALL_ON, enrolled: false, preCohort: false });
  assert.ok(v.includes("/dashboard/application"));
  assert.ok(v.includes("/dashboard/calls"));
  assert.ok(!v.includes("/dashboard/kickoff"));
  assert.ok(!v.includes("/dashboard/events"));
  assert.ok(visible({ ...ALL_ON, enrolled: false, preCohort: false, demoDayTicket: true }).includes("/dashboard/events"));
});

test("the referrals flag hides Refer friends", () => {
  const v = visible({ enrolled: false, preCohort: false, referralsEnabled: false });
  assert.ok(!v.includes("/dashboard/referrals"));
});

test("Chat is in every student's nav: the team for an applicant, the cohort after", () => {
  for (const ctx of everyContext()) assert.ok(visible(ctx).includes("/chat"), JSON.stringify(ctx));
});

test("Chat sits in the group that can't be collapsed, so its unread badge is always mounted", () => {
  // components/sidebar-nav.tsx renders a labeled group's items only while it's
  // open; the unlabeled top group has no toggle.
  const home = STUDENT_NAV_LAYOUT.find((g) => g.label === "");
  assert.ok(home?.items.some((i) => i.href === "/chat"));
});

test("Team page tool chips shown pre-cohort all pass the middleware", () => {
  for (const ai of [false, true]) {
    for (const h of TEAM_TOOL_HREFS) {
      if (isTeamToolVisible(h, { preCohort: true, ai })) {
        assert.ok(isPreCohortAllowedPath(h), h);
      }
    }
  }
  assert.ok(!isTeamToolVisible("/dashboard/intros", { preCohort: true, ai: true }));
  assert.ok(isTeamToolVisible("/dashboard/intros", { preCohort: false, ai: false }));
  assert.ok(isTeamToolVisible("/dashboard/team/offers", { preCohort: true, ai: false }));
  assert.ok(!isTeamToolVisible("/dashboard/ai", { preCohort: false, ai: false }));
});
