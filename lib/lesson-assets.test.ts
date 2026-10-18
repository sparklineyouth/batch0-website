import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MATERIAL_URL_TTL_SECONDS,
  findMaterial,
  formatPlayhead,
  latestSavedSeconds,
  lessonMaterialHref,
  lessonMaterials,
  lessonVideoHref,
  materialProblem,
  resumePosition,
  shouldSavePosition,
} from "./lesson-assets.ts";

// Run with `npm test`.

test("reopening a lesson picks up at the saved second", () => {
  assert.equal(resumePosition(272, 1800), 272);
  // Before the player knows the length (or a lesson with none recorded).
  assert.equal(resumePosition(272, null), 272);
  assert.equal(resumePosition(272, NaN), 272);
  assert.equal(resumePosition(272, Infinity), 272);
  assert.equal(resumePosition(272.9, 1800), 272);
});

test("…but not a few seconds in, and not at the credits", () => {
  assert.equal(resumePosition(null, 1800), 0);
  assert.equal(resumePosition(undefined), 0);
  assert.equal(resumePosition(0, 1800), 0);
  assert.equal(resumePosition(4, 1800), 0);
  assert.equal(resumePosition(5, 1800), 5);
  // 30-minute video: the last 5% (90 s) counts as finished.
  assert.equal(resumePosition(1709, 1800), 1709);
  assert.equal(resumePosition(1710, 1800), 0);
  assert.equal(resumePosition(1799, 1800), 0);
  // 3-minute video: the last 15 s.
  assert.equal(resumePosition(164, 180), 164);
  assert.equal(resumePosition(165, 180), 0);
  // A clip shorter than the tail is always started over.
  assert.equal(resumePosition(6, 12), 0);
});

test("a saved spot past the end (the file was replaced by a shorter cut) starts over", () => {
  assert.equal(resumePosition(2400, 600), 0);
  assert.equal(resumePosition(-20, 600), 0);
  assert.equal(resumePosition(Number.NaN, 600), 0);
});

test("the playhead saves every 10 s of movement either way, and any change on pause or exit", () => {
  assert.equal(shouldSavePosition(9, 0), false);
  assert.equal(shouldSavePosition(10, 0), true);
  // Rewinding to rewatch is a new place to resume from: the old rule only
  // ever saved forward, so a student who went back to 1:00 resumed at 5:00.
  assert.equal(shouldSavePosition(60, 300), true);
  assert.equal(shouldSavePosition(295, 300), false);
  assert.equal(shouldSavePosition(301, 300, true), true);
  assert.equal(shouldSavePosition(300.7, 300, true), false);
  assert.equal(shouldSavePosition(NaN, 300, true), false);
});

test("playhead labels", () => {
  assert.equal(formatPlayhead(0), "0:00");
  assert.equal(formatPlayhead(75), "1:15");
  assert.equal(formatPlayhead(599.9), "9:59");
  assert.equal(formatPlayhead(3725), "1:02:05");
  assert.equal(formatPlayhead(NaN), "0:00");
});

test("materials: the authored order, file entries only, titled", () => {
  const raw = [
    { title: "Worksheet", path: "w1/worksheet.pdf" },
    { title: "", path: "w1/slides.pdf" },
    { title: "Link only" },
    null,
    "nope",
    { title: "Blank path", path: "  " },
    { path: "w1/notes.md" },
  ];
  assert.deepEqual(lessonMaterials(raw), [
    { title: "Worksheet", path: "w1/worksheet.pdf" },
    { title: "w1/slides.pdf", path: "w1/slides.pdf" },
    { title: "w1/notes.md", path: "w1/notes.md" },
  ]);
  assert.deepEqual(lessonMaterials(null), []);
  assert.deepEqual(lessonMaterials({ path: "x" }), []);
});

test("a material link opens the file the lesson lists under that path, or nothing", () => {
  const raw = [
    { title: "A", path: "w1/a.pdf" },
    { title: "B", path: "w1/b.pdf" },
  ];
  assert.deepEqual(findMaterial(raw, "w1/b.pdf"), { title: "B", path: "w1/b.pdf" });
  // Reordered since the page loaded: still the clicked file.
  assert.deepEqual(findMaterial([...raw].reverse(), "w1/b.pdf"), { title: "B", path: "w1/b.pdf" });
  // Removed since, or never part of this lesson: not signed.
  assert.equal(findMaterial(raw, "w1/c.pdf"), null);
  assert.equal(findMaterial(raw, "other-cohort/secret.pdf"), null);
  assert.equal(findMaterial(raw, ""), null);
  assert.equal(findMaterial(raw, null), null);
});

test("links point at the signing routes, never at storage", () => {
  const id = "11111111-0000-4000-8000-000000000001";
  assert.equal(lessonVideoHref(id), `/dashboard/course/${id}/video`);
  const href = lessonMaterialHref(id, "week 1/Pitch & deck?.pdf");
  assert.equal(href, `/dashboard/course/${id}/materials?path=week%201%2FPitch%20%26%20deck%3F.pdf`);
  assert.equal(new URL(href, "https://batch0.org").searchParams.get("path"), "week 1/Pitch & deck?.pdf");
  assert.equal(materialProblem("missing"), "missing");
  assert.equal(materialProblem("unavailable"), "unavailable");
  assert.equal(materialProblem(["missing"]), null);
  assert.equal(materialProblem("<script>"), null);
});

test("the lesson page signs nothing at render; the routes sign at request time", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const page = read("app/dashboard/course/[lessonId]/page.tsx");
  // The old page minted ten-minute URLs into its HTML; a material clicked
  // after a long lesson was already dead.
  assert.doesNotMatch(page, /createSignedUrls?\(/);
  assert.doesNotMatch(page, /createAdminClient/);
  assert.match(page, /lessonMaterialHref\(/);
  assert.match(page, /lessonVideoHref\(/);
  // The saved second as saved: the hand-typed lessons.duration_seconds no
  // longer decides anything about resuming.
  assert.match(page, /savedSeconds=\{progress\?\.watched_seconds \?\? 0\}/);
  assert.doesNotMatch(page, /resumePosition|lesson\.duration_seconds/);

  const materials = read("app/dashboard/course/[lessonId]/materials/route.ts");
  // The lesson is read through the caller's RLS client, and only a path it
  // lists is signed — the same authorization as the page.
  assert.match(materials, /await createClient\(\)/);
  assert.match(materials, /\.from\("lessons"\)/);
  assert.match(materials, /findMaterial\(lesson\.materials, path\)/);
  assert.match(materials, /createSignedUrl\(material\.path, MATERIAL_URL_TTL_SECONDS\)/);
  assert.match(materials, /no-store/);
  // Failures stay on the host the click came from (the app subdomain has its
  // own session), unlike a NEXT_PUBLIC_SITE_URL redirect.
  assert.match(materials, /new URL\(to, req\.url\)/);
  assert.doesNotMatch(materials, /NEXT_PUBLIC_SITE_URL/);

  const video = read("app/dashboard/course/[lessonId]/video/route.ts");
  assert.match(video, /await createClient\(\)/);
  assert.match(video, /\.from\("lessons"\)/);
  assert.match(video, /createSignedUrl\(lesson\.video_path as string, VIDEO_URL_TTL_SECONDS\)/);
  assert.ok(MATERIAL_URL_TTL_SECONDS >= 60);
});

test("the saved second comes from the player's own read when it has one", () => {
  // Back to a lesson from the router cache: the page says 0, the database 600.
  assert.equal(latestSavedSeconds(0, 600), 600);
  // Rewound elsewhere since: the read wins either way.
  assert.equal(latestSavedSeconds(600, 120), 120);
  assert.equal(latestSavedSeconds(600, 0), 0);
  // The read failed or timed out: the page's.
  assert.equal(latestSavedSeconds(600, null), 600);
  assert.equal(latestSavedSeconds(null, null), 0);
  assert.equal(latestSavedSeconds(612.8, null), 612);
  assert.equal(latestSavedSeconds(Number.NaN, null), 0);
});

test("a resume skipped as finished doesn't then save 0 over the real position", () => {
  // 1190 s into a 1200 s file: inside the tail, so the video starts at 0…
  const at = resumePosition(1190, 1200);
  assert.equal(at, 0);
  // …and the player records 0 as "already saved", so hiding the tab without
  // touching the video writes nothing (it used to write 0 over 1190).
  assert.equal(shouldSavePosition(0, at, true), false);
  // Playing it again from the top does save, as a rewatch should.
  assert.equal(shouldSavePosition(10, at), true);
  // A hand-typed duration shorter than the file no longer zeroes a real
  // resume: the rules run against the file's own length.
  assert.equal(resumePosition(580, 647), 580);
});

test("the player seeks to the saved spot and recovers an expired source, even before hydration", () => {
  const player = readFileSync(new URL("../app/dashboard/course/[lessonId]/lesson-player.tsx", import.meta.url), "utf8");
  // Resume is decided against the real duration once the file is read…
  assert.match(player, /resumePosition\(pending\.at, v\.duration\)/);
  // …lands as the last-saved second (an untouched video writes nothing)…
  assert.match(player, /lastTimeRef\.current = at;\s*lastSavedRef\.current = at;/);
  // …and waits for the player's own read of lesson_progress (Back/Forward
  // replays the first visit's props), up to a timeout.
  assert.match(player, /\.from\("lesson_progress"\)\s*\.select\("watched_seconds"\)/);
  assert.match(player, /latestSavedSeconds\(savedSeconds, fromRead\)/);
  assert.match(player, /if \(!v \|\| pending\?\.kind !== "resume" \|\| !resumeReadRef\.current \|\| v\.readyState < 1\) return;/);
  assert.match(player, /RESUME_READ_TIMEOUT_MS/);
  // …and metadata or an error that arrived before the listeners did still counts.
  assert.match(player, /if \(v\.readyState >= 1\) onMeta\(\);/);
  assert.match(player, /if \(v\.error\) onError\(\);/);
  // A load in progress sits at 0: saving then would wipe the place being resumed.
  assert.match(player, /if \(pendingSeekRef\.current\) return;/);
  // Re-asking the route gets a fresh signature; a loop of failures stops and says so.
  assert.match(player, /setSrc\(`\$\{videoSrc\}\$\{sep\}r=\$\{now\}`\)/);
  assert.match(player, /MAX_RECOVERIES_IN_WINDOW/);
});
