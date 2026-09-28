import { test } from "node:test";
import assert from "node:assert/strict";
import { isRetryableUploadError, withUploadRetry } from "./upload-retry.ts";

// Run with `npm test`.

const noSleep = async () => {};

test("a dropped connection (no status), a 5xx, 408 and 429 are worth another try", () => {
  assert.equal(isRetryableUploadError(new TypeError("Failed to fetch")), true);
  assert.equal(isRetryableUploadError({ status: 503 }), true);
  assert.equal(isRetryableUploadError({ statusCode: "500" }), true);
  assert.equal(isRetryableUploadError({ status: 408 }), true);
  assert.equal(isRetryableUploadError({ status: 429 }), true);
});

test("any other 4xx is final: a rejected file fails the same way every time", () => {
  for (const status of [400, 401, 403, 404, 409, 413]) {
    assert.equal(isRetryableUploadError({ status }), false, String(status));
  }
});

test("a blip is retried until the upload goes through", async () => {
  let calls = 0;
  const result = await withUploadRetry(
    async () => {
      calls++;
      if (calls < 3) throw new TypeError("Failed to fetch");
      return "saved";
    },
    { sleep: noSleep },
  );
  assert.equal(result, "saved");
  assert.equal(calls, 3);
});

test("it gives up after the last delay and surfaces the error", async () => {
  let calls = 0;
  const waited: number[] = [];
  await assert.rejects(
    withUploadRetry(
      async () => {
        calls++;
        throw { status: 502 };
      },
      { delaysMs: [10, 20], sleep: async (ms) => void waited.push(ms) },
    ),
  );
  assert.equal(calls, 3);
  assert.deepEqual(waited, [10, 20]);
});

test("a final error is not retried at all", async () => {
  let calls = 0;
  await assert.rejects(
    withUploadRetry(
      async () => {
        calls++;
        throw { status: 403 };
      },
      { sleep: noSleep },
    ),
  );
  assert.equal(calls, 1);
});
