import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_EXTENSIONS,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_NAME_MAX,
  allowedPrefixesFor,
  attachmentHref,
  attachmentKind,
  buildAttachmentPath,
  checkAttachmentFile,
  displayFileName,
  fileExtension,
  formatBytes,
  groupAttachmentsByReply,
  isAllowedAttachmentName,
  isBlockedContentType,
  isImageType,
  isPathUnderPrefix,
  isUuid,
  isWellFormedAttachmentPath,
  mayDownloadAttachment,
  nameForStoredFile,
  normalizeContentType,
  opensInline,
  parseAttachmentScope,
  parseStagedAttachments,
  requesterMayAttach,
  safeFileName,
  staffMayAttach,
  stagingPrefix,
  ticketPrefix,
  tokenMayDownloadAttachment,
  validateUploadRequest,
  withDownloadName,
} from "./support-attachment-rules.ts";

// Run with `npm test`.
//
// Ticket attachments are a privacy surface with a twist the rest of support
// doesn't have: the browser does the writing. It uploads straight to the
// bucket with a URL the server minted, so the only things standing between a
// tampered client and someone else's files are the path grammar, the prefix
// each uploader may record from, and the download rules. These pin all three,
// plus the file-name handling that decides what lands on a teammate's disk.

const USER = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER_USER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const TICKET = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const OTHER_TICKET = "7d6c5b4a-3f2e-4d1c-9b0a-8f7e6d5c4b3a";
const OBJECT = "5f8b2c9e-0b1a-4c7e-9d2f-3a4b5c6d7e8f";

const sessionRequester = { kind: "requester", userId: USER, via: "session" } as const;
const tokenRequester = { kind: "requester", userId: USER, via: "token" } as const;
const staff = { kind: "staff", userId: OTHER_USER } as const;

// ---------------------------------------------------------------------------
// The extension allow-list
// ---------------------------------------------------------------------------

test("the allow-list is exactly the agreed set", () => {
  assert.deepEqual(
    [...ATTACHMENT_EXTENSIONS].sort(),
    ["csv", "gif", "heic", "heif", "jpeg", "jpg", "log", "mov", "mp4", "pdf", "png", "txt", "webm", "webp"],
  );
});

test("extensions are matched case-insensitively", () => {
  for (const name of ["SHOT.PNG", "photo.JpEg", "Receipt.Pdf", "IMG_0001.HEIC", "clip.MOV"]) {
    assert.equal(isAllowedAttachmentName(name), true, name);
  }
  assert.equal(fileExtension("SHOT.PNG"), "png");
});

test("only the last extension counts, so a double extension can't smuggle an executable", () => {
  assert.equal(isAllowedAttachmentName("invoice.png.exe"), false);
  assert.equal(isAllowedAttachmentName("invoice.pdf.html"), false);
  assert.equal(isAllowedAttachmentName("notes.txt.js"), false);
  // The other way round is a PNG with a strange name, which is fine.
  assert.equal(isAllowedAttachmentName("setup.exe.png"), true);
});

test("active content, office files, archives and extensionless names are refused", () => {
  for (const name of [
    "logo.svg",
    "page.html",
    "page.htm",
    "script.js",
    "doc.docx",
    "sheet.xlsm",
    "bundle.zip",
    "README",
    ".png", // a hidden file called "png", not a PNG
    "shot.png.", // a trailing dot has no extension
    "",
  ]) {
    assert.equal(isAllowedAttachmentName(name), false, JSON.stringify(name));
  }
});

test("the file input's accept list offers every allowed extension", () => {
  for (const ext of ATTACHMENT_EXTENSIONS) {
    assert.ok(ATTACHMENT_ACCEPT.split(",").includes(`.${ext}`), ext);
  }
  assert.ok(!ATTACHMENT_ACCEPT.includes("svg"));
  assert.ok(!ATTACHMENT_ACCEPT.includes("image/*"), "a wildcard would offer SVG");
});

// ---------------------------------------------------------------------------
// safeFileName — the storage-key segment
// ---------------------------------------------------------------------------

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9]{1,10})?$/;

test("safeFileName strips any path, in either separator", () => {
  assert.equal(safeFileName("../../etc/passwd.png"), "passwd.png");
  assert.equal(safeFileName("..\\..\\Windows\\win.ini"), "win.ini");
  assert.equal(safeFileName("/absolute/path/to/shot.png"), "shot.png");
  assert.equal(safeFileName("C:\\Users\\me\\Desktop\\Receipt.PDF"), "receipt.pdf");
  for (const name of ["../x.png", "a/../../b.png", "....png", "..", "/", "\\\\server\\share\\x.png"]) {
    const out = safeFileName(name);
    assert.ok(!out.includes("/") && !out.includes("\\") && !out.includes(".."), `${name} → ${out}`);
    assert.match(out, SAFE_SEGMENT, `${name} → ${out}`);
  }
});

test("safeFileName folds accents and replaces scripts it can't spell", () => {
  assert.equal(safeFileName("résumé final (1).PDF"), "resume-final-1.pdf");
  assert.equal(safeFileName("Ångström—naïve.txt"), "angstrom-naive.txt");
  assert.equal(safeFileName("スクリーンショット 2026-10-01.png"), "2026-10-01.png");
  assert.equal(safeFileName("截图.png"), "file.png", "nothing spellable left → a generic stem");
  assert.equal(safeFileName("a\u0000b\u202e.png"), "a-b.png", "control and bidi characters are gone");
  assert.equal(safeFileName("😀😀.jpg"), "file.jpg");
});

test("safeFileName keeps exactly one dot, so the stored extension is the checked one", () => {
  assert.equal(safeFileName("report.v2.final.pdf"), "report-v2-final.pdf");
  assert.equal(safeFileName("setup.exe.png"), "setup-exe.png");
  for (const name of ["a.b.c.png", "x.png.exe", "Screen Shot 2026-10-01 at 9.41.12 AM.png", "....jpg"]) {
    const out = safeFileName(name);
    assert.equal(fileExtension(out), fileExtension(name), `${name} → ${out}`);
    assert.ok(out.split(".").length <= 2, `${name} → ${out}`);
  }
});

test("safeFileName is bounded and never empty", () => {
  const long = safeFileName(`${"a".repeat(500)}.jpeg`);
  assert.ok(long.length <= 91, `got ${long.length}`);
  assert.ok(long.endsWith(".jpeg"));
  assert.equal(safeFileName(""), "file");
  assert.equal(safeFileName("---.png"), "file.png");
  assert.equal(safeFileName("   "), "file");
  assert.match(safeFileName(`${"-".repeat(70)}x${"-".repeat(70)}.png`), SAFE_SEGMENT);
});

// ---------------------------------------------------------------------------
// displayFileName / nameForStoredFile — what people see and download
// ---------------------------------------------------------------------------

test("displayFileName keeps unicode but drops paths and invisible characters", () => {
  assert.equal(displayFileName("Снимок экрана.png"), "Снимок экрана.png");
  assert.equal(displayFileName("C:\\fakepath\\receipt.pdf"), "receipt.pdf");
  assert.equal(displayFileName("../../secret.txt"), "secret.txt");
  // RIGHT-TO-LEFT OVERRIDE: "photo\u202Egnp.exe" would render as "photoexe.png".
  assert.equal(displayFileName("photo\u202Egnp.exe"), "photognp.exe");
  assert.equal(displayFileName("tab\tand\nnewline.txt"), "tab and newline.txt");
  assert.equal(displayFileName("   "), "file");
});

test("displayFileName fits the column's 200 code points and keeps the extension", () => {
  const long = displayFileName(`${"é".repeat(400)}.pdf`);
  assert.ok(Array.from(long).length <= ATTACHMENT_NAME_MAX);
  assert.ok(long.endsWith("….pdf"));
  // Counted in code points, as Postgres char_length counts — an emoji is one.
  const emoji = displayFileName(`${"😀".repeat(199)}.png`);
  assert.ok(Array.from(emoji).length <= ATTACHMENT_NAME_MAX);
  assert.equal(displayFileName("short.png"), "short.png");
});

test("a stored name always carries the extension the path was minted with", () => {
  const path = buildAttachmentPath(ticketPrefix(TICKET), OBJECT, "Shot.PNG");
  assert.equal(nameForStoredFile("Shot.PNG", path), "Shot.PNG");
  assert.equal(nameForStoredFile("My screenshot.png", path), "My screenshot.png");
  // A tampered client renaming a PNG upload to something executable gets the
  // server-built name back instead.
  assert.equal(nameForStoredFile("setup.exe", path), "shot.png");
  assert.equal(nameForStoredFile(42, path), "shot.png");
  assert.equal(nameForStoredFile("", path), "shot.png");
});

// ---------------------------------------------------------------------------
// Size and count limits
// ---------------------------------------------------------------------------

test("files are 1 byte to 10 MB", () => {
  assert.equal(ATTACHMENT_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(checkAttachmentFile({ name: "a.png", size: 1 }), null);
  assert.equal(checkAttachmentFile({ name: "a.png", size: ATTACHMENT_MAX_BYTES }), null);
  assert.match(checkAttachmentFile({ name: "a.png", size: ATTACHMENT_MAX_BYTES + 1 })!, /over the 10 MB limit/);
  assert.match(checkAttachmentFile({ name: "a.png", size: 0 })!, /empty/);
  assert.match(checkAttachmentFile({ name: "a.png", size: Number.NaN })!, /empty/);
  assert.match(checkAttachmentFile({ name: "a.png", size: -5 })!, /empty/);
});

test("the size message points a long recording at a link instead", () => {
  assert.match(checkAttachmentFile({ name: "demo.mp4", size: ATTACHMENT_MAX_BYTES * 3 })!, /link/);
  assert.doesNotMatch(checkAttachmentFile({ name: "scan.pdf", size: ATTACHMENT_MAX_BYTES * 3 })!, /link/);
});

test("the type message names the extension only when it's printable", () => {
  assert.match(checkAttachmentFile({ name: "logo.svg", size: 10 })!, /can't take \.svg files/);
  assert.match(checkAttachmentFile({ name: "README", size: 10 })!, /can't tell what kind of file/);
  assert.match(
    checkAttachmentFile({ name: `x.${"<b>".repeat(5)}`, size: 10 })!,
    /can't tell what kind of file/,
  );
});

test("an upload request is one to five well-formed, allowed files", () => {
  const ok = validateUploadRequest([{ name: "a.png", size: 10, type: "image/png" }]);
  assert.deepEqual(ok, { ok: true, files: [{ name: "a.png", size: 10, type: "image/png" }] });
  assert.equal(validateUploadRequest([]).ok, false);
  assert.equal(validateUploadRequest("a.png").ok, false);
  assert.equal(validateUploadRequest(null).ok, false);
  const six = Array.from({ length: ATTACHMENT_MAX_FILES + 1 }, (_, i) => ({ name: `${i}.png`, size: 1 }));
  assert.equal(validateUploadRequest(six).ok, false);
  assert.equal(validateUploadRequest([{ name: "a.png", size: "10" }]).ok, false);
  assert.equal(validateUploadRequest([{ name: "a.png", size: 10, type: 7 }]).ok, false);
  assert.equal(validateUploadRequest([{ name: "a.exe", size: 10 }]).ok, false);
  assert.equal(validateUploadRequest([{ name: "a.png", size: ATTACHMENT_MAX_BYTES + 1 }]).ok, false);
  // One bad file sinks the request; the picker shows that file's reason.
  const mixed = validateUploadRequest([
    { name: "a.png", size: 10 },
    { name: "b.svg", size: 10 },
  ]);
  assert.equal(mixed.ok, false);
  assert.match(!mixed.ok ? mixed.error : "", /b\.svg/);
});

// ---------------------------------------------------------------------------
// The path grammar and who may record from where
// ---------------------------------------------------------------------------

test("built paths have exactly the two shapes the bucket holds", () => {
  const staged = buildAttachmentPath(stagingPrefix(USER), OBJECT, "Receipt.PDF");
  assert.equal(staged, `u/${USER}/${OBJECT}-receipt.pdf`);
  const onTicket = buildAttachmentPath(ticketPrefix(TICKET), OBJECT, "../../x.png");
  assert.equal(onTicket, `t/${TICKET}/${OBJECT}-x.png`);
  assert.ok(isWellFormedAttachmentPath(staged));
  assert.ok(isWellFormedAttachmentPath(onTicket));
  // Whatever the browser called the file, the path stays in the grammar.
  for (const name of ["a/b/c.png", "..\\x.pdf", "résumé.pdf", "スクショ.png", "x".repeat(900) + ".png"]) {
    assert.ok(isWellFormedAttachmentPath(buildAttachmentPath(ticketPrefix(TICKET), OBJECT, name)), name);
  }
});

test("anything outside the grammar is not an attachment path", () => {
  for (const path of [
    `t/${TICKET}/../u/${OTHER_USER}/${OBJECT}-x.png`,
    `t/${TICKET}/${OBJECT}-../../x.png`,
    `t/${TICKET}/sub/${OBJECT}-x.png`,
    `t/${TICKET}//${OBJECT}-x.png`,
    `t/${TICKET}/${OBJECT}-.png`,
    `t/${TICKET}/${OBJECT}x.png`,
    `t/${TICKET}/not-a-uuid-x.png`,
    `T/${TICKET}/${OBJECT}-x.png`,
    `t/${TICKET.toUpperCase()}/${OBJECT}-x.png`,
    `x/${TICKET}/${OBJECT}-x.png`,
    `/t/${TICKET}/${OBJECT}-x.png`,
    `t/${TICKET}/${OBJECT}-x.png\n`,
    `t/${TICKET}/${OBJECT}-X.PNG`,
    "",
  ]) {
    assert.equal(isWellFormedAttachmentPath(path), false, JSON.stringify(path));
  }
  assert.equal(isWellFormedAttachmentPath(42), false);
  assert.equal(isWellFormedAttachmentPath(null), false);
});

test("a signed-in requester records from their staging folder or the ticket's", () => {
  const prefixes = allowedPrefixesFor(sessionRequester, TICKET);
  assert.deepEqual(prefixes, [`u/${USER}/`, `t/${TICKET}/`]);
  assert.ok(isPathUnderPrefix(`u/${USER}/${OBJECT}-a.png`, prefixes));
  assert.ok(isPathUnderPrefix(`t/${TICKET}/${OBJECT}-a.png`, prefixes));
  // Not someone else's staging folder, not another ticket.
  assert.equal(isPathUnderPrefix(`u/${OTHER_USER}/${OBJECT}-a.png`, prefixes), false);
  assert.equal(isPathUnderPrefix(`t/${OTHER_TICKET}/${OBJECT}-a.png`, prefixes), false);
  // A prefix match on a path outside the grammar doesn't count.
  assert.equal(
    isPathUnderPrefix(`t/${TICKET}/../../u/${OTHER_USER}/${OBJECT}-a.png`, prefixes),
    false,
  );
});

test("a token holder and staff record from the ticket's folder only", () => {
  // A thread link proves nothing about any account, so it can't vouch for an
  // account's staging folder — even the owner's.
  assert.deepEqual(allowedPrefixesFor(tokenRequester, TICKET), [`t/${TICKET}/`]);
  assert.equal(
    isPathUnderPrefix(`u/${USER}/${OBJECT}-a.png`, allowedPrefixesFor(tokenRequester, TICKET)),
    false,
  );
  assert.deepEqual(allowedPrefixesFor(staff, TICKET), [`t/${TICKET}/`]);
  assert.equal(
    isPathUnderPrefix(`u/${OTHER_USER}/${OBJECT}-a.png`, allowedPrefixesFor(staff, TICKET)),
    false,
  );
  // A session requester with no user id (an account since deleted) gets the
  // ticket folder only.
  assert.deepEqual(
    allowedPrefixesFor({ kind: "requester", userId: null, via: "session" }, TICKET),
    [`t/${TICKET}/`],
  );
});

test("a malformed ticket id allows nothing at all", () => {
  assert.deepEqual(allowedPrefixesFor(staff, "not-a-uuid"), []);
  assert.deepEqual(allowedPrefixesFor(sessionRequester, ""), []);
  assert.equal(isPathUnderPrefix(`t/${TICKET}/${OBJECT}-a.png`, []), false);
});

test("uuids are checked before they reach a query", () => {
  assert.ok(isUuid(TICKET));
  assert.ok(isUuid(TICKET.toUpperCase()));
  for (const v of ["", "1", `${TICKET}x`, ` ${TICKET}`, "1b4e28ba2fa141d2883f0016d3cca427", null, 7]) {
    assert.equal(isUuid(v), false, String(v));
  }
});

// ---------------------------------------------------------------------------
// Reading what a form posted
// ---------------------------------------------------------------------------

const entry = (over: Record<string, unknown> = {}) => ({
  path: `t/${TICKET}/${OBJECT}-a.png`,
  name: "a.png",
  size: 10,
  type: "image/png",
  ...over,
});

test("no attachments is not an error", () => {
  for (const raw of [undefined, null, "", "[]", []]) {
    assert.deepEqual(parseStagedAttachments(raw), { items: [], rejected: [] }, JSON.stringify(raw));
  }
});

test("a malformed list is one rejection, not a crash", () => {
  for (const raw of ["{", "not json", '{"path":"x"}', "42", JSON.stringify("x"), { path: "x" }, 7]) {
    const out = parseStagedAttachments(raw);
    assert.equal(out.items.length, 0, String(raw));
    assert.equal(out.rejected.length, 1, String(raw));
  }
  // An absurdly long value is refused before it is parsed.
  const huge = JSON.stringify(Array.from({ length: 2000 }, () => entry()));
  assert.equal(parseStagedAttachments(huge).rejected.length, 1);
});

test("each entry needs a path, name, numeric size and string type", () => {
  const out = parseStagedAttachments(
    JSON.stringify([
      entry(),
      entry({ path: 7 }),
      entry({ path: `t/${TICKET}/${"b".repeat(600)}` }),
      entry({ name: null }),
      entry({ size: "10" }),
      entry({ size: Infinity }),
      entry({ type: {} }),
      null,
      "x",
    ]),
  );
  assert.equal(out.items.length, 1);
  assert.equal(out.rejected.length, 8);
  assert.deepEqual(out.items[0], entry());
});

test("the same upload listed twice is one attachment, and extras over the cap are refused", () => {
  const dup = parseStagedAttachments(JSON.stringify([entry(), entry()]));
  assert.equal(dup.items.length, 1);
  assert.equal(dup.rejected.length, 0);

  const many = Array.from({ length: ATTACHMENT_MAX_FILES + 2 }, (_, i) =>
    entry({ path: `t/${TICKET}/${OBJECT}-${i}.png`, name: `${i}.png` }),
  );
  const out = parseStagedAttachments(JSON.stringify(many));
  assert.equal(out.items.length, ATTACHMENT_MAX_FILES);
  assert.equal(out.rejected.length, 2);
  assert.match(out.rejected[0].reason, /Only 5 files/);
});

test("a missing type is tolerated as unknown; the server reads the real one anyway", () => {
  const out = parseStagedAttachments([{ path: entry().path, name: "a.png", size: 10 }]);
  assert.equal(out.items[0].type, "");
});

test("an upload scope from the browser is narrowed before use", () => {
  assert.deepEqual(parseAttachmentScope({ kind: "new" }), { kind: "new" });
  assert.deepEqual(parseAttachmentScope({ kind: "own", reference: "B0-4F2A-9C7K" }), {
    kind: "own",
    reference: "B0-4F2A-9C7K",
  });
  assert.deepEqual(parseAttachmentScope({ kind: "staff", ticketId: TICKET }), {
    kind: "staff",
    ticketId: TICKET,
  });
  for (const raw of [
    null,
    "new",
    {},
    { kind: "admin" },
    { kind: "own" },
    { kind: "own", reference: "x".repeat(100) },
    { kind: "token", token: 5 },
    { kind: "token", token: "x".repeat(200) },
    { kind: "staff", ticketId: "1" },
  ]) {
    assert.equal(parseAttachmentScope(raw), null, JSON.stringify(raw));
  }
  // Extra keys don't ride along.
  assert.deepEqual(parseAttachmentScope({ kind: "new", userId: OTHER_USER }), { kind: "new" });
});

// ---------------------------------------------------------------------------
// Who may attach, who may download
// ---------------------------------------------------------------------------

test("a requester attaches only to their own ticket, and not once it's closed", () => {
  assert.equal(requesterMayAttach(USER, { userId: USER, status: "open" }), true);
  assert.equal(requesterMayAttach(USER, { userId: USER, status: "resolved" }), true);
  assert.equal(requesterMayAttach(USER, { userId: USER, status: "closed" }), false);
  assert.equal(requesterMayAttach(USER, { userId: OTHER_USER, status: "open" }), false);
  assert.equal(requesterMayAttach(USER, { userId: null, status: "open" }), false);
});

test("staff attach with support.manage, plus support.sensitive on a confidential concern", () => {
  const plain = { sensitive: false };
  const confidential = { sensitive: true };
  assert.equal(staffMayAttach({ canManage: true, canSeeSensitive: false }, plain), true);
  assert.equal(staffMayAttach({ canManage: true, canSeeSensitive: false }, confidential), false);
  assert.equal(staffMayAttach({ canManage: true, canSeeSensitive: true }, confidential), true);
  assert.equal(staffMayAttach({ canManage: false, canSeeSensitive: true }, plain), false);
});

test("the session download rule: staff see everything they may see, the owner sees the public files", () => {
  const ticket = { userId: USER, sensitive: false };
  const publicFile = { isInternal: false };
  const internalFile = { isInternal: true };
  const owner = { userId: USER, canView: false, canSeeSensitive: false };
  const stranger = { userId: OTHER_USER, canView: false, canSeeSensitive: false };
  const viewer = { userId: OTHER_USER, canView: true, canSeeSensitive: false };

  assert.equal(mayDownloadAttachment(owner, ticket, publicFile), true);
  assert.equal(mayDownloadAttachment(owner, ticket, internalFile), false);
  assert.equal(mayDownloadAttachment(stranger, ticket, publicFile), false);
  assert.equal(mayDownloadAttachment(null, ticket, publicFile), false);
  assert.equal(mayDownloadAttachment(viewer, ticket, publicFile), true);
  assert.equal(mayDownloadAttachment(viewer, ticket, internalFile), true);
});

test("a confidential concern's files need support.sensitive — except for the person who filed it", () => {
  const ticket = { userId: USER, sensitive: true };
  const file = { isInternal: false };
  assert.equal(
    mayDownloadAttachment({ userId: OTHER_USER, canView: true, canSeeSensitive: false }, ticket, file),
    false,
  );
  assert.equal(
    mayDownloadAttachment({ userId: OTHER_USER, canView: true, canSeeSensitive: true }, ticket, file),
    true,
  );
  // support.sensitive without view/manage is not a way in.
  assert.equal(
    mayDownloadAttachment({ userId: OTHER_USER, canView: false, canSeeSensitive: true }, ticket, file),
    false,
  );
  assert.equal(
    mayDownloadAttachment({ userId: USER, canView: false, canSeeSensitive: false }, ticket, file),
    true,
  );
  // A ticket with no account behind it has no owner to match.
  assert.equal(
    mayDownloadAttachment(
      { userId: USER, canView: false, canSeeSensitive: false },
      { userId: null, sensitive: false },
      file,
    ),
    false,
  );
});

test("a token reaches only its own ticket's public files", () => {
  assert.equal(tokenMayDownloadAttachment({ id: TICKET }, { ticketId: TICKET, isInternal: false }), true);
  assert.equal(tokenMayDownloadAttachment({ id: TICKET }, { ticketId: TICKET, isInternal: true }), false);
  assert.equal(
    tokenMayDownloadAttachment({ id: TICKET }, { ticketId: OTHER_TICKET, isInternal: false }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Content types and links
// ---------------------------------------------------------------------------

test("active content is refused whatever the extension claimed", () => {
  for (const t of [
    "text/html",
    "text/html; charset=utf-8",
    "TEXT/HTML",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/javascript",
    "application/x-javascript",
    "text/javascript",
    "application/xml",
    "text/xml",
  ]) {
    assert.equal(isBlockedContentType(t), true, t);
  }
  for (const t of ["image/png", "application/pdf", "text/plain", "text/csv", "video/mp4", "", null]) {
    assert.equal(isBlockedContentType(t), false, String(t));
  }
});

test("only browser-renderable images open inline, and only when the name agrees", () => {
  assert.equal(opensInline({ contentType: "image/png", fileName: "a.png" }), true);
  assert.equal(opensInline({ contentType: "image/jpeg", fileName: "a.JPG" }), true);
  assert.equal(opensInline({ contentType: "image/heic", fileName: "a.heic" }), false);
  assert.equal(opensInline({ contentType: "application/pdf", fileName: "a.pdf" }), false);
  assert.equal(opensInline({ contentType: "text/plain", fileName: "a.txt" }), false);
  assert.equal(opensInline({ contentType: "video/mp4", fileName: "a.mp4" }), false);
  // A type and a name that disagree download rather than render.
  assert.equal(opensInline({ contentType: "image/png", fileName: "a.pdf" }), false);
  assert.equal(opensInline({ contentType: "application/pdf", fileName: "a.png" }), false);
  assert.equal(isImageType("image/png; foo=bar"), true);
  assert.equal(isImageType("image/svg+xml"), false);
});

test("content types are stored tidy and never empty", () => {
  assert.equal(normalizeContentType(" Image/PNG "), "image/png");
  assert.equal(normalizeContentType(""), "application/octet-stream");
  assert.equal(normalizeContentType(null), "application/octet-stream");
  assert.ok(normalizeContentType("x".repeat(500)).length <= 200);
});

test("chips get an icon for what they are", () => {
  assert.equal(attachmentKind({ contentType: "image/png", fileName: "a.png" }), "image");
  assert.equal(attachmentKind({ contentType: "", fileName: "IMG_1.HEIC" }), "image");
  assert.equal(attachmentKind({ contentType: "video/quicktime", fileName: "a.mov" }), "video");
  assert.equal(attachmentKind({ contentType: "application/pdf", fileName: "a.pdf" }), "pdf");
  assert.equal(attachmentKind({ contentType: "", fileName: "server.log" }), "text");
  assert.equal(attachmentKind({ contentType: "application/octet-stream", fileName: "x" }), "file");
});

test("links go through the download routes, never to storage", () => {
  assert.equal(attachmentHref({ kind: "session" }, OBJECT), `/support/files/${OBJECT}`);
  const token = "A".repeat(43);
  assert.equal(
    attachmentHref({ kind: "token", token }, OBJECT),
    `/support/t/${token}/files/${OBJECT}`,
  );
  assert.equal(attachmentHref({ kind: "session" }, "a/b"), "/support/files/a%2Fb");
});

test("a download name is encoded once, not twice", () => {
  // storage-js's own `download` option double-encodes ("%25C3%25A9").
  const url = withDownloadName("https://x.supabase.co/storage/v1/object/sign/b/p?token=abc", "résumé (1).pdf");
  assert.equal(
    url,
    "https://x.supabase.co/storage/v1/object/sign/b/p?token=abc&download=r%C3%A9sum%C3%A9%20(1).pdf",
  );
  assert.ok(!url.includes("%25"));
  assert.equal(withDownloadName("https://x/p", "a&b.pdf"), "https://x/p?download=a%26b.pdf");
});

test("attachments group under the message they were posted with", () => {
  const items = [
    { id: "1", replyId: null },
    { id: "2", replyId: "r1" },
    { id: "3", replyId: "r1" },
    { id: "4", replyId: "r2" },
  ];
  const { request, byReply } = groupAttachmentsByReply(items);
  assert.deepEqual(request.map((i) => i.id), ["1"]);
  assert.deepEqual(byReply.r1.map((i) => i.id), ["2", "3"]);
  assert.deepEqual(byReply.r2.map((i) => i.id), ["4"]);
  assert.equal(Object.getPrototypeOf(byReply), Object.prototype, "a plain object crosses into a client component");
});

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------

test("formatBytes reads like a person wrote it", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(820 * 1024), "820 KB");
  assert.equal(formatBytes(2.4 * 1024 * 1024), "2.4 MB");
  assert.equal(formatBytes(ATTACHMENT_MAX_BYTES), "10 MB");
  assert.equal(formatBytes(10.4 * 1024 * 1024), "10.4 MB");
  assert.equal(formatBytes(3 * 1024 ** 3), "3 GB");
});

test("formatBytes rolls over instead of printing 1024 of a unit", () => {
  assert.equal(formatBytes(1024 * 1024 - 1), "1 MB");
  assert.equal(formatBytes(1023.97 * 1024), "1 MB");
});

test("formatBytes says nothing for something that isn't a size", () => {
  for (const v of [-1, Number.NaN, Infinity, null, undefined]) {
    assert.equal(formatBytes(v as number), "", String(v));
  }
});

// ---------------------------------------------------------------------------
// The module stays importable from the browser
// ---------------------------------------------------------------------------

test("the rules module has no imports", () => {
  // The picker is a client component and imports this file. One import of
  // anything server-side here and the browser bundle gets it too.
  const src = readFileSync(new URL("./support-attachment-rules.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /\brequire\(/);
});

// ---------------------------------------------------------------------------
// The limits match the database
// ---------------------------------------------------------------------------

const MIGRATION = readFileSync(
  new URL("../supabase/migrations/0090_support_tickets.sql", import.meta.url),
  "utf8",
);
const HAS_TABLE = /support_ticket_attachments/.test(MIGRATION);

test(
  "the caps are the ones migration 0090 enforces",
  { skip: HAS_TABLE ? false : "0090 has no attachments table yet" },
  () => {
    // A cap above the CHECK means a file that passes every check here and
    // then fails the insert; the bucket limit is the one a signed upload URL
    // can't get past.
    assert.match(MIGRATION, /size_bytes integer not null check \(size_bytes between 1 and 10485760\)/);
    assert.match(MIGRATION, /file_name text not null check \(char_length\(file_name\) between 1 and 200\)/);
    assert.match(MIGRATION, /storage_path text not null unique/);
    assert.match(MIGRATION, /'support-attachments'/);
    assert.ok(MIGRATION.includes(String(ATTACHMENT_MAX_BYTES)));
  },
);
