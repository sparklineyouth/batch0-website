import test from "node:test";
import assert from "node:assert/strict";
import { legacyPathOk } from "./legacy-upload-path.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

test("legacyPathOk: only paths inside the owner's folder", () => {
  assert.equal(legacyPathOk(`${OWNER}/drive/deck-1700000000000.pdf`, OWNER), true);
  assert.equal(legacyPathOk(`${OWNER}/pitch/video.mp4`, OWNER), true);
  for (const bad of [
    null,
    undefined,
    "",
    OWNER, // the folder itself
    `${OWNER}/`,
    `${OTHER}/drive/x.pdf`, // someone else's
    `${OWNER}x/drive/x.pdf`, // prefix look-alike
    `x/${OWNER}/drive/x.pdf`,
    `${OWNER}/../${OTHER}/drive/x.pdf`, // traversal
    `${OWNER}/drive/..`,
    `${OWNER}//drive/x.pdf`,
    `${OWNER}/drive\\x.pdf`,
  ]) {
    assert.equal(legacyPathOk(bad as any, OWNER), false, String(bad));
  }
  assert.equal(legacyPathOk("/drive/x.pdf", ""), false);
});
