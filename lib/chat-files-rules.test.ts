import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTACHMENT_ACCEPT,
  CHAT_MAX_FILES,
  chatFileHref,
  chatUploadPath,
  isInlineImage,
  mayAttachPath,
  parseChatUploadPath,
  parseStagedChatFiles,
} from "./chat-files-rules.ts";

const CH = "1a1a1a1a-1111-4111-8111-11111111111f";
const OTHER_CH = "22222222-2222-4222-8222-222222222222";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const YOU = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OBJ = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OBJ2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const mine = (name = "shot.png", obj = OBJ) => chatUploadPath(CH, ME, obj, name);

test("chatUploadPath builds <channel>/<uploader>/<uuid>-<safe name>, lowercased, and parses back", () => {
  const path = chatUploadPath(CH.toUpperCase(), ME.toUpperCase(), OBJ.toUpperCase(), "My Screen Shot.PNG");
  assert.equal(path, `${CH}/${ME}/${OBJ}-my-screen-shot.png`);
  assert.deepEqual(parseChatUploadPath(path), { channelId: CH, userId: ME });
});

test("file names can't steer the path: separators, traversal and double extensions are flattened", () => {
  assert.equal(chatUploadPath(CH, ME, OBJ, "../../etc/passwd.png"), `${CH}/${ME}/${OBJ}-passwd.png`);
  assert.equal(chatUploadPath(CH, ME, OBJ, "x.html.png"), `${CH}/${ME}/${OBJ}-x-html.png`);
  assert.equal(chatUploadPath(CH, ME, OBJ, ".png"), `${CH}/${ME}/${OBJ}-png`);
});

test("parseChatUploadPath refuses anything that isn't a path we minted", () => {
  for (const bad of [
    undefined,
    null,
    42,
    "",
    `${CH}/${ME}`,
    `${CH}/${ME}/${OBJ}`,
    `${CH}/${ME}/${OBJ}-`,
    `${CH}/${ME}/${OBJ}-.png`,
    `${CH}/${ME}/${OBJ}-a/b.png`,
    `${CH}/${ME}/../${OBJ}-a.png`,
    `/${CH}/${ME}/${OBJ}-a.png`,
    `${CH}/${ME}/${OBJ}-a.png/`,
    `x${CH}/${ME}/${OBJ}-a.png`,
    `${CH.toUpperCase()}/${ME}/${OBJ}-a.png`,
    `${CH}/${ME.toUpperCase()}/${OBJ}-a.png`,
    `${CH}/${ME}/${OBJ}-A.png`,
    `${CH}/${ME}/${OBJ}-${"a".repeat(101)}`,
    `${CH}/${ME}/${OBJ}-a.png${"x".repeat(600)}`,
  ]) {
    assert.equal(parseChatUploadPath(bad), null, String(bad));
  }
});

test("mayAttachPath only lets the uploader attach in the channel the file was staged for", () => {
  const path = mine();
  assert.equal(mayAttachPath(path, CH, ME), true);
  assert.equal(mayAttachPath(path, CH.toUpperCase(), ME.toUpperCase()), true);
  assert.equal(mayAttachPath(path, OTHER_CH, ME), false, "staged in another channel (a DM) can't land in this one");
  assert.equal(mayAttachPath(path, CH, YOU), false, "someone else's upload");
  assert.equal(mayAttachPath(chatUploadPath(OTHER_CH, ME, OBJ, "a.png"), CH, ME), false);
  assert.equal(mayAttachPath("not a path", CH, ME), false);
});

test("parseStagedChatFiles: nothing is fine, garbage is refused", () => {
  assert.deepEqual(parseStagedChatFiles(undefined, CH, ME), { ok: true, files: [] });
  assert.deepEqual(parseStagedChatFiles(null, CH, ME), { ok: true, files: [] });
  assert.deepEqual(parseStagedChatFiles([], CH, ME), { ok: true, files: [] });
  assert.equal(parseStagedChatFiles("x", CH, ME).ok, false);
  assert.equal(parseStagedChatFiles({ path: mine() }, CH, ME).ok, false);
  assert.equal(parseStagedChatFiles([null], CH, ME).ok, false);
  assert.equal(parseStagedChatFiles([{ name: "a.png" }], CH, ME).ok, false);
});

test("parseStagedChatFiles refuses the whole list when any file belongs elsewhere", () => {
  const res = parseStagedChatFiles(
    [
      { path: mine(), name: "shot.png" },
      { path: chatUploadPath(OTHER_CH, ME, OBJ2, "dm.png"), name: "dm.png" },
    ],
    CH,
    ME,
  );
  assert.equal(res.ok, false);
  assert.equal(parseStagedChatFiles([{ path: chatUploadPath(CH, YOU, OBJ, "a.png"), name: "a.png" }], CH, ME).ok, false);
});

test("parseStagedChatFiles caps the count and dedupes", () => {
  const five = Array.from({ length: CHAT_MAX_FILES }, (_, i) => ({ path: mine(`f${i}.png`), name: `f${i}.png` }));
  const ok = parseStagedChatFiles(five, CH, ME);
  assert.equal(ok.ok && ok.files.length, CHAT_MAX_FILES);
  const six = [...five, { path: mine("f5.png", OBJ2), name: "f5.png" }];
  const over = parseStagedChatFiles(six, CH, ME);
  assert.equal(over.ok, false);
  assert.match(!over.ok ? over.error : "", /up to 5 files/);
  const dup = parseStagedChatFiles([{ path: mine(), name: "a.png" }, { path: mine(), name: "b.png" }], CH, ME);
  assert.deepEqual(dup, { ok: true, files: [{ path: mine(), name: "a.png" }] });
});

test("parseStagedChatFiles re-derives the name against the path's checked extension", () => {
  const path = mine("shot.png");
  const files = (name: unknown) => {
    const res = parseStagedChatFiles([{ path, name }], CH, ME);
    assert.equal(res.ok, true);
    return res.ok ? res.files[0].name : "";
  };
  assert.equal(files("Screen Shot 2026-10-15.png"), "Screen Shot 2026-10-15.png");
  assert.equal(files("setup.exe"), "shot.png", "a tampered client can't label a PNG as an .exe");
  assert.equal(files("photo‮fdp.png"), "photofdp.png", "bidi overrides are dropped from the label");
  assert.equal(files(42), "shot.png");
  assert.equal(files(undefined), "shot.png");
});

test("isInlineImage needs both the stored type and the name to be a browser-renderable image", () => {
  assert.equal(isInlineImage({ name: "a.png", type: "image/png" }), true);
  assert.equal(isInlineImage({ name: "a.JPG", type: "image/jpeg" }), true);
  assert.equal(isInlineImage({ name: "a.webp", type: "image/webp; charset=binary" }), true);
  assert.equal(isInlineImage({ name: "a.gif", type: "image/gif" }), true);
  assert.equal(isInlineImage({ name: "IMG_1234.HEIC", type: "image/heic" }), false);
  assert.equal(isInlineImage({ name: "a.svg", type: "image/svg+xml" }), false);
  assert.equal(isInlineImage({ name: "a.png", type: "text/html" }), false);
  assert.equal(isInlineImage({ name: "a.html", type: "image/png" }), false);
  assert.equal(isInlineImage({ name: "a.pdf", type: "application/pdf" }), false);
});

test("chat's picker leaves HEIC out so iOS hands over a JPEG", () => {
  const accept = ATTACHMENT_ACCEPT.split(",");
  assert.ok(!accept.some((t) => /heic|heif/i.test(t)), ATTACHMENT_ACCEPT);
  for (const t of [".png", ".jpg", ".jpeg", "image/jpeg", "image/png", ".pdf", "video/mp4"]) assert.ok(accept.includes(t), t);
});

test("chatFileHref", () => {
  assert.equal(chatFileHref(OBJ, 0), `/chat/files/${OBJ}/0`);
  assert.equal(chatFileHref(OBJ, 2, { download: true }), `/chat/files/${OBJ}/2?download=1`);
  assert.equal(chatFileHref("a/b", 1), "/chat/files/a%2Fb/1");
});
