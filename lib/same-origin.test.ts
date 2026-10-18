import { test } from "node:test";
import assert from "node:assert/strict";
import { sameOrigin } from "./same-origin.ts";

// Run with `npm test`.

const req = (headers: Record<string, string>, url = "https://app.batch0.org/api/assignments/x/draft") =>
  new Request(url, { method: "POST", headers });

test("same-origin writes only: Origin when sent, else Fetch Metadata, else refused", () => {
  assert.equal(sameOrigin(req({ origin: "https://app.batch0.org" })), true);
  // Behind the proxy the request URL may name the deployment; Host is public.
  assert.equal(
    sameOrigin(req({ origin: "https://batch0.org", host: "batch0.org" }, "https://batch0-abc.vercel.app/api/x")),
    true,
  );
  assert.equal(sameOrigin(req({ origin: "https://evil.example" })), false);
  assert.equal(sameOrigin(req({ origin: "null" })), false);
  // A keepalive request or beacon may leave Origin off.
  assert.equal(sameOrigin(req({ "sec-fetch-site": "same-origin" })), true);
  assert.equal(sameOrigin(req({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(sameOrigin(req({})), false);
});
