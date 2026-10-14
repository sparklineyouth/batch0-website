import { test } from "node:test";
import assert from "node:assert/strict";
import { insetBoxes, planStage, presentationBoxes, tileBoxes, type Box } from "./recording-layout.ts";

// Run with `npm test`.

function inside(b: Box, w: number, h: number) {
  return b.x >= 0 && b.y >= 0 && b.x + b.w <= w && b.y + b.h <= h && b.w > 0 && b.h > 0;
}

function overlaps(a: Box, b: Box) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

test("two people split the frame into equal halves, edge to edge", () => {
  assert.deepEqual(tileBoxes(2, 1280, 720), [
    { x: 0, y: 0, w: 640, h: 720 },
    { x: 640, y: 0, w: 640, h: 720 },
  ]);
  assert.deepEqual(tileBoxes(1, 1280, 720), [{ x: 0, y: 0, w: 1280, h: 720 }]);
});

test("uneven splits leave no seam and no overlap", () => {
  const boxes = tileBoxes(3, 1280, 720);
  assert.equal(boxes.reduce((s, b) => s + b.w, 0), 1280);
  for (let i = 1; i < boxes.length; i++) {
    assert.equal(boxes[i].x, boxes[i - 1].x + boxes[i - 1].w);
  }
});

test("insets stay in frame, 16:9, and never overlap each other", () => {
  for (const n of [1, 2, 3, 6]) {
    const boxes = insetBoxes(n, 1280, 720);
    assert.equal(boxes.length, n);
    for (const b of boxes) {
      assert.ok(inside(b, 1280, 720), `n=${n} ${JSON.stringify(b)}`);
      assert.ok(Math.abs(b.w / b.h - 16 / 9) < 0.02, `n=${n} aspect`);
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        assert.equal(overlaps(boxes[i], boxes[j]), false, `n=${n} ${i}/${j}`);
      }
    }
  }
});

test("faces sit beside a presentation, never on it", () => {
  for (const [w, h] of [[1280, 720], [1920, 1080], [640, 360]]) {
    for (const n of [1, 2, 3, 4, 5, 8, 12]) {
      const { screen, faces } = presentationBoxes(n, w, h);
      assert.equal(faces.length, n);
      assert.ok(inside(screen, w, h), `${w} screen`);
      // A 16:9 slide keeps most of the frame.
      assert.ok(screen.w >= w * 0.78 && screen.h === h, `${w} screen ${JSON.stringify(screen)}`);
      for (const f of faces) {
        assert.ok(inside(f, w, h), `${w} n=${n} ${JSON.stringify(f)}`);
        assert.equal(overlaps(f, screen), false, `${w} n=${n} face on the screen`);
        assert.ok(Math.abs(f.w / f.h - 16 / 9) < 0.05, `${w} n=${n} aspect`);
      }
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          assert.equal(overlaps(faces[i], faces[j]), false, `${w} n=${n} ${i}/${j}`);
        }
      }
    }
  }
  // A few faces are a filmstrip-sized column, centred.
  const { faces } = presentationBoxes(2, 1280, 720);
  assert.deepEqual(faces, [
    { x: 1024, y: 221, w: 240, h: 135 },
    { x: 1024, y: 364, w: 240, h: 135 },
  ]);
});

const W = 1280;
const H = 720;
const nobody = { mainId: null, mainIsPresentation: false };

test("a 1:1 with nobody presenting is side by side", () => {
  const plan = planStage([{ id: "a", presenting: false }, { id: "b", presenting: false }], nobody, W, H);
  assert.equal(plan.kind, "grid");
  if (plan.kind === "grid") assert.deepEqual(plan.tiles.map((t) => t.id), ["a", "b"]);
});

test("the stage's presentation takes the frame beside every face", () => {
  const people = [
    { id: "host", presenting: true },
    { id: "guest", presenting: true },
    { id: "cohost", presenting: false },
  ];
  const plan = planStage(people, { mainId: "guest", mainIsPresentation: true }, W, H);
  assert.equal(plan.kind, "presentation");
  if (plan.kind === "presentation") {
    assert.equal(plan.presenter, "guest");
    const boxes = presentationBoxes(3, W, H);
    assert.deepEqual(plan.screen, boxes.screen);
    assert.deepEqual(plan.insets.map((i) => i.id), ["host", "guest", "cohost"]);
    for (const i of plan.insets) assert.equal(overlaps(i.box, plan.screen), false);
  }
});

test("a share the stage doesn't name yet still wins over cameras", () => {
  // Mid-take screen share: the room's layout lags a render, or the old room
  // passes no main at all.
  const plan = planStage(
    [{ id: "a", presenting: false }, { id: "b", presenting: true }],
    { mainId: "a", mainIsPresentation: false },
    W,
    H,
  );
  assert.equal(plan.kind, "presentation");
  if (plan.kind === "presentation") assert.equal(plan.presenter, "b");
});

test("a named presentation with no frames yet falls back, never to a blank frame", () => {
  const plan = planStage(
    [{ id: "a", presenting: false }, { id: "b", presenting: false }],
    { mainId: "b", mainIsPresentation: true },
    W,
    H,
  );
  assert.equal(plan.kind, "grid");
});

test("the primary host's camera fills the frame; co-hosts are insets", () => {
  const plan = planStage(
    [{ id: "me", presenting: false }, { id: "primary", presenting: false }, { id: "co", presenting: false }],
    { mainId: "primary", mainIsPresentation: false },
    W,
    H,
  );
  assert.equal(plan.kind, "speaker");
  if (plan.kind === "speaker") {
    assert.equal(plan.main, "primary");
    assert.deepEqual(plan.insets.map((i) => i.id), ["me", "co"]);
  }
  // Alone on stage: just the frame.
  assert.equal(planStage([{ id: "me", presenting: false }], { mainId: "me", mainIsPresentation: false }, W, H).kind, "grid");
  // A main the recorder doesn't have (someone who left): the grid.
  assert.equal(
    planStage([{ id: "a", presenting: false }, { id: "b", presenting: false }], { mainId: "gone", mainIsPresentation: false }, W, H).kind,
    "grid",
  );
});
