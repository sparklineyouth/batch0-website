import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KEEPALIVE_MAX_BYTES,
  draftEndpoint,
  loadDraftOverHttp,
  saveDraftOverHttp,
} from "./assignment-drafts-client.ts";

// Run with `npm test`. The browser half of app/api/assignments/[id]/draft.

const ID = "b0000000-0000-4000-8000-000000000001";

function fakeFetch(answer: () => Promise<Response> | Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = ((url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return Promise.resolve().then(answer);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a save is a keepalive POST, sent before the call returns", async () => {
  const f = fakeFetch(() => json(200, { ok: true, version: 2, savedAt: "2026-10-17T15:00:00Z" }));
  const pending = saveDraftOverHttp({ assignmentId: ID, body: "half a thought", linkUrl: null, baseVersion: 1 }, f.impl);
  // Already on the wire: a save started from pagehide / beforeunload can't
  // wait for a microtask the closing page may never run.
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, draftEndpoint(ID));
  assert.equal(f.calls[0].url, `/api/assignments/${ID}/draft`);
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.keepalive, true);
  assert.equal(f.calls[0].init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(f.calls[0].init.body as string), { body: "half a thought", linkUrl: null, baseVersion: 1 });
  assert.deepEqual(await pending, { ok: true, version: 2, savedAt: "2026-10-17T15:00:00Z" });
});

test("a body too big for the keepalive budget goes as an ordinary request", async () => {
  const f = fakeFetch(() => json(200, { ok: true, version: 1, savedAt: "T" }));
  // 10,000 three-byte characters plus JSON: ~30 KB, still keepalive.
  await saveDraftOverHttp({ assignmentId: ID, body: "語".repeat(10000), linkUrl: null, baseVersion: 0 }, f.impl);
  assert.equal(f.calls[0].init.keepalive, true);
  await saveDraftOverHttp({ assignmentId: ID, body: "語".repeat(KEEPALIVE_MAX_BYTES / 3 + 10), linkUrl: null, baseVersion: 0 }, f.impl);
  assert.equal(f.calls[1].init.keepalive, false);
});

test("signed out is a 401; an outage or a proxy page is a retryable error; a dropped connection rejects", async () => {
  const save = (f: ReturnType<typeof fakeFetch>) =>
    saveDraftOverHttp({ assignmentId: ID, body: "x", linkUrl: null, baseVersion: 0 }, f.impl);
  assert.deepEqual(await save(fakeFetch(() => json(401, { ok: false, reason: "signed_out" }))), { ok: false, reason: "signed_out" });
  assert.deepEqual(await save(fakeFetch(() => json(503, { ok: false, reason: "error" }))), { ok: false, reason: "error" });
  assert.deepEqual(await save(fakeFetch(() => new Response("<html>504</html>", { status: 504 }))), { ok: false, reason: "error" });
  assert.deepEqual(await save(fakeFetch(() => json(200, { ok: false, reason: "stale", version: 7 }))), { ok: false, reason: "stale", version: 7 });
  await assert.rejects(save(fakeFetch(() => Promise.reject(new TypeError("Failed to fetch")))), /Failed to fetch/);
});

test("reading the draft back: the state, or null when it can't be read", async () => {
  const draft = { body: "b", link_url: null, version: 3, updated_at: "T", cleared_at: null };
  const ok = fakeFetch(() => json(200, { state: "ready", draft, submission: null }));
  assert.deepEqual(await loadDraftOverHttp(ID, ok.impl), { state: "ready", draft, submission: null });
  assert.equal(ok.calls[0].init.cache, "no-store");
  assert.equal(ok.calls[0].init.method, undefined);
  assert.deepEqual(await loadDraftOverHttp(ID, fakeFetch(() => json(200, { state: "not_ready" })).impl), { state: "not_ready" });
  assert.equal(await loadDraftOverHttp(ID, fakeFetch(() => json(401, { error: "signed_out" })).impl), null);
  assert.equal(await loadDraftOverHttp(ID, fakeFetch(() => Promise.reject(new TypeError("offline"))).impl), null);
});
