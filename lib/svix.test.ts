import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  verifySvixSignature,
  svixSign,
  isFreshTimestamp,
  SVIX_TOLERANCE_SECONDS,
} from "./svix.ts";

// Run with `npm test`.
//
// This is the check standing between the open internet and a service-role
// INSERT into `email_events`, so it is tested against signatures built the way
// Svix builds them — independently of the implementation — rather than against
// its own output.

const SECRET = "whsec_" + Buffer.from("a-test-signing-key-32-bytes-long").toString("base64");
const ID = "msg_2abc";
const TS = "1756684800";
const BODY = JSON.stringify({ type: "email.delivered", data: { email_id: "e1" } });

/** Sign the way a sender does, from the spec — not by calling svixSign. */
function signIndependently(secret: string, id: string, ts: string, body: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return crypto
    .createHmac("sha256", key)
    .update(`${id}.${ts}.${body}`)
    .digest("base64");
}

const now = Number(TS) * 1000;

test("accepts a correctly signed request", () => {
  const sig = signIndependently(SECRET, ID, TS, BODY);
  assert.ok(
    verifySvixSignature({
      secret: SECRET,
      headers: { id: ID, timestamp: TS, signature: `v1,${sig}` },
      rawBody: BODY,
    }),
  );
});

test("our own signer agrees with the spec construction", () => {
  assert.equal(svixSign(SECRET, { id: ID, timestamp: TS }, BODY), signIndependently(SECRET, ID, TS, BODY));
});

test("the secret is base64-decoded, not used as a raw string", () => {
  // Signing with the literal string instead of its decoded bytes is the
  // classic implementation bug; it must NOT verify.
  const wrong = crypto
    .createHmac("sha256", SECRET.replace(/^whsec_/, ""))
    .update(`${ID}.${TS}.${BODY}`)
    .digest("base64");
  assert.ok(
    !verifySvixSignature({
      secret: SECRET,
      headers: { id: ID, timestamp: TS, signature: `v1,${wrong}` },
      rawBody: BODY,
    }),
  );
});

test("rejects a tampered body", () => {
  const sig = signIndependently(SECRET, ID, TS, BODY);
  assert.ok(
    !verifySvixSignature({
      secret: SECRET,
      headers: { id: ID, timestamp: TS, signature: `v1,${sig}` },
      rawBody: BODY.replace("delivered", "bounced"),
    }),
  );
});

test("rejects a signature bound to a different message id or timestamp", () => {
  const sig = signIndependently(SECRET, ID, TS, BODY);
  for (const headers of [
    { id: "msg_other", timestamp: TS, signature: `v1,${sig}` },
    { id: ID, timestamp: "1756684801", signature: `v1,${sig}` },
  ]) {
    assert.ok(!verifySvixSignature({ secret: SECRET, headers, rawBody: BODY }));
  }
});

test("rejects the wrong secret", () => {
  const other = "whsec_" + Buffer.from("a-different-key-of-the-same-size").toString("base64");
  const sig = signIndependently(other, ID, TS, BODY);
  assert.ok(
    !verifySvixSignature({
      secret: SECRET,
      headers: { id: ID, timestamp: TS, signature: `v1,${sig}` },
      rawBody: BODY,
    }),
  );
});

test("accepts when any of several signatures matches — secret rotation", () => {
  // During a rotation Svix sends one signature per active secret. A receiver
  // that only checks the first would break for the length of the rotation.
  const good = signIndependently(SECRET, ID, TS, BODY);
  const stale = signIndependently(
    "whsec_" + Buffer.from("an-old-rotated-out-key-32-bytes!").toString("base64"),
    ID, TS, BODY,
  );
  assert.ok(
    verifySvixSignature({
      secret: SECRET,
      headers: { id: ID, timestamp: TS, signature: `v1,${stale} v1,${good}` },
      rawBody: BODY,
    }),
  );
});

test("ignores signature versions it doesn't implement", () => {
  const sig = signIndependently(SECRET, ID, TS, BODY);
  assert.ok(
    !verifySvixSignature({
      secret: SECRET,
      headers: { id: ID, timestamp: TS, signature: `v2,${sig}` },
      rawBody: BODY,
    }),
  );
});

test("survives malformed signature headers instead of throwing", () => {
  for (const signature of ["", "garbage", "v1,", ",", "v1", "v1,!!!not-base64!!!"]) {
    assert.doesNotThrow(() =>
      verifySvixSignature({
        secret: SECRET,
        headers: { id: ID, timestamp: TS, signature },
        rawBody: BODY,
      }),
    );
    assert.ok(
      !verifySvixSignature({
        secret: SECRET,
        headers: { id: ID, timestamp: TS, signature },
        rawBody: BODY,
      }),
    );
  }
});

test("timestamp window bounds replay in both directions", () => {
  assert.ok(isFreshTimestamp(TS, now));
  assert.ok(isFreshTimestamp(String(Number(TS) - SVIX_TOLERANCE_SECONDS + 1), now));
  assert.ok(!isFreshTimestamp(String(Number(TS) - SVIX_TOLERANCE_SECONDS - 1), now));
  // A future timestamp is just as suspicious as an old one.
  assert.ok(!isFreshTimestamp(String(Number(TS) + SVIX_TOLERANCE_SECONDS + 1), now));
  assert.ok(!isFreshTimestamp("not-a-number", now));
  assert.ok(!isFreshTimestamp("", now));
});
