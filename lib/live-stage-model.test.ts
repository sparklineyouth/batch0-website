import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cameraKey,
  computeStage,
  gridShape,
  pickPresenter,
  presentationKey,
  sharedLayout,
  type StageInput,
  type StagePerson,
} from "../components/live/room/stage-model.ts";

const person = (
  id: string,
  extra: Partial<StagePerson> = {},
): StagePerson => ({
  id,
  name: id.toUpperCase(),
  isSelf: false,
  camera: true,
  presenting: null,
  presentingSince: null,
  ...extra,
});
const me = (extra: Partial<StagePerson> = {}) => person("me", { isSelf: true, ...extra });

const stage = (input: Partial<StageInput> & { people: StagePerson[] }) =>
  computeStage({ kind: "webinar", primaryId: null, localPin: null, ...input });

const keys = (tiles: { key: string }[]) => tiles.map((t) => t.key);

// ── Empty ───────────────────────────────────────────────────────────────────

test("nobody on stage is an empty layout", () => {
  const m = stage({ people: [] });
  assert.equal(m.layout, "empty");
  assert.equal(m.main, null);
  assert.deepEqual(m.filmstrip, []);
  assert.equal(m.pip, null);
  assert.equal(m.presenter, null);
  assert.equal(m.why, "empty");
});

test("a stale local pin on an empty stage is dropped", () => {
  const m = stage({ people: [], localPin: cameraKey("ana") });
  assert.equal(m.pinned, null);
  assert.equal(m.main, null);
});

// ── Webinar: primary host ───────────────────────────────────────────────────

test("webinar viewer sees the primary host's camera, other hosts in the filmstrip", () => {
  const m = stage({
    people: [person("ben"), person("ana"), person("cy")],
    primaryId: "ana",
  });
  assert.equal(m.layout, "spotlight");
  assert.equal(m.main?.key, cameraKey("ana"));
  assert.equal(m.main?.isPrimary, true);
  assert.equal(m.why, "primary");
  assert.deepEqual(keys(m.filmstrip), [cameraKey("ben"), cameraKey("cy")]);
  assert.equal(m.pip, null);
});

test("the primary host stays on stage with their camera off (initials, not a jump)", () => {
  const m = stage({
    people: [person("ben"), person("ana", { camera: false })],
    primaryId: "ana",
  });
  assert.equal(m.main?.key, cameraKey("ana"));
});

test("no primary yet: the first host with a camera, in join order", () => {
  const m = stage({
    people: [person("ben", { camera: false }), person("ana"), person("cy")],
  });
  assert.equal(m.main?.key, cameraKey("ana"));
  assert.equal(m.why, "host");
  assert.deepEqual(keys(m.filmstrip), [cameraKey("ben"), cameraKey("cy")]);
});

test("no primary and no cameras: the first host", () => {
  const m = stage({
    people: [person("ben", { camera: false }), person("ana", { camera: false })],
  });
  assert.equal(m.main?.key, cameraKey("ben"));
});

test("a primary who is not on stage falls back to another host", () => {
  const m = stage({ people: [person("ben")], primaryId: "ana" });
  assert.equal(m.main?.key, cameraKey("ben"));
  assert.equal(m.why, "host");
});

test("the primary host sees their own camera on stage when they are primary", () => {
  const m = stage({ people: [me(), person("ben")], primaryId: "me" });
  assert.equal(m.main?.key, cameraKey("me"));
  assert.equal(m.main?.isSelf, true);
  assert.deepEqual(keys(m.filmstrip), [cameraKey("ben")]);
});

test("a co-host sees the primary on stage and themselves last in the filmstrip", () => {
  const m = stage({
    people: [me(), person("ana"), person("ben")],
    primaryId: "ana",
  });
  assert.equal(m.main?.key, cameraKey("ana"));
  assert.deepEqual(keys(m.filmstrip), [cameraKey("ben"), cameraKey("me")]);
});

test("a host alone sees themselves", () => {
  const m = stage({ people: [me()] });
  assert.equal(m.main?.key, cameraKey("me"));
  assert.deepEqual(m.filmstrip, []);
});

test("primaryId is ignored in calls", () => {
  const m = stage({
    kind: "call",
    people: [me(), person("ana")],
    primaryId: "me",
  });
  assert.equal(m.main?.key, cameraKey("ana"));
  assert.equal(m.main?.isPrimary, false);
});

test("the primary flag rides on the primary's camera tile in the filmstrip too", () => {
  const m = stage({
    people: [person("ana"), person("ben", { presenting: "screen", presentingSince: 5 })],
    primaryId: "ana",
  });
  const ana = m.filmstrip.find((t) => t.key === cameraKey("ana"));
  assert.equal(ana?.isPrimary, true);
});

// ── Presentations ───────────────────────────────────────────────────────────

test("a presentation beats the primary host's camera", () => {
  const m = stage({
    people: [person("ana"), person("ben", { presenting: "screen", presentingSince: 10 })],
    primaryId: "ana",
  });
  assert.equal(m.layout, "presentation");
  assert.equal(m.main?.key, presentationKey("ben"));
  assert.equal(m.main?.kind, "presentation");
  assert.equal(m.why, "presentation");
  assert.deepEqual(m.presenter, { peerId: "ben", name: "BEN", isSelf: false, kind: "screen" });
  // The presenter's camera sits first, then the primary.
  assert.deepEqual(keys(m.filmstrip), [cameraKey("ben"), cameraKey("ana")]);
});

test("several presenting: the primary's presentation wins over a more recent one", () => {
  const m = stage({
    people: [
      person("ana", { presenting: "screen", presentingSince: 1 }),
      person("ben", { presenting: "screen", presentingSince: 99 }),
    ],
    primaryId: "ana",
  });
  assert.equal(m.main?.key, presentationKey("ana"));
  // The other presentation stays reachable in the filmstrip, first.
  assert.deepEqual(keys(m.filmstrip), [
    presentationKey("ben"),
    cameraKey("ana"),
    cameraKey("ben"),
  ]);
});

test("several presenting without the primary: the most recent wins", () => {
  const m = stage({
    people: [
      person("ana", { presenting: "screen", presentingSince: 1 }),
      person("ben", { presenting: "screen", presentingSince: 99 }),
      person("cy"),
    ],
    primaryId: "cy",
  });
  assert.equal(m.main?.key, presentationKey("ben"));
  assert.deepEqual(keys(m.filmstrip), [
    presentationKey("ana"),
    cameraKey("ben"),
    cameraKey("cy"),
    cameraKey("ana"),
  ]);
});

test("presenters with no start time tie-break by join order", () => {
  const winner = pickPresenter(
    [
      person("ana", { presenting: "screen" }),
      person("ben", { presenting: "screen" }),
    ],
    null,
  );
  assert.equal(winner?.id, "ana");
});

test("pickPresenter is null when nobody presents", () => {
  assert.equal(pickPresenter([person("ana")], "ana"), null);
});

test("the presenter sees the deck presenter view, never a mirror", () => {
  const m = stage({
    people: [me({ presenting: "deck", presentingSince: 3 }), person("ana")],
    primaryId: "ana",
  });
  assert.equal(m.main?.key, presentationKey("me"));
  assert.equal(m.selfView, "deck");
  assert.equal(m.presenter?.isSelf, true);
  assert.deepEqual(keys(m.filmstrip), [cameraKey("ana"), cameraKey("me")]);
});

test("a screen-sharing presenter gets the 'You're presenting' view", () => {
  const m = stage({ kind: "call", people: [me({ presenting: "screen", presentingSince: 1 }), person("ana")] });
  assert.equal(m.selfView, "screen");
  assert.equal(m.pip, null);
  assert.deepEqual(keys(m.filmstrip), [cameraKey("ana"), cameraKey("me")]);
});

test("someone else's newer presentation takes the stage from mine", () => {
  const m = stage({
    people: [
      me({ presenting: "screen", presentingSince: 1 }),
      person("ana", { presenting: "screen", presentingSince: 2 }),
    ],
  });
  assert.equal(m.main?.key, presentationKey("ana"));
  assert.equal(m.selfView, null);
  assert.equal(m.filmstrip[0].key, presentationKey("me"));
  assert.equal(m.filmstrip[0].isSelf, true);
});

test("a remote's presentation in a 2-person call is the main stage, no PiP", () => {
  const m = stage({
    kind: "call",
    people: [me(), person("ana", { presenting: "screen", presentingSince: 1 })],
  });
  assert.equal(m.layout, "presentation");
  assert.equal(m.main?.key, presentationKey("ana"));
  assert.equal(m.pip, null);
  assert.deepEqual(keys(m.filmstrip), [cameraKey("ana"), cameraKey("me")]);
});

test("a presentation beats the grid in a 3+ call", () => {
  const m = stage({
    kind: "call",
    people: [me(), person("ana"), person("ben", { presenting: "screen", presentingSince: 4 })],
  });
  assert.equal(m.layout, "presentation");
  assert.equal(m.main?.key, presentationKey("ben"));
  assert.deepEqual(m.grid, []);
  assert.deepEqual(keys(m.filmstrip), [cameraKey("ben"), cameraKey("ana"), cameraKey("me")]);
});

// ── Local pin ───────────────────────────────────────────────────────────────

test("a local pin beats a presentation, which moves to the front of the filmstrip", () => {
  const m = stage({
    people: [person("ana"), person("ben", { presenting: "screen", presentingSince: 1 })],
    primaryId: "ana",
    localPin: cameraKey("ana"),
  });
  assert.equal(m.main?.key, cameraKey("ana"));
  assert.equal(m.layout, "spotlight");
  assert.equal(m.pinned, cameraKey("ana"));
  assert.equal(m.why, "pin");
  // Everyone else still knows who is presenting.
  assert.equal(m.presenter?.peerId, "ben");
  assert.deepEqual(keys(m.filmstrip), [presentationKey("ben"), cameraKey("ben")]);
});

test("pinning a presentation makes it main even when another presentation would win", () => {
  const m = stage({
    people: [
      person("ana", { presenting: "screen", presentingSince: 1 }),
      person("ben", { presenting: "screen", presentingSince: 2 }),
    ],
    localPin: presentationKey("ana"),
  });
  assert.equal(m.main?.key, presentationKey("ana"));
  assert.equal(m.layout, "presentation");
  assert.equal(m.presenter?.peerId, "ben");
});

test("a pin on a tile that no longer exists is ignored", () => {
  const m = stage({
    people: [person("ana")],
    localPin: presentationKey("ana"),
  });
  assert.equal(m.pinned, null);
  assert.equal(m.main?.key, cameraKey("ana"));
  assert.equal(m.why, "host");
});

test("pinning yourself in a 2-person call shows you big and drops the PiP", () => {
  const m = stage({ kind: "call", people: [me(), person("ana")], localPin: cameraKey("me") });
  assert.equal(m.main?.key, cameraKey("me"));
  assert.equal(m.pip, null);
  assert.deepEqual(keys(m.filmstrip), [cameraKey("ana")]);
});

test("pinning the other person in a 2-person call keeps the PiP", () => {
  const m = stage({ kind: "call", people: [me(), person("ana")], localPin: cameraKey("ana") });
  assert.equal(m.main?.key, cameraKey("ana"));
  assert.equal(m.pip?.key, cameraKey("me"));
  assert.deepEqual(m.filmstrip, []);
});

test("pinning in a 3+ call leaves the grid for a spotlight", () => {
  const m = stage({
    kind: "call",
    people: [me(), person("ana"), person("ben")],
    localPin: cameraKey("ben"),
  });
  assert.equal(m.layout, "spotlight");
  assert.equal(m.main?.key, cameraKey("ben"));
  assert.equal(m.pip, null);
  assert.deepEqual(keys(m.filmstrip), [cameraKey("ana"), cameraKey("me")]);
});

test("pinning your own presentation shows your presenter view", () => {
  const m = stage({
    people: [
      me({ presenting: "deck", presentingSince: 1 }),
      person("ana", { presenting: "screen", presentingSince: 2 }),
    ],
    localPin: presentationKey("me"),
  });
  assert.equal(m.selfView, "deck");
});

// ── Calls ───────────────────────────────────────────────────────────────────

test("alone in a call: yourself on stage", () => {
  const m = stage({ kind: "call", people: [me()] });
  assert.equal(m.layout, "spotlight");
  assert.equal(m.main?.key, cameraKey("me"));
  assert.equal(m.why, "alone");
  assert.equal(m.pip, null);
});

test("2-person call: the other person on stage, self as PiP, empty filmstrip", () => {
  const m = stage({ kind: "call", people: [me(), person("ana")] });
  assert.equal(m.main?.key, cameraKey("ana"));
  assert.equal(m.why, "other");
  assert.equal(m.pip?.key, cameraKey("me"));
  assert.equal(m.pip?.isSelf, true);
  assert.deepEqual(m.filmstrip, []);
});

test("3+ call: an equal grid, others in join order, self last", () => {
  const m = stage({ kind: "call", people: [person("ana"), me(), person("ben"), person("cy")] });
  assert.equal(m.layout, "grid");
  assert.equal(m.main, null);
  assert.deepEqual(keys(m.grid), [cameraKey("ana"), cameraKey("ben"), cameraKey("cy"), cameraKey("me")]);
  assert.deepEqual(m.filmstrip, []);
  assert.equal(m.pip, null);
});

test("a webinar never grids, however many hosts", () => {
  const m = stage({ people: [me(), person("ana"), person("ben"), person("cy")] });
  assert.equal(m.layout, "spotlight");
  assert.equal(m.grid.length, 0);
});

test("a webinar never gets a PiP", () => {
  const m = stage({ people: [me(), person("ana")], primaryId: "ana" });
  assert.equal(m.pip, null);
  assert.deepEqual(keys(m.filmstrip), [cameraKey("me")]);
});

test("every tile appears exactly once across main, pip, grid and filmstrip", () => {
  const people = [
    me({ presenting: "deck", presentingSince: 5 }),
    person("ana", { presenting: "screen", presentingSince: 3 }),
    person("ben"),
    person("cy", { camera: false }),
  ];
  for (const kind of ["webinar", "call"] as const) {
    for (const localPin of [null, cameraKey("ben"), presentationKey("ana"), cameraKey("me")]) {
      const m = stage({ kind, people, primaryId: "ben", localPin });
      const all = [
        ...(m.main ? [m.main.key] : []),
        ...(m.pip ? [m.pip.key] : []),
        ...keys(m.grid),
        ...keys(m.filmstrip),
      ];
      assert.equal(new Set(all).size, all.length, `${kind} ${localPin}: duplicate`);
      assert.equal(all.length, 6, `${kind} ${localPin}: 4 cameras + 2 presentations`);
    }
  }
});

// ── Shared layout (recording) ───────────────────────────────────────────────

test("sharedLayout ignores local pins and reports the presentation", () => {
  const people = [person("ana"), person("ben", { presenting: "screen", presentingSince: 1 })];
  assert.deepEqual(sharedLayout({ kind: "webinar", people, primaryId: "ana" }), {
    mainId: "ben",
    mainIsPresentation: true,
  });
  assert.deepEqual(sharedLayout({ kind: "webinar", people: [person("ana")], primaryId: "ana" }), {
    mainId: "ana",
    mainIsPresentation: false,
  });
  assert.deepEqual(sharedLayout({ kind: "call", people: [], primaryId: null }), {
    mainId: null,
    mainIsPresentation: false,
  });
  assert.deepEqual(
    sharedLayout({ kind: "call", people: [me(), person("ana"), person("ben")], primaryId: null }),
    { mainId: null, mainIsPresentation: false },
  );
});

// ── Grid shape ──────────────────────────────────────────────────────────────

test("gridShape: landscape picks the arrangement with the biggest 16:9 tiles", () => {
  const four = gridShape(4, 1600, 900, 0);
  assert.deepEqual([four.cols, four.rows], [2, 2]);
  const wide = gridShape(3, 1600, 500, 0);
  assert.equal(wide.cols, 3);
  const six = gridShape(6, 1200, 700, 8);
  assert.ok(six.cols * six.rows >= 6);
  assert.ok(six.tileWidth > 0 && Math.abs(six.tileWidth / six.tileHeight - 16 / 9) < 1e-9);
  // Tiles always fit the box.
  assert.ok(six.cols * six.tileWidth + (six.cols - 1) * 8 <= 1200 + 1e-9);
  assert.ok(six.rows * six.tileHeight + (six.rows - 1) * 8 <= 700 + 1e-9);
});

test("gridShape: portrait fills the box with near-square cells", () => {
  const four = gridShape(4, 390, 700, 8);
  assert.deepEqual([four.cols, four.rows], [2, 2]);
  assert.equal(four.tileWidth, (390 - 8) / 2);
  assert.equal(four.tileHeight, (700 - 8) / 2);
  const five = gridShape(5, 374, 640, 8);
  assert.deepEqual([five.cols, five.rows], [2, 3]);
  const three = gridShape(3, 374, 640, 8);
  assert.equal(three.cols * three.rows >= 3, true);
  assert.ok(three.tileWidth * three.cols <= 374);
});

test("gridShape handles empty boxes and counts", () => {
  assert.deepEqual(gridShape(0, 100, 100), { cols: 1, rows: 1, tileWidth: 0, tileHeight: 0 });
  assert.deepEqual(gridShape(3, 0, 100), { cols: 1, rows: 1, tileWidth: 0, tileHeight: 0 });
});
