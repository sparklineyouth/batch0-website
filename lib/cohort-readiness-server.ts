import "server-only";

/**
 * The readiness loader, for server code. It lives in
 * lib/cohort-readiness-load.ts, which takes the admin client as an argument
 * and imports nothing server-side, so its tests run under `node --test`;
 * importing it through here keeps it out of client bundles all the same.
 */
export { loadCohortReadiness, type ReadinessCohortRow } from "./cohort-readiness-load.ts";
