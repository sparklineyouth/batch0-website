import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Run the real application actions against isolated auth/database doubles.
// This covers the merge between admissions rollover and resilient autosave;
// no credentials, network requests, mail, or real application writes occur.
const fall = { id: "fall", name: "Fall", status: "active", starts_on: "2026-09-14", ends_on: "2026-11-13", late_entry_until: "2026-10-01T03:59:59.999Z", catch_up_plan: "Review Week 1", capacity: 24 };
const winter = { id: "winter", name: "Winter", status: "upcoming", starts_on: "2026-12-14", ends_on: "2027-02-12", applications_close_at: "2026-12-12T23:59:00Z", capacity: 24 };
const user = { id: "student" };
const state: any = {};
function reset() {
  Object.assign(state, {
    history: [], authReplies: [{ data: { user }, error: null }],
    authCalls: 0, tokenCalls: 0, tokenUser: user,
    writes: [], attributed: [], revalidated: [],
  });
}
reset();
const db = {
  auth: { async getUser() {
    const response = state.authReplies[Math.min(state.authCalls, state.authReplies.length - 1)];
    state.authCalls++;
    return response;
  } },
  from(table: string) {
    let mutation: string | null = null;
    let payload: any;
    let singleton = false;
    const filters: Record<string, unknown> = {};
    const result = () => {
      if (mutation) {
        assert.equal(table, "applications");
        state.writes.push({ mutation, payload, filters });
        return { data: { id: "saved-application" }, error: null };
      }
      if (table === "cohorts") return { data: [fall, winter], error: null };
      if (table === "site_settings") return { data: { value: filters.key === "active_cohort_id" ? "fall" : true }, error: null };
      if (table === "profiles") return { data: null, error: null };
      if (table === "applications") return { data: singleton ? state.history[0] ?? null : state.history, error: null };
      throw Error(`Unexpected table: ${table}`);
    };
    const chain: any = { then(resolve: any, reject: any) { return Promise.resolve().then(result).then(resolve, reject); } };
    for (const method of ["select", "order", "limit", "in"]) chain[method] = () => chain;
    for (const method of ["single", "maybeSingle"]) chain[method] = () => { singleton = true; return chain; };
    chain.eq = (key: string, value: unknown) => { filters[key] = value; return chain; };
    for (const method of ["insert", "update"]) chain[method] = (value: any) => { mutation = method; payload = value; return chain; };
    return chain;
  },
};
(globalThis as any).__applyRollover = { state, db };
const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const hook = (nodeModule as any).registerHooks({ resolve(specifier: string, context: any, next: any) {
  const g = "const t=globalThis.__applyRollover;";
  const doubles: Record<string, string> = {
    "@/lib/supabase/server": g + "export const createClient=async()=>t.db;",
    "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
    "@/lib/auth": g + "export const getUser=async()=>{t.state.tokenCalls++;return t.state.tokenUser;};",
    "@/lib/campaign-attribution-server": g + "export const attachCampaignAttribution=async id=>{t.state.attributed.push(id);};",
    "next/cache": g + "export const revalidatePath=path=>t.state.revalidated.push(path);",
    "next/headers": "export const headers=async()=>new Headers();",
    "next/navigation": "export const redirect=path=>{throw Error('Unexpected redirect: '+path);};",
    "@/lib/pricing": "export const getCountryFromHeaders=()=>null;",
    "@/lib/rate-limit": "export const checkRateLimit=async()=>({ok:true});",
    "@/lib/founder-pass": "export const canBypassClosedApplications=async()=>false;export const hasFounderPass=async()=>false;",
    "@/lib/application-questions": "export const getApplicationForm=async()=>({builtins:[],custom:[]});",
    "@/lib/scholarships": "export const getScholarshipInterestQuestions=async()=>[];",
    "@/lib/site-config": "export const getSiteConfig=async()=>({settings:{referralsEnabled:true}});",
    "@/lib/admissions": "export const autoAdmitOnSubmit=async()=>{throw Error('Unexpected submit');};",
    "@/lib/email/send": "export const sendEmail=()=>{throw Error('Unexpected email');};",
    "@/lib/email/templates": "export const Templates={};",
    "@/lib/email/dispatch": "export const sendTemplated=()=>{throw Error('Unexpected email');};export const emitEmailEvent=sendTemplated;",
    "@/lib/notifications": "export const notify=()=>{throw Error('Unexpected notification');};",
    "@/lib/discord": "export const postChannelMessage=()=>{throw Error('Unexpected Discord');};export const applicationEmbed=postChannelMessage;export const getDiscordSettings=postChannelMessage;",
    "@/lib/env": "export const env={siteUrl:'https://batch0.test'};",
  };
  if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
  if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
  return next(specifier, context);
} });
const { saveDraftAction, submitApplicationAction, attachReferralCodeAction } = await import("../app/apply/actions.ts");
const afterCutoff = Date.parse("2026-10-01T04:00:00Z");
function form(cohort = "fall") {
  const fd = new FormData();
  for (const [key, value] of Object.entries({ cohort_id: cohort, full_name: "Ada Student", age: "18", phone: "+1 555 123 4567", team_size: "1", why_join: "I want to learn to build a company with other students and test an idea." })) fd.set(key, value);
  return fd;
}
const outage = { data: { user: null }, error: { status: 503, name: "AuthRetryableFetchError" } };

test("an open Fall form saves its same-cohort answers after cutoff despite a temporary auth outage", async t => {
  reset();
  t.mock.timers.enable({ apis: ["Date"], now: afterCutoff });
  state.history = [{ id: "draft-fall", status: "draft", cohort_id: "fall" }];
  state.authReplies = [outage];
  const result = await saveDraftAction(null, form());
  assert.equal(result.ok, true);
  assert.equal(state.authCalls, 2);
  assert.equal(state.tokenCalls, 1);
  assert.equal(state.writes[0].payload.cohort_id, "fall");
  assert.equal(state.writes[0].filters.id, "draft-fall");
  assert.deepEqual(state.attributed, ["draft-fall"]);
  assert.ok(!state.revalidated.includes("/apply"), "draft autosave must not rerender the whole flow");
});

test("submit never falls back to a verified token while Auth is unavailable", async () => {
  reset(); state.authReplies = [outage];
  const result = await submitApplicationAction(null, form());
  assert.equal(result.code, "auth_unavailable");
  assert.equal(state.tokenCalls, 0);
  assert.equal(state.writes.length, 0);
  assert.equal(state.attributed.length, 0);
});

test("a rejected session cannot use draft fallback or attach attribution", async () => {
  for (const status of [401, 403]) {
    reset(); state.authReplies = [{ data: { user: null }, error: { status, name: "AuthApiError" } }];
    const result = await saveDraftAction(null, form());
    assert.equal(result.code, "signed_out");
    assert.equal(state.authCalls, 1);
    assert.equal(state.tokenCalls, 0);
    assert.equal(state.writes.length, 0);
    assert.equal(state.attributed.length, 0);
  }
});

test("Fall submit after cutoff is rejected without silently moving its saved application", async t => {
  reset(); t.mock.timers.enable({ apis: ["Date"], now: afterCutoff });
  state.history = [{ id: "draft-fall", status: "draft", cohort_id: "fall" }];
  const result = await submitApplicationAction(null, form());
  assert.equal(result.ok, false);
  assert.match(result.error!, /draft has not been moved/);
  assert.equal(state.writes.length, 0);
  assert.equal(state.attributed.length, 0);
});

test("a deliberate Winter pick moves only the editable draft and saves attribution", async t => {
  reset(); t.mock.timers.enable({ apis: ["Date"], now: afterCutoff });
  state.history = [{ id: "draft-fall", status: "draft", cohort_id: "fall" }];
  assert.equal((await saveDraftAction(null, form("winter"))).ok, true);
  assert.equal(state.writes[0].payload.cohort_id, "winter");
  assert.equal(state.writes[0].filters.id, "draft-fall");
  assert.deepEqual(state.attributed, ["draft-fall"]);
});

test("a referral landing saves its campaign without inventing the applicant's cohort choice", async () => {
  reset();
  assert.equal((await attachReferralCodeAction(" Friend ")).ok, true);
  assert.equal(state.writes[0].payload.cohort_id, null);
  assert.equal(state.writes[0].payload.referral_code, "friend");
  assert.deepEqual(state.attributed, ["saved-application"]);
});

test.after(() => { hook.deregister(); delete (globalThis as any).__applyRollover; });
