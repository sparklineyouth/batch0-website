import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { readFileSync } from "node:fs";

// Run with `npm test`. The public team page (/teams/[slug]) matches the slug
// with ilike, so an old mixed-case link still opens; to ilike the `%`, `_`
// and `*` a URL can carry are wildcards, and /teams/____ opened whichever
// team the pattern hit. isTeamSlug (lib/team.ts) turns those away first.

(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    if (specifier === "@/lib/supabase/admin") {
      return { url: "data:text/javascript,export const createAdminClient=()=>null;", shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { isTeamSlug, slugify } = await import("./team.ts");

test("every slug slugify() makes is a team slug", () => {
  for (const name of ["Rocket Labs", "  café & co ", "A".repeat(80), "x", "Team 7 — Demo Day!"]) {
    const slug = slugify(name);
    assert.ok(isTeamSlug(slug), slug);
    // reserveTeamSlug's suffixes too.
    assert.ok(isTeamSlug(`${slug}-19`), `${slug}-19`);
    assert.ok(isTeamSlug(`${slug}-${Date.now().toString(36)}`));
  }
  // An old link typed in capitals still opens the team.
  assert.ok(isTeamSlug("Rocket-Labs"));
});

test("a LIKE pattern, or anything else no slug can be, is no team", () => {
  for (const bad of ["____", "%", "rocket%", "r_cket", "*", "rocket labs", "", "rocket/labs", "a".repeat(65), "%25"]) {
    assert.equal(isTeamSlug(bad), false, bad);
  }
});

test("the team page checks the slug before it looks it up", () => {
  const src = readFileSync(new URL("../app/teams/[slug]/page.tsx", import.meta.url), "utf8");
  const check = src.indexOf("if (!isTeamSlug(slug)) return null;");
  const lookup = src.indexOf('.ilike("slug", slug)');
  assert.ok(check > 0 && lookup > check, "isTeamSlug guards the ilike lookup");
});
