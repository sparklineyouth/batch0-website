import { test } from "node:test";
import assert from "node:assert/strict";
import { stopPaging } from "./email/paging.ts";

// Run with `npm test`.
//
// This predicate decides how much of the delivery funnel the metrics page gets
// to see. Stopping too late costs a few HTTP requests; stopping too early
// truncates the funnel and the page under-reports while looking perfectly
// healthy. The asymmetry is the whole point of testing it.

const S = (o: Partial<Parameters<typeof stopPaging>[0]>) =>
  stopPaging({
    hasMore: true,
    batchSize: 100,
    seenInWindow: 0,
    inWindowThisPage: 0,
    ...o,
  });

test("stops when the API says there is nothing after this page", () => {
  assert.equal(S({ hasMore: false, inWindowThisPage: 100, seenInWindow: 100 }), true);
});

test("stops on an empty page", () => {
  assert.equal(S({ batchSize: 0 }), true);
});

test("keeps paging while pages are still landing inside the window", () => {
  assert.equal(S({ seenInWindow: 100, inWindowThisPage: 100 }), false);
  // The boundary page: partly inside, partly older. There may be more of the
  // window on the next page, so it must not stop here.
  assert.equal(S({ seenInWindow: 140, inWindowThisPage: 40 }), false);
});

test("stops on the first page past the window — newest-first ordering", () => {
  assert.equal(S({ seenInWindow: 140, inWindowThisPage: 0 }), true);
});

test("does NOT stop on old pages before the window is reached", () => {
  // If the endpoint ever returned oldest-first, the leading pages are all
  // outside the window. Stopping there would return an empty funnel and no
  // error — the failure this guard exists to prevent.
  assert.equal(S({ seenInWindow: 0, inWindowThisPage: 0 }), false);
  assert.equal(S({ seenInWindow: 0, inWindowThisPage: 0, batchSize: 100 }), false);
});

test("an account whose entire history predates the window still terminates", () => {
  // It never enters the window, so the early exit never fires — termination is
  // the page cap's job, and `has_more: false` ends it before that on a small
  // account. Neither of those is a stop the predicate can make.
  assert.equal(S({ seenInWindow: 0, inWindowThisPage: 0, hasMore: true }), false);
  assert.equal(S({ seenInWindow: 0, inWindowThisPage: 0, hasMore: false }), true);
});
