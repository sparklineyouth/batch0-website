import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { HONEYPOT_MESSAGE, honeypotTripped } from "./honeypot.ts";

// Run with `npm test`. The signup form's honeypot, then the real signUpAction
// against doubles: a filled trap must create nothing and send nothing.

test("only a non-blank value trips it", () => {
  assert.equal(honeypotTripped("https://spam.example"), true);
  assert.equal(honeypotTripped("x"), true);
  assert.equal(honeypotTripped(""), false);
  assert.equal(honeypotTripped("   "), false);
  assert.equal(honeypotTripped(undefined), false);
  assert.equal(honeypotTripped(null), false);
});

const state = { created: [] as string[], mailed: 0, warned: [] as unknown[][] };
(globalThis as any).__honeypotTest = state;
console.warn = (...args: unknown[]) => void state.warned.push(args);
const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__honeypotTest;";
    const doubles: Record<string, string> = {
      "@/lib/supabase/admin":
        g + "export const createAdminClient=()=>({auth:{admin:{createUser:async a=>{t.created.push(a.email);return{data:{user:{id:'u1',email:a.email}},error:null};}}}});",
      "@/lib/email/send": "export const sendEmail=async()=>{};",
      "@/lib/email/templates": "export const Templates={welcome:()=>({subject:'',html:''})};",
      "@/lib/email/dispatch": g + "export const sendTemplated=async()=>{t.mailed++;};export const emitEmailEvent=async()=>{};",
      "@/lib/notifications": "export const notify=async()=>{};",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) {
      return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    }
    return next(specifier, context);
  },
});
const { signUpAction } = await import("../app/(auth)/signup/actions.ts");

const person = { email: "Ada@School.edu", password: "correct-horse-9", fullName: "Ada" };

test("a filled trap creates no account and sends no email", async () => {
  state.created.length = 0;
  state.mailed = 0;
  state.warned.length = 0;
  const result = await signUpAction({ ...person, trap: "http://cheap-pills.example" });
  assert.deepEqual(result, { ok: false, error: HONEYPOT_MESSAGE });
  assert.deepEqual(state.created, []);
  assert.equal(state.mailed, 0);
  assert.equal(state.warned.length, 1);
  assert.ok(!JSON.stringify(state.warned).includes("ada@school.edu"), "the typed address isn't logged");
});

test("an empty trap signs a person up exactly as before", async () => {
  state.created.length = 0;
  state.mailed = 0;
  const result = await signUpAction({ ...person, trap: "" });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(state.created, ["ada@school.edu"]);
  assert.equal(state.mailed, 1);
  // A caller that predates the field (no `trap` at all) isn't refused either.
  assert.deepEqual(await signUpAction(person), { ok: true });
});
