/**
 * What the recording's 1280×720 frame shows: the same main stage the room
 * shows, so the file matches what people saw.
 *
 *   presentation  a shared screen or slide deck fills the frame (contain-fit,
 *                 never cropped); everyone's face is a small inset along the
 *                 bottom right
 *   speaker       one person's camera fills the frame (the webinar's primary
 *                 host), everyone else is an inset
 *   grid          equal columns, side by side — a 1:1 with nobody presenting
 *
 * The room says what is on its main stage (`mainId`, `mainIsPresentation`);
 * this picks the plan, falling back to anyone presenting, then the grid,
 * when the stage names something the recorder cannot draw yet (a screen
 * share whose first frame has not arrived).
 *
 * Pure and import-free; tested by lib/recording-layout.test.ts.
 */

export type Box = { x: number; y: number; w: number; h: number };

export type StagePerson = {
  id: string;
  /** Has a drawable screen share / deck. */
  presenting: boolean;
};

export type StageLayout = { mainId: string | null; mainIsPresentation: boolean };

export type StagePlan =
  | { kind: "presentation"; presenter: string; full: Box; insets: { id: string; box: Box }[] }
  | { kind: "speaker"; main: string; full: Box; insets: { id: string; box: Box }[] }
  | { kind: "grid"; tiles: { id: string; box: Box }[] };

export function planStage(
  people: readonly StagePerson[],
  layout: StageLayout,
  width: number,
  height: number,
): StagePlan {
  const full = { x: 0, y: 0, w: width, h: height };
  const named = people.find((p) => p.id === layout.mainId) ?? null;
  const presenter =
    (layout.mainIsPresentation && named?.presenting ? named : null) ??
    people.find((p) => p.presenting) ??
    null;
  if (presenter) {
    const boxes = insetBoxes(people.length, width, height);
    return {
      kind: "presentation",
      presenter: presenter.id,
      full,
      insets: people.map((p, i) => ({ id: p.id, box: boxes[i] })),
    };
  }
  if (named && !layout.mainIsPresentation && people.length > 1) {
    const others = people.filter((p) => p.id !== named.id);
    const boxes = insetBoxes(others.length, width, height);
    return {
      kind: "speaker",
      main: named.id,
      full,
      insets: others.map((p, i) => ({ id: p.id, box: boxes[i] })),
    };
  }
  const boxes = tileBoxes(people.length, width, height);
  return { kind: "grid", tiles: people.map((p, i) => ({ id: p.id, box: boxes[i] })) };
}

/**
 * Side by side, one column per person, the full height of the frame. Equal
 * columns: nobody in a 1:1 is the audience. Integer edges, the last column
 * taking any remainder, so there is never a seam of backdrop between tiles.
 */
export function tileBoxes(count: number, width: number, height: number): Box[] {
  const n = Math.max(1, Math.floor(count));
  const col = Math.floor(width / n);
  return Array.from({ length: n }, (_, i) => ({
    x: i * col,
    y: 0,
    w: i === n - 1 ? width - i * col : col,
    h: height,
  }));
}

/**
 * Small 16:9 insets along the bottom right, right to left, shrinking so any
 * number of people still fits inside the frame.
 */
export function insetBoxes(count: number, width: number, height: number): Box[] {
  const n = Math.max(1, Math.floor(count));
  const margin = Math.round(width * 0.01875); // 24px at 1280
  const gap = Math.round(margin / 2);
  const ideal = Math.round(width * 0.2); // 256px at 1280
  const fit = Math.floor((width - margin * 2 - gap * (n - 1)) / n);
  const w = Math.max(1, Math.min(ideal, fit));
  const h = Math.round((w * 9) / 16);
  return Array.from({ length: n }, (_, i) => ({
    x: width - margin - w - i * (w + gap),
    y: height - margin - h,
    w,
    h,
  }));
}
