import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canPreview,
  extOf,
  fmtBytes,
  previewKindFor,
  type DrivePreviewKind,
} from "./drive-files.ts";

// Run with `npm test`.

test("extOf pulls the lowercased extension", () => {
  assert.equal(extOf("Deck.PDF"), "pdf");
  assert.equal(extOf("archive.tar.gz"), "gz");
  assert.equal(extOf("README"), "");
  // A leading dot is the whole name, not an extension.
  assert.equal(extOf(".env"), "");
  // Trailing dot leaves nothing to read.
  assert.equal(extOf("weird."), "");
});

test("previewKindFor trusts the mime type first", () => {
  const cases: Array<[string, string | null, DrivePreviewKind]> = [
    ["shot.png", "image/png", "image"],
    ["logo.svg", "image/svg+xml", "image"],
    ["demo.mp4", "video/mp4", "video"],
    ["jingle.mp3", "audio/mpeg", "audio"],
    ["deck.pdf", "application/pdf", "pdf"],
    ["notes.md", "text/markdown", "text"],
    ["data.json", "application/json", "text"],
    ["sheet.xlsx", "application/vnd.ms-excel", "none"],
    ["bundle.zip", "application/zip", "none"],
  ];
  for (const [name, mime, expected] of cases) {
    assert.equal(
      previewKindFor({ name, mime_type: mime }),
      expected,
      `${name} (${mime})`,
    );
  }
});

test("previewKindFor falls back to the extension when mime is missing", () => {
  assert.equal(previewKindFor({ name: "shot.PNG", mime_type: null }), "image");
  assert.equal(previewKindFor({ name: "deck.pdf" }), "pdf");
  assert.equal(previewKindFor({ name: "notes.txt", mime_type: "" }), "text");
  assert.equal(previewKindFor({ name: "clip.mov", mime_type: null }), "video");
  assert.equal(previewKindFor({ name: "prototype.step" }), "none");
});

test("previewKindFor reads past a generic octet-stream to the extension", () => {
  // Some browsers/CLIs upload everything as octet-stream; the name is then
  // the only signal we have.
  assert.equal(
    previewKindFor({ name: "deck.pdf", mime_type: "application/octet-stream" }),
    "pdf",
  );
  assert.equal(
    previewKindFor({ name: "blob.bin", mime_type: "application/octet-stream" }),
    "none",
  );
});

test("previewKindFor keeps markup as text, never as rendered markup", () => {
  assert.equal(previewKindFor({ name: "index.html" }), "text");
  assert.equal(
    previewKindFor({ name: "index.html", mime_type: "text/html" }),
    "text",
  );
});

test("previewKindFor ignores charset parameters on the mime type", () => {
  assert.equal(
    previewKindFor({ name: "a.csv", mime_type: "text/csv; charset=utf-8" }),
    "text",
  );
});

test("canPreview mirrors previewKindFor", () => {
  assert.equal(canPreview({ name: "a.png", mime_type: "image/png" }), true);
  assert.equal(canPreview({ name: "a.zip", mime_type: "application/zip" }), false);
});

test("fmtBytes scales and keeps one decimal under 10", () => {
  assert.equal(fmtBytes(null), "—");
  assert.equal(fmtBytes(0), "—");
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(1024), "1.0 KB");
  assert.equal(fmtBytes(1536), "1.5 KB");
  assert.equal(fmtBytes(20 * 1024), "20 KB");
  assert.equal(fmtBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(fmtBytes(250 * 1024 * 1024), "250 MB");
});
