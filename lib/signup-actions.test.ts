import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Run with `npm test`. The real signUpAction (app/(auth)/signup/actions.ts)
// and the real lib/rate-limit.ts against doubles, for the per-network limit:
// /signup creates a pre-confirmed account and mails it a welcome, and nothing
// stopped one address from scripting as many as it could post. The rpc
// double counts like rate_limit_check (0005): one more per call, per key.

const state = {
  created: [] as string[],
  mailed: 0,
  warned: [] as unknown[][],
  counts: new Map<string, number>(),
  headers: {} as Record<string, string>,
  limiterDown: false,
};
(globalThis as any).__signupTest = state;
console.warn = (...args: unknown[]) => void state.warned.push(args);
console.error = () => {};

const admin = {
  auth: {
    admin: {
      createUser: async (a: { email: string }) => {
        // As GoTrue answers an address that already has an account.
        if (state.created.includes(a.email)) {
          return { data: { user: null }, error: { code: "email_exists", message: "A user with this email address has already been registered" } };
        }
        state.created.push(a.email);
        return { data: { user: { id: `u${state.created.length}`, email: a.email } }, error: null };
      },
    },
  },
  rpc: async (name: string, args: { p_key: string }) => {
    assert.equal(name, "rate_limit_check");
    if (state.limiterDown) return { data: null, error: { message: "upstream request timeout" } };
    const n = (state.counts.get(args.p_key) ?? 0) + 1;
    state.counts.set(args.p_key, n);
    return { data: n, error: null };
  },
};
(globalThis as any).__signupTest.admin = admin;

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__signupTest;";
    const doubles: Record<string, string> = {
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.admin;",
      "@/lib/email/send": "export const sendEmail=async()=>{};",
      "@/lib/email/templates": "export const Templates={welcome:()=>({subject:'',html:''})};",
      "@/lib/email/dispatch": g + "export const sendTemplated=async()=>{t.mailed++;};export const emitEmailEvent=async()=>{};",
      "@/lib/notifications": "export const notify=async()=>{};",
      "next/headers": g + "export const headers=async()=>new Headers(t.headers);",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) {
      return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    }
    return next(specifier, context);
  },
});
const { signUpAction } = await import("../app/(auth)/signup/actions.ts");
const { clientIpFrom } = await import("./rate-limit.ts");

function reset(headers: Record<string, string>) {
  state.created = [];
  state.mailed = 0;
  state.warned = [];
  state.counts = new Map();
  state.headers = headers;
  state.limiterDown = false;
}
const person = (n: number) => ({ email: `student${n}@school.edu`, password: "correct-horse-9", fullName: `Student ${n}` });

const LIMITED = /Wait a few minutes/;

test("two whole classes on one school network sign up in one window, a retry each included", async () => {
  // The day the limit must not spoil: a school is one address for every room
  // in it, and a class is 25 to 35. Two classes of 35 sign up in the same
  // quarter hour, and 30 of the 70 students first try an address that
  // already has an account (an older account, a sibling's) before using
  // their own. Every one of those 100 attempts counts; none is turned away.
  reset({ "x-forwarded-for": "203.0.113.9" });
  for (let i = 1; i <= 30; i++) assert.deepEqual(await signUpAction(person(i)), { ok: true }, `student ${i}`);
  for (let i = 31; i <= 70; i++) {
    if (i <= 60) {
      const retry = await signUpAction(person(i - 30));
      assert.equal(retry.ok, false);
      assert.doesNotMatch((retry as any).error, LIMITED, `retry by student ${i}`);
      assert.match((retry as any).error, /already/);
    }
    assert.deepEqual(await signUpAction(person(i)), { ok: true }, `student ${i}`);
  }
  assert.equal(state.created.length, 70, "every student has an account");
  assert.equal(state.counts.get("signup:ip:203.0.113.9"), 100);
  assert.equal(state.warned.length, 0, "and the limit never fired");
});

test("one network gets a hundred signups in a window; the next creates nothing and mails nothing", async () => {
  reset({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
  for (let i = 1; i <= 100; i++) assert.deepEqual(await signUpAction(person(i)), { ok: true }, `signup ${i}`);
  assert.equal(state.created.length, 100);
  const refused = await signUpAction(person(101));
  assert.equal(refused.ok, false);
  assert.match((refused as any).error, LIMITED);
  assert.equal(state.created.length, 100, "no account for the 101st");
  assert.equal(state.mailed, 100, "and no welcome email");
  // Keyed on the first forwarded hop only, under its own kind.
  assert.deepEqual([...state.counts.keys()], ["signup:ip:203.0.113.9"]);
  // Logged at warn, without the address that was typed.
  assert.equal(state.warned.length, 1);
  assert.ok(!JSON.stringify(state.warned).includes("student101"));
});

test("another network isn't held to the first one's count", async () => {
  reset({ "x-forwarded-for": "203.0.113.9" });
  for (let i = 1; i <= 101; i++) await signUpAction(person(i));
  assert.equal(state.created.length, 100);
  state.headers = { "x-forwarded-for": "198.51.100.4" };
  assert.deepEqual(await signUpAction(person(200)), { ok: true });
  // Behind a proxy that only sets x-real-ip, that address is the key.
  state.headers = { "x-real-ip": "192.0.2.7" };
  assert.deepEqual(await signUpAction(person(201)), { ok: true });
  assert.ok(state.counts.has("signup:ip:192.0.2.7"));
});

test("a typo is refused before it counts against the network", async () => {
  reset({ "x-forwarded-for": "203.0.113.9" });
  const res = await signUpAction({ ...person(1), password: "short" });
  assert.equal(res.ok, false);
  assert.equal(state.counts.size, 0);
});

test("the limit fails open: a limiter outage doesn't lock anyone out of signing up", async () => {
  reset({ "x-forwarded-for": "203.0.113.9" });
  state.limiterDown = true;
  assert.deepEqual(await signUpAction(person(1)), { ok: true });
  assert.deepEqual(state.created, ["student1@school.edu"]);
});

test("clientIpFrom: the first forwarded hop, else x-real-ip, else 'unknown'", () => {
  assert.equal(clientIpFrom(new Headers({ "x-forwarded-for": " 203.0.113.9 , 10.0.0.1" })), "203.0.113.9");
  assert.equal(clientIpFrom(new Headers({ "x-forwarded-for": "", "x-real-ip": "192.0.2.7" })), "192.0.2.7");
  assert.equal(clientIpFrom(new Headers({ "x-forwarded-for": " ,10.0.0.1", "x-real-ip": "192.0.2.7" })), "192.0.2.7");
  assert.equal(clientIpFrom(new Headers()), "unknown");
});
