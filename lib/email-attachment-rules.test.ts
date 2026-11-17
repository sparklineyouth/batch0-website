import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EMAIL_ATTACHMENT_ACCEPT,
  EMAIL_ATTACHMENT_BUCKET,
  EMAIL_ATTACHMENT_EXTENSIONS,
  EMAIL_ATTACHMENT_MAX_BYTES,
  EMAIL_ATTACHMENT_MAX_FILES,
  EMAIL_ATTACHMENT_MAX_RECIPIENTS,
  EMAIL_ATTACHMENT_TOTAL_MAX_BYTES,
  attachmentsTotalBytes,
  buildEmailAttachmentPath,
  checkEmailAttachmentFile,
  checkEmailAttachmentSet,
  contentTypeForName,
  describeAttachments,
  emailAttachmentPrefix,
  encodedSize,
  isAllowedEmailAttachmentName,
  isOwnEmailAttachmentPath,
  isWellFormedEmailAttachmentPath,
  nameForOutboundFile,
  parseStagedEmailAttachments,
  refuseForRecipientCount,
  validateEmailUploadRequest,
} from "./email-attachment-rules.ts";

const UID = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-555555555555";
const OBJ = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

// ---------------------------------------------------------------------------
// The limits are the point of the module
// ---------------------------------------------------------------------------

test("the total cap leaves room under the 25 MB every mail provider enforces", () => {
  // This is the whole reason the cap is 10 and not 20. base64 costs 4 bytes
  // per 3, so the check that matters is on the ENCODED size, plus headroom
  // for the HTML body and headers.
  const onTheWire = encodedSize(EMAIL_ATTACHMENT_TOTAL_MAX_BYTES);
  assert.ok(
    onTheWire < 25 * 1024 * 1024,
    `${onTheWire} bytes encoded would bounce at Gmail and Outlook`,
  );
  // And genuinely roomy, not squeaking under.
  assert.ok(onTheWire < 20 * 1024 * 1024);
});

test("encodedSize is base64's 4-bytes-per-3", () => {
  assert.equal(encodedSize(3), 4);
  assert.equal(encodedSize(1), 4); // padded
  assert.equal(encodedSize(6), 8);
  assert.equal(encodedSize(0), 0);
});

test("no single file may exceed the whole-email total", () => {
  assert.ok(EMAIL_ATTACHMENT_MAX_BYTES <= EMAIL_ATTACHMENT_TOTAL_MAX_BYTES);
});

// ---------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------

test("executable, scriptable and macro-enabled formats are not attachable", () => {
  for (const ext of [
    "exe", "sh", "bat", "cmd", "js", "jar", "app", "dmg",
    "svg", "html", "htm", "xml", "xhtml",
    "doc", "xls", "ppt", "docm", "xlsm", "pptm",
    "zip", "rar", "7z", "tar", "gz",
  ]) {
    assert.equal(
      isAllowedEmailAttachmentName(`payload.${ext}`),
      false,
      `.${ext} must not be attachable`,
    );
  }
});

test("the formats an accelerator actually sends are attachable", () => {
  for (const ext of EMAIL_ATTACHMENT_EXTENSIONS) {
    assert.equal(isAllowedEmailAttachmentName(`file.${ext}`), true);
  }
  assert.equal(isAllowedEmailAttachmentName("certificate.pdf"), true);
  assert.equal(isAllowedEmailAttachmentName("CERTIFICATE.PDF"), true);
});

test("only the last extension counts", () => {
  // invoice.pdf.exe is an exe, and the reverse must still pass.
  assert.equal(isAllowedEmailAttachmentName("invoice.pdf.exe"), false);
  assert.equal(isAllowedEmailAttachmentName("invoice.exe.pdf"), true);
});

test("accept lists every allowed extension", () => {
  const accept = EMAIL_ATTACHMENT_ACCEPT.split(",");
  for (const ext of EMAIL_ATTACHMENT_EXTENSIONS) {
    assert.ok(accept.includes(`.${ext}`), `accept is missing .${ext}`);
  }
});

test("the outbound content type comes from the extension, not the browser", () => {
  assert.equal(contentTypeForName("deck.pdf"), "application/pdf");
  assert.equal(
    contentTypeForName("roster.xlsx"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.equal(contentTypeForName("invite.ics"), "text/calendar");
  assert.equal(contentTypeForName("mystery.bin"), "application/octet-stream");
});

// ---------------------------------------------------------------------------
// Per-file refusals say what to do instead
// ---------------------------------------------------------------------------

test("HEIC is refused with the fix, not just a no", () => {
  const msg = checkEmailAttachmentFile({ name: "IMG_0421.HEIC", size: 2_000_000 });
  assert.match(String(msg), /JPG|PNG/);
});

test("archives are refused because gateways eat them", () => {
  assert.match(String(checkEmailAttachmentFile({ name: "files.zip", size: 10 })), /quarantine/i);
});

test("legacy Office is refused with the modern format named", () => {
  assert.match(String(checkEmailAttachmentFile({ name: "notes.doc", size: 10 })), /\.docx/);
  assert.match(String(checkEmailAttachmentFile({ name: "m.xlsm", size: 10 })), /\.xlsx/);
});

test("an oversize file reports its own size and the limit", () => {
  const msg = String(
    checkEmailAttachmentFile({ name: "video.pdf", size: EMAIL_ATTACHMENT_MAX_BYTES + 1 }),
  );
  assert.match(msg, /10 MB/);
  assert.match(msg, /[Ll]ink/);
});

test("empty and nonsense sizes are refused", () => {
  assert.match(String(checkEmailAttachmentFile({ name: "a.pdf", size: 0 })), /empty/);
  assert.match(
    String(checkEmailAttachmentFile({ name: "a.pdf", size: Number.NaN })),
    /empty/,
  );
});

test("a good file passes", () => {
  assert.equal(checkEmailAttachmentFile({ name: "certificate.pdf", size: 40_000 }), null);
});

// ---------------------------------------------------------------------------
// Set-level refusals
// ---------------------------------------------------------------------------

test("the set check catches a total that each file passes alone", () => {
  const six = 6 * 1024 * 1024;
  const files = [
    { name: "a.pdf", size: six },
    { name: "b.pdf", size: six },
  ];
  // Each is individually fine...
  assert.equal(checkEmailAttachmentFile(files[0]), null);
  assert.equal(checkEmailAttachmentFile(files[1]), null);
  // ...and together they are not.
  assert.match(String(checkEmailAttachmentSet(files)), /12 MB|over the/);
});

test("too many files is refused with a count", () => {
  const files = Array.from({ length: EMAIL_ATTACHMENT_MAX_FILES + 1 }, (_, i) => ({
    name: `f${i}.pdf`,
    size: 1000,
  }));
  assert.match(String(checkEmailAttachmentSet(files)), /up to 5 files/);
});

test("an empty set is fine", () => {
  assert.equal(checkEmailAttachmentSet([]), null);
});

test("attachmentsTotalBytes ignores junk sizes rather than producing NaN", () => {
  assert.equal(
    attachmentsTotalBytes([{ size: 100 }, { size: Number.NaN }, { size: -5 }, { size: 50 }]),
    150,
  );
});

// ---------------------------------------------------------------------------
// The recipient cap
// ---------------------------------------------------------------------------

test("attachments to a huge audience are refused, with the alternative", () => {
  const msg = refuseForRecipientCount(2000, 1);
  assert.match(String(msg), /link/i);
  assert.match(String(msg), /100/);
});

test("the recipient cap only applies when something is attached", () => {
  assert.equal(refuseForRecipientCount(5000, 0), null);
  assert.equal(refuseForRecipientCount(EMAIL_ATTACHMENT_MAX_RECIPIENTS, 3), null);
  assert.notEqual(refuseForRecipientCount(EMAIL_ATTACHMENT_MAX_RECIPIENTS + 1, 1), null);
});

// ---------------------------------------------------------------------------
// The mint action's input check
// ---------------------------------------------------------------------------

test("the mint check counts what is already on the draft", () => {
  const eight = 8 * 1024 * 1024;
  // Alone, fine.
  assert.equal(validateEmailUploadRequest([{ name: "a.pdf", size: eight, type: "" }]).ok, true);
  // With 8 MB already attached, not fine — this is the hole that one-file-at-
  // a-time picking opens if the total is only ever checked per batch.
  const r = validateEmailUploadRequest([{ name: "b.pdf", size: eight, type: "" }], eight);
  assert.equal(r.ok, false);
});

test("the mint check refuses malformed entries", () => {
  assert.equal(validateEmailUploadRequest([]).ok, false);
  assert.equal(validateEmailUploadRequest("nope").ok, false);
  assert.equal(validateEmailUploadRequest([{ name: "a.pdf" }]).ok, false);
  assert.equal(validateEmailUploadRequest([{ name: "", size: 1, type: "" }]).ok, false);
});

// ---------------------------------------------------------------------------
// The path grammar is the authorization
// ---------------------------------------------------------------------------

test("a built path is well formed and under the sender's prefix", () => {
  const p = buildEmailAttachmentPath(emailAttachmentPrefix(UID), OBJ, "Fall Certificate.pdf");
  assert.equal(isWellFormedEmailAttachmentPath(p), true);
  assert.equal(isOwnEmailAttachmentPath(p, UID), true);
  assert.match(p, /fall-certificate\.pdf$/);
});

test("traversal that starts with the right prefix is still refused", () => {
  const evil = `${emailAttachmentPrefix(UID)}../${emailAttachmentPrefix(OTHER)}${OBJ}-x.pdf`;
  assert.equal(isWellFormedEmailAttachmentPath(evil), false);
  assert.equal(isOwnEmailAttachmentPath(evil, UID), false);
});

test("one sender cannot send from another sender's folder", () => {
  const theirs = buildEmailAttachmentPath(emailAttachmentPrefix(OTHER), OBJ, "x.pdf");
  assert.equal(isWellFormedEmailAttachmentPath(theirs), true);
  assert.equal(isOwnEmailAttachmentPath(theirs, UID), false);
});

test("shapes that are not the grammar are refused", () => {
  for (const bad of [
    "",
    "c/not-a-uuid/x.pdf",
    `c/${UID}/x.pdf`,
    `${UID}/${OBJ}-x.pdf`,
    `t/${UID}/${OBJ}-x.pdf`,
    `c/${UID}/${OBJ}-/x.pdf`,
    null,
    42,
  ]) {
    assert.equal(isWellFormedEmailAttachmentPath(bad as unknown), false, String(bad));
  }
});

// ---------------------------------------------------------------------------
// Reading the draft's list
// ---------------------------------------------------------------------------

test("the staged list parses from JSON or an array, and dedupes", () => {
  const path = buildEmailAttachmentPath(emailAttachmentPrefix(UID), OBJ, "a.pdf");
  const one = { path, name: "a.pdf", size: 10, type: "application/pdf" };
  assert.equal(parseStagedEmailAttachments(JSON.stringify([one, one])).items.length, 1);
  assert.equal(parseStagedEmailAttachments([one]).items.length, 1);
});

test("an absent list is no attachments, not an error", () => {
  for (const empty of [null, undefined, ""]) {
    const r = parseStagedEmailAttachments(empty);
    assert.deepEqual(r.items, []);
    assert.deepEqual(r.rejected, []);
  }
});

test("malformed entries are rejected one by one, not as a batch", () => {
  const path = buildEmailAttachmentPath(emailAttachmentPrefix(UID), OBJ, "a.pdf");
  const r = parseStagedEmailAttachments([
    { path, name: "a.pdf", size: 10, type: "" },
    { name: "no path", size: 10, type: "" },
  ]);
  assert.equal(r.items.length, 1);
  assert.equal(r.rejected.length, 1);
});

test("unparseable JSON and oversized blobs do not throw", () => {
  assert.equal(parseStagedEmailAttachments("{{{").items.length, 0);
  assert.equal(parseStagedEmailAttachments("x".repeat(20_000)).rejected.length, 1);
});

// ---------------------------------------------------------------------------
// The name the recipient sees
// ---------------------------------------------------------------------------

test("a client name is only honoured when its extension matches the path", () => {
  const path = buildEmailAttachmentPath(emailAttachmentPrefix(UID), OBJ, "report.pdf");
  assert.equal(nameForOutboundFile("Q3 Report.pdf", path), "Q3 Report.pdf");
  // The attack this exists for: a PDF upload relabelled as an executable.
  assert.equal(nameForOutboundFile("invoice.exe", path), "report.pdf");
  assert.equal(nameForOutboundFile(null, path), "report.pdf");
});

test("bidi overrides are stripped out of a displayed name", () => {
  const path = buildEmailAttachmentPath(emailAttachmentPrefix(UID), OBJ, "a.pdf");
  const name = nameForOutboundFile("photo‮fdp.pdf", path);
  assert.ok(!name.includes("‮"));
});

test("describeAttachments summarises for the audit row", () => {
  assert.equal(describeAttachments([]), "");
  assert.match(describeAttachments([{ name: "a.pdf", size: 1024 }]), /a\.pdf/);
  assert.match(
    describeAttachments([
      { name: "a.pdf", size: 1024 },
      { name: "b.pdf", size: 1024 },
    ]),
    /2 files/,
  );
});

// ---------------------------------------------------------------------------
// The module stays importable from the browser
// ---------------------------------------------------------------------------

test("the rules module pulls in nothing but other pure rules", () => {
  // The picker is a client component and imports this file. One server-side
  // import here and the browser bundle gets it too.
  const ALLOWED = ["./file-name-rules.ts"];
  const src = readFileSync(new URL("./email-attachment-rules.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\brequire\(/);
  for (const [, spec] of src.matchAll(
    /^\s*(?:import|export)[^"']*from\s+["']([^"']+)["']/gm,
  )) {
    assert.ok(ALLOWED.includes(spec), `unexpected import of ${spec}`);
  }
});

// ---------------------------------------------------------------------------
// The limits match the database
// ---------------------------------------------------------------------------

const MIGRATION = readFileSync(
  new URL("../supabase/migrations/0112_email_attachments.sql", import.meta.url),
  "utf8",
);

test("the bucket this module names is the bucket the migration creates", () => {
  assert.match(MIGRATION, new RegExp(`'${EMAIL_ATTACHMENT_BUCKET}'`));
});

test("the bucket's own size limit matches the per-file cap", () => {
  // The bucket is the hard stop: a signed upload URL cannot carry a size
  // limit, so a tampered client is stopped by storage or not at all.
  assert.match(MIGRATION, new RegExp(String(EMAIL_ATTACHMENT_MAX_BYTES)));
});

test("the bucket is private", () => {
  assert.match(MIGRATION, /'email-attachments',\s*'email-attachments',\s*false/);
});
