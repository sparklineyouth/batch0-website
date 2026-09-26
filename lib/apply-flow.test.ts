import test from "node:test";
import assert from "node:assert/strict";
import {
  asksParentEmail,
  buildQuestionMap,
  buildScreens,
  emptyForm,
  fieldError,
  FORM_KEYS,
  postableForm,
  promptFor,
  requiredBuiltinErrors,
  resumeIndex,
  screenIndexForField,
  validateAll,
  validateScreen,
  withScheme,
  type FormState,
  type ScreenArgs,
  type ValidationContext,
} from "./apply-flow.ts";
import { QUESTION_FIELDS } from "./application-fields.ts";
import type { CustomQuestion } from "./question-schema.ts";

const cfg = buildQuestionMap(QUESTION_FIELDS.map((f) => ({ ...f })));

function args(over: Partial<ScreenArgs> = {}): ScreenArgs {
  return {
    cfg,
    customQuestions: [],
    scholarshipQuestions: [],
    customPrefix: "custom",
    scholarshipPrefix: "sch",
    chooseCohort: false,
    form: { age: "" },
    ...over,
  };
}

function complete(over: Partial<FormState> = {}): FormState {
  return {
    ...emptyForm(),
    full_name: "Ada Lovelace",
    age: "17",
    phone: "+1 (555) 123-4567",
    parent_email: "parent@example.com",
    why_join: "I want to build something real with people who take it seriously.",
    team_size: "1",
    ...over,
  };
}

function ctx(form: FormState, over: Partial<ValidationContext> = {}): ValidationContext {
  return { form, cfg, extra: {}, cohortId: "winter", cohortIds: ["winter"], ...over };
}

const ids = (screens: { id: string }[]) => screens.map((s) => s.id);

test("one open cohort: no cohort question — it is simply the one they apply to", () => {
  const screens = buildScreens(args({ chooseCohort: false }));
  assert.ok(!ids(screens).includes("cohort"));
  assert.equal(screens[0].id, "welcome");
  assert.equal(screens[1].id, "full_name");
  assert.equal(screens.at(-1)?.id, "review");
});

test("several open cohorts: choosing one is the first question", () => {
  const screens = buildScreens(args({ chooseCohort: true }));
  assert.equal(screens[1].id, "cohort");
});

test("the cohort question refuses to continue without a pick, or with one that isn't open", () => {
  const screen = buildScreens(args({ chooseCohort: true }))[1];
  assert.deepEqual(validateScreen(screen, ctx(complete(), { cohortId: "winter", cohortIds: ["fall", "winter"] })), {});
  assert.ok(validateScreen(screen, ctx(complete(), { cohortId: null, cohortIds: ["fall", "winter"] })).cohort_id);
  assert.ok(validateScreen(screen, ctx(complete(), { cohortId: "spring", cohortIds: ["fall", "winter"] })).cohort_id);
});

test("the parent/guardian question appears exactly when the applicant is under 18", () => {
  assert.ok(ids(buildScreens(args({ form: { age: "16" } }))).includes("parent_email"));
  assert.ok(!ids(buildScreens(args({ form: { age: "18" } }))).includes("parent_email"));
  assert.ok(!ids(buildScreens(args({ form: { age: "" } }))).includes("parent_email"));
  // Straight after age, so the "why" is obvious.
  const s = ids(buildScreens(args({ form: { age: "15" } })));
  assert.equal(s.indexOf("parent_email"), s.indexOf("age") + 1);
});

test("a minor is asked for a parent email even if an admin removed the field", () => {
  // SubmitSchema requires it for minors regardless; hiding it would strand them.
  const hidden = buildQuestionMap([{ ...cfg.parent_email, hidden: true }]);
  assert.equal(asksParentEmail(hidden, { age: "15" }), true);
  assert.equal(asksParentEmail(hidden, { age: "19" }), false);
  assert.ok(fieldError("parent_email", complete({ age: "15", parent_email: "" }), hidden));
});

test("an adult is asked for a parent email only when an admin made it required", () => {
  const required = buildQuestionMap([{ ...cfg.parent_email, required: true }]);
  assert.equal(asksParentEmail(required, { age: "30" }), true);
  assert.equal(asksParentEmail(cfg, { age: "30" }), false);
});

test("hidden optional fields drop out of the flow; the five cores never do", () => {
  const trimmed = buildQuestionMap([
    { ...cfg.school, hidden: true },
    { ...cfg.city, hidden: true },
    { ...cfg.country, hidden: true },
    { ...cfg.linkedin_url, hidden: true },
    { ...cfg.resume_url, hidden: true },
    { ...cfg.portfolio_url, hidden: true },
    { ...cfg.full_name, hidden: true },
  ]);
  const s = ids(buildScreens(args({ cfg: trimmed })));
  assert.ok(!s.includes("school"));
  assert.ok(!s.includes("location"));
  assert.ok(!s.includes("links"));
  for (const core of ["full_name", "age", "phone", "why_join", "team_size"]) {
    assert.ok(s.includes(core), `${core} missing`);
  }
});

test("a field an admin marked required is enforced — client and server agree", () => {
  // Live config today: Country and Experience are required but were only ever
  // decorated with an asterisk.
  const live = buildQuestionMap([
    { ...cfg.country, required: true },
    { ...cfg.experience, required: true },
  ]);
  const form = complete();
  const screens = buildScreens(args({ cfg: live, form }));
  const { errors, firstInvalid } = validateAll(screens, ctx(form, { cfg: live }));
  assert.ok(errors.country);
  assert.ok(errors.experience);
  assert.equal(screens[firstInvalid].id, "location");

  const server = requiredBuiltinErrors(live, form);
  assert.deepEqual(Object.keys(server).sort(), ["country", "experience"]);
  assert.deepEqual(requiredBuiltinErrors(live, { ...form, country: "US", experience: "Ran a club" }), {});
});

test("the server check ignores hidden fields, and reads blanks from the raw post", () => {
  const hidden = buildQuestionMap([{ ...cfg.school, required: true, hidden: true }]);
  assert.deepEqual(requiredBuiltinErrors(hidden, complete({ school: "" })), {});
  // An admin-required parent email is asked of adults too, so it's checked.
  const parent = buildQuestionMap([{ ...cfg.parent_email, required: true }]);
  assert.deepEqual(Object.keys(requiredBuiltinErrors(parent, complete({ parent_email: "" }))), ["parent_email"]);
  // Raw posted strings: a blank hours field is "" (zod would have made it 0).
  const hours = buildQuestionMap([{ ...cfg.hours_per_week, required: true }]);
  assert.ok(requiredBuiltinErrors(hours, { ...complete(), hours_per_week: "  " }).hours_per_week);
});

test("a parent email is posted only while the flow is asking for it", () => {
  // Half-typed and left behind: would fail every save.
  assert.equal(postableForm(complete({ age: "19", parent_email: "mom@gm" }), cfg).parent_email, "");
  // Valid but left behind: invisible to the applicant, yet parent outreach would use it.
  assert.equal(postableForm(complete({ age: "19" }), cfg).parent_email, "");
  // Still asked (a minor, or an admin requiring it of everyone): posted as typed.
  assert.equal(postableForm(complete({ age: "17", parent_email: "mom@gm" }), cfg).parent_email, "mom@gm");
  const required = buildQuestionMap([{ ...cfg.parent_email, required: true }]);
  assert.equal(postableForm(complete({ age: "30" }), required).parent_email, "parent@example.com");
});

test("bare domains get a scheme; other text is left for the validator", () => {
  assert.equal(withScheme("github.com/ada"), "https://github.com/ada");
  assert.equal(withScheme("https://x.y"), "https://x.y");
  assert.equal(withScheme("not a link"), "not a link");
  assert.equal(withScheme(""), "");
});

test("a complete application passes every screen", () => {
  const form = complete();
  const screens = buildScreens(args({ form, chooseCohort: true }));
  const result = validateAll(screens, ctx(form));
  assert.deepEqual(result.errors, {});
  assert.equal(result.firstInvalid, -1);
});

test("field rules mirror SubmitSchema", () => {
  assert.ok(fieldError("age", complete({ age: "9" }), cfg));
  assert.ok(fieldError("age", complete({ age: "26" }), cfg));
  assert.ok(fieldError("age", complete({ age: "16.5" }), cfg));
  assert.equal(fieldError("age", complete({ age: "25" }), cfg), null);
  assert.ok(fieldError("phone", complete({ phone: "call me" }), cfg));
  assert.ok(fieldError("why_join", complete({ why_join: "short" }), cfg)?.includes("you're at 5"));
  assert.ok(fieldError("team_size", complete({ team_size: "" }), cfg));
  assert.ok(fieldError("team_size", complete({ team_size: "6" }), cfg));
  assert.ok(fieldError("hours_per_week", complete({ hours_per_week: "200" }), cfg));
  assert.ok(fieldError("hours_per_week", complete({ hours_per_week: "ten" }), cfg));
  assert.equal(fieldError("hours_per_week", complete({ hours_per_week: "" }), cfg), null);
  assert.ok(fieldError("linkedin_url", complete({ linkedin_url: "linkedin.com/in/ada" }), cfg));
  assert.equal(fieldError("linkedin_url", complete({ linkedin_url: "https://linkedin.com/in/ada" }), cfg), null);
  assert.ok(fieldError("parent_email", complete({ parent_email: "nope" }), cfg));
  assert.ok(fieldError("full_name", complete({ full_name: "x".repeat(121) }), cfg));
});

test("admin-added and scholarship questions each get a screen, and are validated", () => {
  const custom: CustomQuestion[] = [
    { id: "biggest_risk", type: "textarea", label: "Biggest risk?", help: "", placeholder: "", required: true, hidden: false, options: [] },
    { id: "gone", type: "text", label: "Removed", help: "", placeholder: "", required: true, hidden: true, options: [] },
  ];
  const scholarship: CustomQuestion[] = [
    { id: "cost_barrier", type: "radio", label: "Is cost a barrier?", help: "", placeholder: "", required: true, hidden: false, options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] },
    { id: "note", type: "text", label: "Anything else?", help: "", placeholder: "", required: false, hidden: false, options: [] },
  ];
  const screens = buildScreens(args({ customQuestions: custom, scholarshipQuestions: scholarship }));
  const s = ids(screens);
  assert.ok(s.includes("custom__biggest_risk"));
  assert.ok(!s.includes("custom__gone"));
  const schScreens = screens.filter((x) => x.kind === "custom" && x.section === "scholarships");
  assert.deepEqual(schScreens.map((x) => (x as { intro: boolean }).intro), [true, false]);
  assert.equal(s.at(-2), "sch__note");

  const form = complete();
  const missing = validateAll(screens, ctx(form));
  assert.ok(missing.errors["custom__biggest_risk"]);
  assert.ok(missing.errors["sch__cost_barrier"]);
  const answered = validateAll(screens, ctx(form, { extra: { custom__biggest_risk: "Nobody pays", sch__cost_barrier: "no" } }));
  assert.deepEqual(answered.errors, {});
});

test("a server field error routes to the screen that owns the field", () => {
  const screens = buildScreens(args({ chooseCohort: true, form: { age: "15" } }));
  assert.equal(screens[screenIndexForField(screens, "country")].id, "location");
  assert.equal(screens[screenIndexForField(screens, "resume_url")].id, "links");
  assert.equal(screens[screenIndexForField(screens, "parent_email")].id, "parent_email");
  assert.equal(screens[screenIndexForField(screens, "cohort_id")].id, "cohort");
  assert.equal(screenIndexForField(screens, "nonsense"), -1);
});

test("a returning draft reopens at its first gap, or just past the last answer", () => {
  const partial = { ...emptyForm(), full_name: "Ada", age: "19", phone: "555 123 4567" };
  const screens = buildScreens(args({ form: partial }));
  assert.equal(screens[resumeIndex(screens, ctx(partial))].id, "grade");

  const gap = { ...partial, phone: "" , school: "Hopper High" };
  assert.equal(screens[resumeIndex(screens, ctx(gap))].id, "phone");

  const done = complete({ age: "19" });
  const all = buildScreens(args({ form: done }));
  const full = { ...done, grade: "12th", school: "X", city: "Y", country: "Z", startup_idea: "i", experience: "e", hours_per_week: "5", linkedin_url: "https://x.y", referral_source: "Google" };
  assert.equal(all[resumeIndex(all, ctx(full))].id, "review");
});

test("conversational prompts only while the admin hasn't reworded the question", () => {
  assert.match(promptFor("age", cfg, "Ada"), /Ada/);
  const edited = buildQuestionMap([{ ...cfg.experience, label: "Tell us a hurdle you faced and how you overcame it." }]);
  assert.equal(promptFor("experience", edited, "Ada"), "Tell us a hurdle you faced and how you overcame it.");
});

test("every built-in key is carried by FORM_KEYS, in skeleton order", () => {
  assert.deepEqual(FORM_KEYS, QUESTION_FIELDS.map((f) => f.key));
  assert.equal(new Set(FORM_KEYS).size, 17);
});
