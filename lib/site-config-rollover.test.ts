import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const fallId = "6350c6ac-70f0-4f53-93d5-c99e397185a9";
const winterId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const state: any = {
  cached: null, reads: 0,
  cohorts: [
    { id: fallId, name: "Fall 2026", cohort_number: 1, status: "active", starts_on: "2026-09-14", ends_on: "2026-11-13", applications_close_at: "2026-09-30T23:59:59.999-04:00", late_entry_until: "2026-09-30T23:59:59.999-04:00", catch_up_plan: "Review Week 1 with the team.", capacity: 24, price_cents: 13000, enrollments: [{ count: 2 }] },
    { id: winterId, name: "Winter 2026", cohort_number: 2, status: "upcoming", starts_on: "2026-12-14", ends_on: "2027-02-12", applications_close_at: "2026-12-13T23:59:59.999-05:00", capacity: 24, price_cents: 15099, enrollments: [{ count: 0 }] },
  ],
};
const db = {
  from(table: string) {
    let id: string | null = null;
    const result = () => {
      state.reads++;
      if (table === "site_settings") return { data: [{ key: "active_cohort_id", value: fallId }, { key: "applications_open", value: true }, { key: "promo_enabled", value: false }], error: null };
      if (table === "cohorts") return { data: id ? state.cohorts.find((c: any) => c.id === id) : state.cohorts, error: null };
      throw Error(`Unexpected table ${table}`);
    };
    const chain: any = { then(resolve: any, reject: any) { return Promise.resolve().then(result).then(resolve, reject); } };
    for (const method of ["select", "in", "order", "maybeSingle"]) chain[method] = () => chain;
    chain.eq = (_key: string, value: string) => { id = value; return chain; };
    return chain;
  },
};
(globalThis as any).__rolloverSite = { state, db };
const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const hook = (nodeModule as any).registerHooks({ resolve(specifier: string, context: any, next: any) {
  const doubles: Record<string, string> = {
    "react": "export const cache=fn=>fn;",
    "next/cache": "export const unstable_cache=fn=>async()=>globalThis.__rolloverSite.state.cached??=(await fn());",
    "@/lib/supabase/admin": "export const createAdminClient=()=>globalThis.__rolloverSite.db; export const createPublicReadClient=createAdminClient;",
  };
  if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
  if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
  return next(specifier, context);
} });
const { getPublicSiteConfig, getPublicCohortConfig } = await import("./site-config.ts");

test("cached public facts select Winter exactly at Eastern midnight without waiting for a new database read", async t => {
  state.cached = null; state.reads = 0;
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-01T03:59:59.999Z") });
  const fall = await getPublicSiteConfig();
  assert.equal(fall.cohort?.id, fallId);
  assert.equal(fall.derived.applicationsAvailable, true);
  const reads = state.reads;
  t.mock.timers.setTime(Date.parse("2026-10-01T04:00:00Z"));
  const winter = await getPublicSiteConfig();
  assert.equal(winter.cohort?.id, winterId);
  assert.equal(winter.derived.applicationsAvailable, true);
  assert.equal(winter.derived.priceLabel, "$150.99");
  assert.equal(state.reads, reads, "cached facts are reused, not a cached choice");
  const explicitFall = await getPublicCohortConfig(fallId);
  assert.equal(explicitFall.cohort?.id, fallId, "a parent's Fall link must not change programs underneath them");
  assert.equal(explicitFall.derived.applicationsAvailable, false);
  assert.equal(explicitFall.derived.applicationLabel, "View available cohorts");
});

test.after(() => { hook.deregister(); delete (globalThis as any).__rolloverSite; });
