import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseGoogleUrl as p,
  embedUrl,
  openUrl,
  linkFromRow,
  cleanTitle,
  safeHttpsUrl,
  pitchPreview,
} from "./google-drive-links.ts";

const F = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345"; // 33 chars, folder/file shaped
const D = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"; // 44 chars, editor shaped

test("folders: every shape people paste", () => {
  for (const u of [
    `https://drive.google.com/drive/folders/${F}`,
    `https://drive.google.com/drive/folders/${F}?usp=sharing`,
    `https://drive.google.com/drive/folders/${F}/`,
    `https://drive.google.com/drive/u/0/folders/${F}`,
    `https://drive.google.com/drive/u/2/folders/${F}?usp=drive_link`,
    `https://drive.google.com/drive/mobile/folders/${F}`,
    `drive.google.com/drive/folders/${F}`,
    `  https://drive.google.com/drive/folders/${F}  `,
    `http://drive.google.com/drive/folders/${F}`,
    `https://drive.google.com/folderview?id=${F}`,
    `https://drive.google.com/embeddedfolderview?id=${F}#list`,
    `https://drive.google.com/a/school.edu/folderview?id=${F}`,
    `https://DRIVE.GOOGLE.COM/drive/folders/${F}`,
  ]) {
    const l = p(u);
    assert.equal(l?.kind, "folder", u);
    assert.equal(l?.id, F, u);
  }
  const rk = p(`https://drive.google.com/drive/folders/${F}?resourcekey=0-AbC_d-1`)!;
  assert.equal(rk.resourceKey, "0-AbC_d-1");
  assert.equal(
    embedUrl(rk),
    `https://drive.google.com/embeddedfolderview?id=${F}&resourcekey=0-AbC_d-1#grid`,
  );
  assert.equal(
    embedUrl(rk, "list"),
    `https://drive.google.com/embeddedfolderview?id=${F}&resourcekey=0-AbC_d-1#list`,
  );
  assert.equal(
    openUrl(rk),
    `https://drive.google.com/drive/folders/${F}?resourcekey=0-AbC_d-1`,
  );
  // A malformed resource key is dropped, not passed through.
  assert.equal(p(`https://drive.google.com/drive/folders/${F}?resourcekey=a%22b`)?.resourceKey, null);
});

test("editors: docs, sheets, slides, forms, drawings", () => {
  const doc = p(`https://docs.google.com/document/d/${D}/edit#heading=h.abc`)!;
  assert.equal(doc.kind, "doc");
  assert.equal(embedUrl(doc), `https://docs.google.com/document/d/${D}/preview`);
  assert.equal(openUrl(doc), `https://docs.google.com/document/d/${D}/edit`);
  assert.equal(p(`https://docs.google.com/document/u/1/d/${D}/edit`)?.id, D);
  assert.equal(p(`https://docs.google.com/a/batch0.org/document/d/${D}/edit`)?.id, D);
  assert.equal(p(`https://docs.google.com/document/d/${D}`)?.kind, "doc");

  const sheet = p(`https://docs.google.com/spreadsheets/d/${D}/edit#gid=123456`)!;
  assert.equal(sheet.kind, "sheet");
  assert.equal(sheet.gid, "123456");
  assert.equal(embedUrl(sheet), `https://docs.google.com/spreadsheets/d/${D}/preview#gid=123456`);
  assert.equal(openUrl(sheet), `https://docs.google.com/spreadsheets/d/${D}/edit#gid=123456`);
  assert.equal(p(`https://docs.google.com/spreadsheets/d/${D}/edit?gid=7#gid=7`)?.gid, "7");
  assert.equal(p(`https://docs.google.com/spreadsheets/d/${D}/edit#gid=1x`)?.gid, null);
  // gid only means something on a sheet.
  assert.equal(p(`https://docs.google.com/document/d/${D}/edit#gid=5`)?.gid, null);

  const slides = p(`https://docs.google.com/presentation/d/${D}/edit#slide=id.p`)!;
  assert.equal(slides.kind, "slides");
  assert.equal(
    embedUrl(slides),
    `https://docs.google.com/presentation/d/${D}/embed?start=false&loop=false&delayms=60000`,
  );

  const form = p(`https://docs.google.com/forms/d/${D}/edit`)!;
  assert.equal(form.kind, "form");
  assert.equal(embedUrl(form), `https://docs.google.com/forms/d/${D}/viewform?embedded=true`);

  assert.equal(p(`https://docs.google.com/drawings/d/${D}/edit`)?.kind, "drawing");
});

test("published (/d/e/) links", () => {
  const pub = p(`https://docs.google.com/presentation/d/e/2PACX-1vT${D}/pub?start=false`)!;
  assert.equal(pub.published, true);
  assert.equal(
    embedUrl(pub),
    `https://docs.google.com/presentation/d/e/2PACX-1vT${D}/embed?start=false&loop=false`,
  );
  const fm = p(`https://docs.google.com/forms/d/e/1FAIpQLSf${D}/viewform?usp=sf_link`)!;
  assert.equal(fm.kind, "form");
  assert.equal(embedUrl(fm), `https://docs.google.com/forms/d/e/1FAIpQLSf${D}/viewform?embedded=true`);
  assert.equal(openUrl(fm), `https://docs.google.com/forms/d/e/1FAIpQLSf${D}/viewform`);
  const sh = p(`https://docs.google.com/spreadsheets/d/e/2PACX-${D}/pubhtml`)!;
  assert.equal(openUrl(sh), `https://docs.google.com/spreadsheets/d/e/2PACX-${D}/pubhtml`);
  assert.equal(
    embedUrl(sh),
    `https://docs.google.com/spreadsheets/d/e/2PACX-${D}/pubhtml?widget=true&headers=false`,
  );
});

test("files", () => {
  const f = p(`https://drive.google.com/file/d/${F}/view?usp=sharing`)!;
  assert.equal(f.kind, "file");
  assert.equal(embedUrl(f), `https://drive.google.com/file/d/${F}/preview`);
  assert.equal(openUrl(f), `https://drive.google.com/file/d/${F}/view`);
  assert.equal(p(`https://drive.google.com/file/u/0/d/${F}/view`)?.id, F);
  assert.equal(p(`https://drive.google.com/file/d/${F}`)?.id, F);
  assert.equal(p(`https://drive.google.com/open?id=${F}&authuser=0`)?.kind, "file");
  assert.equal(p(`https://drive.google.com/uc?id=${F}&export=download`)?.id, F);
  assert.equal(p(`https://docs.google.com/file/d/${F}/edit`)?.kind, "file");
  const rk = p(`https://drive.google.com/file/d/${F}/view?resourcekey=0-xyz`)!;
  assert.equal(embedUrl(rk), `https://drive.google.com/file/d/${F}/preview?resourcekey=0-xyz`);
});

test("open?id= is a folder only when a folder is expected", () => {
  assert.equal(p(`https://drive.google.com/open?id=${F}`, { prefer: "folder" })?.kind, "folder");
  assert.equal(p(`https://drive.google.com/open?id=${F}`)?.kind, "file");
  // Unambiguous shapes ignore the preference.
  assert.equal(p(`https://drive.google.com/file/d/${F}/view`, { prefer: "folder" })?.kind, "file");
});

test("rejects look-alikes, junk and id-less links", () => {
  for (const u of [
    "",
    "   ",
    null,
    undefined,
    42,
    "javascript:alert(1)",
    "data:text/html,x",
    `ftp://drive.google.com/drive/folders/${F}`,
    `https://drive.google.com.evil.com/drive/folders/${F}`,
    `https://evil.com/drive.google.com/drive/folders/${F}`,
    `https://evil.com/?u=https://drive.google.com/drive/folders/${F}`,
    `https://drive.google.com@evil.com/drive/folders/${F}`,
    `https://user:pw@drive.google.com/drive/folders/${F}`,
    `https://drive.google.com:8443/drive/folders/${F}`,
    `https://drive.google.com./drive/folders/${F}`,
    `https://drive.google.com\\@evil.com/drive/folders/${F}`,
    `https://xn--drive-google-com.evil/drive/folders/${F}`,
    "https://drive.google.com/drive/my-drive",
    "https://drive.google.com/drive/shared-drives",
    "https://drive.google.com/drive/folders/",
    "https://drive.google.com/drive/folders/short",
    `https://drive.google.com/drive/folders/${F}"><script>`,
    `https://docs.google.com/document/d/${D}%22onload=x/edit`,
    `https://docs.google.com/document/d/${"a".repeat(129)}/edit`,
    "https://forms.gle/abc123def456",
    `https://sites.google.com/view/${F}`,
    `https://docs.google.com/script/d/${D}/edit`,
    `https://script.google.com/d/${D}/edit`,
    `https://docs.google.com/document/${D}/edit`,
    `https://drive.google.com/open/extra?id=${F}`,
    `https://drive.google.com/drive/folders/${F}${"x".repeat(2100)}`,
  ]) {
    assert.equal(p(u as any), null, String(u));
  }
});

test("linkFromRow re-validates stored rows", () => {
  const ok = linkFromRow({ kind: "sheet", google_id: D, resource_key: null, published: false, gid: "9" });
  assert.deepEqual(ok, { kind: "sheet", id: D, resourceKey: null, published: false, gid: "9" });
  // gid is dropped on non-sheets.
  assert.equal(linkFromRow({ kind: "doc", google_id: D, gid: "9" })?.gid, null);
  assert.equal(linkFromRow({ kind: "doc", google_id: "x" }), null);
  assert.equal(linkFromRow({ kind: "document", google_id: D }), null);
  assert.equal(linkFromRow({ kind: "doc", google_id: `${D}/../x` }), null);
  assert.equal(linkFromRow({ kind: "file", google_id: F, resource_key: "a b" }), null);
  assert.equal(linkFromRow({ kind: "folder", google_id: F, published: true }), null);
  assert.equal(linkFromRow({ kind: "doc", google_id: D, gid: "1;x" }), null);
  // Round trip: what the parser produces, a stored row rebuilds exactly.
  const parsed = p(`https://drive.google.com/drive/folders/${F}?resourcekey=0-k`)!;
  assert.deepEqual(
    linkFromRow({
      kind: parsed.kind,
      google_id: parsed.id,
      resource_key: parsed.resourceKey,
      published: parsed.published,
      gid: parsed.gid,
    }),
    parsed,
  );
});

test("every derived URL stays on Google's hosts", () => {
  const inputs = [
    `https://drive.google.com/drive/folders/${F}?resourcekey=0-k`,
    `https://drive.google.com/file/d/${F}/view`,
    `https://docs.google.com/document/d/${D}/edit`,
    `https://docs.google.com/spreadsheets/d/${D}/edit#gid=3`,
    `https://docs.google.com/presentation/d/${D}/edit`,
    `https://docs.google.com/forms/d/e/1FAIpQLSf${D}/viewform`,
    `https://docs.google.com/drawings/d/e/2PACX-${D}/pub`,
  ];
  for (const raw of inputs) {
    const l = p(raw)!;
    for (const url of [openUrl(l), embedUrl(l), embedUrl(l, "list")]) {
      const u = new URL(url);
      assert.equal(u.protocol, "https:", url);
      assert.ok(["drive.google.com", "docs.google.com"].includes(u.hostname), url);
    }
  }
});

test("cleanTitle", () => {
  assert.equal(cleanTitle("  Pitch   deck\n v2 ", "x"), "Pitch deck v2");
  assert.equal(cleanTitle("", "Google Doc"), "Google Doc");
  assert.equal(cleanTitle(null, "Google Doc"), "Google Doc");
  assert.equal(cleanTitle("\u202eevil\u0000", "x"), "evil");
  assert.equal(cleanTitle("a".repeat(500), "x").length, 120);
});

test("safeHttpsUrl", () => {
  assert.equal(safeHttpsUrl("https://pitch.com/deck"), "https://pitch.com/deck");
  assert.equal(safeHttpsUrl(" https://example.com "), "https://example.com/");
  for (const bad of [
    "http://example.com",
    "javascript:alert(1)",
    "https://u:p@example.com",
    "example.com",
    "",
    null,
    `https://example.com/${"x".repeat(2100)}`,
  ]) {
    assert.equal(safeHttpsUrl(bad as any), null, String(bad));
  }
});

test("pitchPreview: Google, YouTube, Loom; nothing else", () => {
  assert.deepEqual(pitchPreview(`https://docs.google.com/presentation/d/${D}/edit`), {
    provider: "google",
    src: `https://docs.google.com/presentation/d/${D}/embed?start=false&loop=false&delayms=60000`,
  });
  assert.equal(pitchPreview(`https://drive.google.com/file/d/${F}/view`)?.src, `https://drive.google.com/file/d/${F}/preview`);
  for (const yt of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?t=3",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share",
    "https://youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
  ]) {
    assert.deepEqual(
      pitchPreview(yt),
      { provider: "youtube", src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" },
      yt,
    );
  }
  assert.deepEqual(pitchPreview("https://www.loom.com/share/0123456789abcdef0123456789abcdef"), {
    provider: "loom",
    src: "https://www.loom.com/embed/0123456789abcdef0123456789abcdef",
  });
  for (const bad of [
    "https://evil.com/?youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=short",
    "https://www.loom.com/share/../x",
    "https://vimeo.com/123456",
    "https://pitch.com/deck",
  ]) {
    assert.equal(pitchPreview(bad), null, bad);
  }
});
