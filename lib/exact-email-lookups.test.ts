import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Run with `npm test`. Looking an account up by a typed email address must
// find that address and nobody else's. To PostgREST's ilike `%`, `_` and `*`
// are wildcards, and all three are legal in an address: a Demo Day guest
// ticket for "%@gmail.com" was linked to whichever gmail account the pattern
// hit first (findProfileByEmail, lib/demo-day-tickets.ts — the admin's ticket
// form, Stripe fulfilment and the scholarship guest tickets all share it).
// Then: a sweep, so a new by-email lookup can't pass a raw address to ilike.

type Profile = { id: string; email: string; full_name: string | null };
const state = { profiles: [] as Profile[] };

/** ILIKE as PostgREST hands it over: `*` is `%`, a backslash makes the next character literal. */
function ilike(value: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (c === "%" || c === "*") re += ".*";
    else if (c === "_") re += ".";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(value);
}

const db = {
  from(table: string) {
    assert.equal(table, "profiles");
    const filters: ((r: Profile) => boolean)[] = [];
    let max = Infinity;
    const chain: any = {
      select: () => chain,
      eq: (k: keyof Profile, v: string) => (filters.push((r) => r[k] === v), chain),
      ilike: (k: keyof Profile, v: string) => (filters.push((r) => ilike(String(r[k]), v)), chain),
      limit: (n: number) => ((max = n), chain),
      maybeSingle: () => {
        throw new Error("a by-email lookup reads a list (limit 2), never maybeSingle");
      },
      then: (ok: any, no: any) =>
        Promise.resolve()
          .then(() => ({
            data: state.profiles.filter((r) => filters.every((f) => f(r))).slice(0, max).map(({ id, full_name }) => ({ id, full_name })),
            error: null,
          }))
          .then(ok, no),
    };
    return chain;
  },
};
(globalThis as any).__emailLookupTest = { db };

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__emailLookupTest;";
    const doubles: Record<string, string> = {
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
      "@/lib/env": "export const env={siteUrl:'https://batch0.org'};",
      "@/lib/email/dispatch": "export const sendTemplated=async()=>({ok:true});",
      "@/lib/email/templates": "export const Templates={};",
      "@/lib/site-config": "export const getSiteConfig=async()=>({});",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) {
      return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    }
    return next(specifier, context);
  },
});
const { findProfileByEmail } = await import("./demo-day-tickets.ts");

test("findProfileByEmail: a LIKE pattern in the address finds nobody", async () => {
  state.profiles = [
    { id: "alex", email: "alex@gmail.com", full_name: "Alex" },
    { id: "abc", email: "abc@school.edu", full_name: "Abc" },
  ];
  for (const typed of ["%@gmail.com", "a_c@school.edu", "*@gmail.com", "a%"]) {
    assert.equal(await findProfileByEmail(typed), null, typed);
  }
});

test("findProfileByEmail: the address itself still matches, whatever its case", async () => {
  state.profiles = [
    { id: "alex", email: "alex@gmail.com", full_name: "Alex" },
    { id: "und", email: "jo_n@school.edu", full_name: "Jo N" },
  ];
  assert.deepEqual(await findProfileByEmail("Alex@Gmail.com"), { id: "alex", full_name: "Alex" });
  assert.deepEqual(await findProfileByEmail(" jo_n@school.edu "), { id: "und", full_name: "Jo N" });
  // An address with a `*` (no escape for it in PostgREST) is matched exactly.
  state.profiles.push({ id: "star", email: "a*b@school.edu", full_name: null });
  assert.deepEqual(await findProfileByEmail("a*b@school.edu"), { id: "star", full_name: null });
  assert.equal(await findProfileByEmail("not-an-address"), null);
});

test("findProfileByEmail: two accounts that differ only by case link neither", async () => {
  state.profiles = [
    { id: "a1", email: "ada@school.edu", full_name: "Ada" },
    { id: "a2", email: "Ada@School.edu", full_name: "Ada 2" },
  ];
  assert.equal(await findProfileByEmail("ada@school.edu"), null);
});

/** Every .ts/.tsx file under these folders, as [path, source]. */
function sources(...dirs: string[]): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push([path.relative(root, full), readFileSync(full, "utf8")]);
    }
  };
  for (const d of dirs) walk(path.join(root, d));
  return out;
}

test("sweep: no by-email lookup hands ilike an address it hasn't escaped", () => {
  // `.ilike("email", x)` (or any *email column) is only allowed with the
  // escaped value exactEmailLookup returns, or an inline escape of `\ % _`.
  // A pattern spelled out as a substring search (`%${q}%`, an admin filter
  // box) is a search on purpose, not a lookup, and is left alone.
  const offenders: string[] = [];
  for (const [file, src] of sources("app", "lib", "components")) {
    for (const m of src.matchAll(/\.ilike\(\s*"(\w*email\w*)"\s*,\s*([^)]*\)?)/g)) {
      const arg = m[2].trim();
      if (/^lookup\.value\b/.test(arg) || /replace\(\/\[\\\\%_\]\/g/.test(arg)) continue;
      if (/^`[%*]\$\{\w+\}[%*]`/.test(arg)) continue;
      offenders.push(`${file}: .ilike("${m[1]}", ${arg})`);
    }
  }
  assert.deepEqual(offenders, []);
  // The two lookups this sweep was written for go through the shared one.
  assert.match(readFileSync(path.join(root, "lib/scholarships.ts"), "utf8"), /await findProfileByEmail\(email\)/);
  assert.match(readFileSync(path.join(root, "app/admin/roles/actions.ts"), "utf8"), /exactEmailLookup\(clean\)/);
});
