import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { eventVisibilityScopes, recordingOrFilter } from "./event-history.ts";

// The installed app's event reads (lib/app-cache.ts), run for real against
// recording stand-ins for the two Supabase clients: which client each read
// uses and which visibility filter it applies itself. Students read through
// the service role, cached, scoped to their enrolled cohorts; staff
// previewing read through their own session so the `events read` policy
// decides — they hold no enrollments, so the student scope showed them public
// events only.

type Call = { client: "admin" | "viewer"; ops: [string, any[]][] };
const calls: Call[] = [];

function client(name: "admin" | "viewer") {
  return {
    from(table: string) {
      const call: Call = { client: name, ops: [["from", [table]]] };
      calls.push(call);
      const chain: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              return (ok: any, bad: any) => Promise.resolve({ data: [], error: null }).then(ok, bad);
            }
            return (...args: any[]) => {
              call.ops.push([prop, args]);
              return chain;
            };
          },
        },
      );
      return chain;
    },
  };
}
(globalThis as any).__appCache = { admin: client("admin"), viewer: client("viewer") };

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__appCache;";
    const doubles: Record<string, string> = {
      "next/cache": "export const unstable_cache=(fn)=>fn;",
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.admin;",
      "@/lib/supabase/server": g + "export const createClient=async()=>t.viewer;",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    return next(specifier, context);
  },
});
const { getCohortEvents, getCohortRecordings, getPreviewEvents, getPreviewRecordings } = await import("./app-cache.ts");

const A = "0c0c0c0c-0000-4000-8000-00000000000a";
const NOW = "2026-10-17T16:00:00.000Z";
const last = () => calls[calls.length - 1];
const op = (c: Call, name: string) => c.ops.filter(([m]) => m === name).map(([, a]) => a);

test("a student's calendar: service role, scoped to their enrolled cohorts by the query itself", async () => {
  await getCohortEvents({ cohortIds: [A] }, NOW);
  const [pub, enrolled] = eventVisibilityScopes([A]);
  assert.equal(last().client, "admin");
  assert.deepEqual(op(last(), "or"), [[`${pub},and(${enrolled})`]]);

  await getCohortEvents({ cohortIds: [] }, NOW);
  assert.equal(last().client, "admin");
  assert.deepEqual(op(last(), "eq"), [["visibility", "public"]], "no enrollments: public events only");

  await getCohortRecordings({ cohortIds: [A] }, NOW, 2);
  assert.equal(last().client, "admin");
  assert.deepEqual(op(last(), "or"), [[recordingOrFilter(eventVisibilityScopes([A]))]]);
  assert.deepEqual(op(last(), "range"), [[10, 20]]);
});

test("a staff preview: the viewer's own session, and no visibility filter of its own — RLS decides", async () => {
  await getPreviewEvents(NOW);
  assert.equal(last().client, "viewer");
  assert.deepEqual(op(last(), "or"), []);
  assert.deepEqual(op(last(), "eq"), [], "not narrowed to public: the policy shows staff every event");
  assert.deepEqual(op(last(), "gte"), [["starts_at", "2026-10-16T16:00:00.000Z"]], "the same day of lookback");
  assert.deepEqual(op(last(), "limit"), [[20]]);

  await getPreviewRecordings(NOW, 1);
  assert.equal(last().client, "viewer");
  assert.deepEqual(op(last(), "or"), [[recordingOrFilter([])]], "the recording kinds only");
  assert.deepEqual(op(last(), "lt"), [["starts_at", NOW]]);
  assert.deepEqual(op(last(), "range"), [[0, 10]]);
});

test("only staff take the preview path, on both app screens", () => {
  const events = readFileSync(path.join(root, "app/app/(student)/events/page.tsx"), "utf8");
  assert.match(events, /const scope = access\.staff \? null : \{ cohortIds: await enrolledCohortIds\(\) \};/);
  assert.match(events, /scope \? getCohortRecordings\(scope, nowIso, page\) : getPreviewRecordings\(nowIso, page\)/);
  const home = readFileSync(path.join(root, "app/app/(student)/home/page.tsx"), "utf8");
  assert.match(home, /access\.staff\s*\?\s*getPreviewEvents\(nowIso\)\s*:\s*getCohortEvents\(\{ cohortIds: eventCohorts \}, nowIso\)/);
  // And the preview reads are never cached: unstable_cache can't see the
  // session, and a staff entry must never answer a student.
  const cache = readFileSync(path.join(root, "lib/app-cache.ts"), "utf8");
  for (const fn of ["getPreviewEvents", "getPreviewRecordings"]) {
    const body = cache.slice(cache.indexOf(`export async function ${fn}`));
    const end = body.indexOf("\n}\n");
    assert.ok(!body.slice(0, end).includes("unstable_cache"), `${fn} is uncached`);
    assert.ok(body.slice(0, end).includes("await createClient()"), `${fn} reads as the viewer`);
  }
});
