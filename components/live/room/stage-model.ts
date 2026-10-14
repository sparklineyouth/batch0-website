/**
 * Who is on the main stage, who is in the filmstrip, and what a presenter sees.
 *
 * Pure and import-free so it runs under `node --test` (lib/live-stage-model.test.ts).
 * The room view calls it with the viewer's local pin; the recorder calls it with
 * `localPin: null` (see `sharedLayout`) so a recording matches what the room sees,
 * not one host's private pin.
 *
 * Main-stage priority:
 *   1. the viewer's local pin (any tile);
 *   2. a presentation (screen share or slide deck) — the primary host's if they
 *      present, else the most recent;
 *   3. webinar: the primary host's camera (fallback: the first host on stage);
 *   4. call with two people: the other person, self as a picture-in-picture;
 *   5. call with three or more: an equal grid.
 */

export type StageKind = "webinar" | "call";
export type PresentingKind = "screen" | "deck";
export type TileKind = "camera" | "presentation";

/** One person on stage: self (when broadcasting) or a remote whose link is live or recovering. */
export type StagePerson = {
  id: string;
  name: string;
  isSelf: boolean;
  /** Has a camera picture right now. A tile without one shows initials. */
  camera: boolean;
  /** Presenting. Remote presentations arrive as "screen": the wire can't tell a deck from a share. */
  presenting: PresentingKind | null;
  /** When the presentation started (epoch ms). Most recent wins when several present. */
  presentingSince: number | null;
};

export type StageInput = {
  kind: StageKind;
  /** Everyone on stage, in a stable order (join order). */
  people: readonly StagePerson[];
  /** Webinar primary host (pinned for everyone). Ignored for calls. */
  primaryId: string | null;
  /** Tile key this viewer pinned for themselves, if any. */
  localPin: string | null;
};

export type StageTile = {
  key: string;
  peerId: string;
  kind: TileKind;
  isSelf: boolean;
  name: string;
  /** The webinar primary host's camera. */
  isPrimary: boolean;
  /** For presentation tiles: what is being presented. */
  presenting: PresentingKind | null;
};

export type StageLayout = "empty" | "spotlight" | "presentation" | "grid";

export type StageReason =
  | "empty"
  | "pin"
  | "presentation"
  | "primary"
  | "host"
  | "other"
  | "alone"
  | "grid";

export type StageModel = {
  layout: StageLayout;
  /** The big tile. Null in grid and empty layouts. */
  main: StageTile | null;
  /** Grid layout only: every camera, equal size. */
  grid: StageTile[];
  /** Everyone not on the main stage (and not the PiP), in display order. */
  filmstrip: StageTile[];
  /** Self as a small picture-in-picture: two-person calls only. */
  pip: StageTile | null;
  /** The local pin, when it still points at a tile that exists. */
  pinned: string | null;
  /** The presentation everyone is shown (ignores the local pin). */
  presenter: { peerId: string; name: string; isSelf: boolean; kind: PresentingKind } | null;
  /** Self's own presentation is the main tile: show the presenter view, never a mirror. */
  selfView: PresentingKind | null;
  why: StageReason;
};

export const cameraKey = (peerId: string) => `cam:${peerId}`;
export const presentationKey = (peerId: string) => `pres:${peerId}`;

/** The presentation that wins: the primary's if they present, else the most recent (ties: earlier in the list). */
export function pickPresenter(
  people: readonly StagePerson[],
  primaryId: string | null,
): StagePerson | null {
  const presenting = people.filter((p) => p.presenting);
  if (presenting.length === 0) return null;
  if (primaryId) {
    const primary = presenting.find((p) => p.id === primaryId);
    if (primary) return primary;
  }
  let best = presenting[0];
  for (const p of presenting) {
    if ((p.presentingSince ?? 0) > (best.presentingSince ?? 0)) best = p;
  }
  return best;
}

/** Webinar: the primary host if on stage, else the first host with a camera, else the first host, else self. */
function pickHost(people: readonly StagePerson[], primaryId: string | null): StagePerson | null {
  if (primaryId) {
    const primary = people.find((p) => p.id === primaryId);
    if (primary) return primary;
  }
  const others = people.filter((p) => !p.isSelf);
  return (
    others.find((p) => p.camera) ?? others[0] ?? people.find((p) => p.isSelf) ?? null
  );
}

export function computeStage(input: StageInput): StageModel {
  const { kind, people } = input;
  const primaryId = kind === "webinar" ? input.primaryId : null;
  const self = people.find((p) => p.isSelf) ?? null;

  const camTile = (p: StagePerson): StageTile => ({
    key: cameraKey(p.id),
    peerId: p.id,
    kind: "camera",
    isSelf: p.isSelf,
    name: p.name,
    isPrimary: p.id === primaryId,
    presenting: null,
  });
  const presTile = (p: StagePerson): StageTile => ({
    key: presentationKey(p.id),
    peerId: p.id,
    kind: "presentation",
    isSelf: p.isSelf,
    name: p.name,
    isPrimary: false,
    presenting: p.presenting,
  });

  const winner = pickPresenter(people, primaryId);
  const presenter = winner
    ? {
        peerId: winner.id,
        name: winner.name,
        isSelf: winner.isSelf,
        kind: winner.presenting as PresentingKind,
      }
    : null;

  if (people.length === 0) {
    return {
      layout: "empty",
      main: null,
      grid: [],
      filmstrip: [],
      pip: null,
      pinned: null,
      presenter: null,
      selfView: null,
      why: "empty",
    };
  }

  // Every tile that exists, in filmstrip order: presentations (most recent
  // first), then the main presenter's camera, the primary host, other people
  // in join order, self last.
  const presentations = people
    .filter((p) => p.presenting)
    .map((p, i) => ({ p, i }))
    .sort(
      (a, b) =>
        (b.p.presentingSince ?? 0) - (a.p.presentingSince ?? 0) || a.i - b.i,
    )
    .map(({ p }) => presTile(p));
  const cameraOrder: StagePerson[] = [];
  const pushCam = (p: StagePerson | null | undefined) => {
    if (p && !cameraOrder.includes(p)) cameraOrder.push(p);
  };
  if (winner && !winner.isSelf) pushCam(winner);
  if (primaryId) pushCam(people.find((p) => p.id === primaryId && !p.isSelf));
  for (const p of people) if (!p.isSelf) pushCam(p);
  pushCam(self);
  const all: StageTile[] = [...presentations, ...cameraOrder.map(camTile)];

  const pinTile = input.localPin
    ? all.find((t) => t.key === input.localPin) ?? null
    : null;

  let main: StageTile | null = null;
  let why: StageReason;
  if (pinTile) {
    main = pinTile;
    why = "pin";
  } else if (winner) {
    main = presTile(winner);
    why = "presentation";
  } else if (kind === "webinar") {
    const host = pickHost(people, primaryId);
    main = host ? camTile(host) : null;
    why = host && host.id === primaryId ? "primary" : "host";
  } else if (people.length >= 3) {
    return {
      layout: "grid",
      main: null,
      grid: cameraOrder.map(camTile),
      filmstrip: [],
      pip: null,
      pinned: null,
      presenter,
      selfView: null,
      why: "grid",
    };
  } else if (people.length === 2) {
    const other = people.find((p) => !p.isSelf) ?? people[0];
    main = camTile(other);
    why = "other";
  } else {
    main = camTile(people[0]);
    why = "alone";
  }

  // Self PiP: a two-person call whose main tile is the other person's camera.
  const pip =
    kind === "call" &&
    people.length === 2 &&
    self &&
    main &&
    main.kind === "camera" &&
    !main.isSelf
      ? camTile(self)
      : null;

  const filmstrip = all.filter(
    (t) => t.key !== main?.key && t.key !== pip?.key,
  );

  return {
    layout: main?.kind === "presentation" ? "presentation" : "spotlight",
    main,
    grid: [],
    filmstrip,
    pip,
    pinned: pinTile ? pinTile.key : null,
    presenter,
    selfView:
      main && main.kind === "presentation" && main.isSelf ? main.presenting : null,
    why,
  };
}

/** What the recorder composes: the room's shared view, never a local pin. */
export function sharedLayout(
  input: Omit<StageInput, "localPin">,
): { mainId: string | null; mainIsPresentation: boolean } {
  const model = computeStage({ ...input, localPin: null });
  if (model.main) {
    return { mainId: model.main.peerId, mainIsPresentation: model.main.kind === "presentation" };
  }
  return { mainId: null, mainIsPresentation: false };
}

/**
 * Columns × rows for an equal grid of `count` tiles in a `width` × `height` box.
 * Landscape boxes get 16:9 tiles, as big as they can be. Portrait boxes
 * (phones) fill the box instead, with cells as close to square as the count
 * allows — cameras are cropped to fit, as on a phone call.
 */
export function gridShape(
  count: number,
  width: number,
  height: number,
  gap = 8,
): { cols: number; rows: number; tileWidth: number; tileHeight: number } {
  if (count <= 0 || width <= 0 || height <= 0) {
    return { cols: 1, rows: 1, tileWidth: 0, tileHeight: 0 };
  }
  const portrait = height > width;
  let best = { cols: 1, rows: count, tileWidth: 0, tileHeight: 0 };
  let bestScore = -Infinity;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const cellW = (width - gap * (cols - 1)) / cols;
    const cellH = (height - gap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    if (portrait) {
      // Closest to square wins.
      const score = -Math.abs(Math.log(cellW / cellH));
      if (score > bestScore) {
        bestScore = score;
        best = { cols, rows, tileWidth: cellW, tileHeight: cellH };
      }
    } else {
      const tileWidth = Math.min(cellW, (cellH * 16) / 9);
      if (tileWidth > bestScore) {
        bestScore = tileWidth;
        best = { cols, rows, tileWidth, tileHeight: (tileWidth * 9) / 16 };
      }
    }
  }
  return best;
}
