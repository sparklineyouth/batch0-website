"use client";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { fitRect, looksLikePdf, Lru } from "../logic";
import { MAX_DECK_BYTES } from "@/lib/webinars";

/**
 * Renders a PDF deck to a 1920×1080 canvas and streams it.
 *
 * The canvas stream goes through the SAME screen slot a screen share uses, so
 * viewers and the recorder see slides with no protocol change. Pages render
 * lazily (current first, then neighbours, then whatever thumbnails are on
 * screen); rendered slides are cached as ImageBitmaps with a small cap so a
 * 300-page deck never holds more than a handful of full-size frames.
 *
 * Opening another deck while one is up loads and renders the new one first
 * and only then swaps it in, on the same canvas and stream: the track viewers
 * receive never ends, and a file that fails leaves the current deck as it was.
 *
 * The canvas is repainted on a worker timer (2 fps) as well as on every slide
 * change: a canvas stream only emits frames when painted, a viewer who joins
 * mid-slide needs a fresh keyframe, and a hidden tab's own timers are throttled.
 */

const DECK_WIDTH = 1920;
const DECK_HEIGHT = 1080;
const THUMB_WIDTH = 320;
const THUMB_HEIGHT = 180;
const SLIDE_CACHE = 5;
const THUMB_CACHE = 240;
const REDRAW_MS = 500;

export type DeckSource = { kind: "file"; file: File } | { kind: "url"; url: string; name: string };

export type DeckSnapshot = {
  /** "loading" only for the first deck; a replacement loads while this stays "ready". */
  status: "idle" | "loading" | "ready" | "error";
  name: string | null;
  /** 1-based. */
  page: number;
  count: number;
  /** The current page is drawn on the canvas. */
  drawn: boolean;
  /** Why the deck couldn't open (status "error"). */
  error: string | null;
  /** The current page couldn't be drawn; go(page) tries again. */
  pageError: string | null;
  /** A deck being opened, by name (the current one stays up meanwhile). */
  opening: string | null;
  /** Changes whenever another document is swapped in (thumbnails re-render). */
  deckId: number;
};

/** `error` null: a newer open() or close() took over. */
export type DeckOpenResult = { ok: true } | { ok: false; error: string | null };

type Pdfjs = typeof import("pdfjs-dist");

let pdfjsLoading: Promise<Pdfjs> | null = null;

/**
 * pdf.js, loaded on first use (client only). The legacy build runs on older
 * Safari/iPad too. Its worker is a webpack worker chunk, so parsing never
 * blocks the call's main thread.
 */
function loadPdfjs(): Promise<Pdfjs> {
  if (!pdfjsLoading) {
    pdfjsLoading = import("pdfjs-dist/legacy/build/pdf.min.mjs")
      .then((mod) => {
        const pdfjs = mod as unknown as Pdfjs;
        if (!pdfjs.GlobalWorkerOptions.workerPort && typeof Worker !== "undefined") {
          pdfjs.GlobalWorkerOptions.workerPort = new Worker(
            new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url),
            { type: "module" },
          );
        }
        return pdfjs;
      })
      .catch((e) => {
        pdfjsLoading = null;
        throw e;
      });
  }
  return pdfjsLoading;
}

/** A timer that keeps firing in a background tab: setInterval in a tiny worker, else on the page. */
function startTicker(ms: number, fn: () => void): () => void {
  try {
    const src = `let t=0;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const w = new Worker(url);
    w.onmessage = fn;
    w.postMessage(ms);
    return () => {
      w.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }
}

type Frame = ImageBitmap | HTMLCanvasElement;

function closeFrame(f: Frame) {
  if ("close" in f && typeof f.close === "function") f.close();
}

function friendlyError(e: unknown): string {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "TooBig") return `That PDF is too big (${MAX_DECK_BYTES / 1024 / 1024} MB max).`;
  if (name === "PasswordException") return "That PDF is password-protected.";
  if (name === "InvalidPDFException") return "That file isn't a PDF we can open.";
  if (name === "MissingPDFException" || name === "ResponseException" || name === "UnexpectedResponseException") {
    return "Couldn't load the slides. Try again.";
  }
  return "Couldn't open the slides.";
}

/** Thrown inside open() when a newer open() or close() has taken over. */
const SUPERSEDED = Symbol("superseded");

type Job = { page: number; thumb: boolean; waiters: ((f: Frame | null) => void)[] };

const IDLE: DeckSnapshot = {
  status: "idle",
  name: null,
  page: 1,
  count: 0,
  drawn: false,
  error: null,
  pageError: null,
  opening: null,
  deckId: 0,
};

export class DeckEngine {
  readonly canvas: HTMLCanvasElement;
  stream: MediaStream | null = null;

  private ctx: CanvasRenderingContext2D;
  private doc: PDFDocumentProxy | null = null;
  private task: PDFDocumentLoadingTask | null = null;
  private objectUrl: string | null = null;
  /** Bumped by every open() and close(): an older open() gives up. */
  private openGen = 0;
  /** Bumped whenever the current document changes: renders for an older one are dropped. */
  private docGen = 0;
  private snap: DeckSnapshot = IDLE;
  private listeners = new Set<() => void>();
  private slides: Lru<Frame>;
  private thumbs: Lru<Frame>;
  private shown: { page: number; frame: Frame } | null = null;
  private queue: Job[] = [];
  private busy = false;
  private stopTicker: (() => void) | null = null;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = DECK_WIDTH;
    this.canvas.height = DECK_HEIGHT;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable");
    this.ctx = ctx;
    this.slides = new Lru<Frame>(SLIDE_CACHE, (_k, f) => {
      if (f !== this.shown?.frame) closeFrame(f);
    });
    this.thumbs = new Lru<Frame>(THUMB_CACHE, (_k, f) => closeFrame(f));
    this.paintBlack();
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): DeckSnapshot => this.snap;

  private set(patch: Partial<DeckSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  /**
   * Open a deck. Resolves ok once its first slide is on the canvas and the
   * stream is live. With a deck already up, that deck stays on screen and on
   * the stream until the new one is ready, and stays if the new one fails.
   */
  async open(source: DeckSource): Promise<DeckOpenResult> {
    const gen = ++this.openGen;
    const name = source.kind === "file" ? source.file.name : source.name;
    if (this.doc) this.set({ opening: name });
    else this.set({ ...IDLE, status: "loading", name, opening: name });
    let task: PDFDocumentLoadingTask | null = null;
    let objectUrl: string | null = null;
    let first: Frame | null = null;
    try {
      let params: Parameters<Pdfjs["getDocument"]>[0];
      if (source.kind === "file") {
        if (source.file.size > MAX_DECK_BYTES) throw Object.assign(new Error("too big"), { name: "TooBig" });
        const head = new Uint8Array(await source.file.slice(0, 1029).arrayBuffer());
        if (!looksLikePdf(head)) throw Object.assign(new Error("not a pdf"), { name: "InvalidPDFException" });
        objectUrl = URL.createObjectURL(source.file);
        // A local blob: read the pages it needs, when it needs them.
        params = { url: objectUrl, disableAutoFetch: true, verbosity: 0 };
      } else {
        // A signed URL: the first slides come by range, the rest downloads in
        // the background, so later slides don't depend on the URL still working.
        params = { url: source.url, rangeChunkSize: 1 << 20, verbosity: 0 };
      }
      const pdfjs = await loadPdfjs();
      if (gen !== this.openGen) throw SUPERSEDED;
      task = pdfjs.getDocument(params);
      const doc = await task.promise;
      if (gen !== this.openGen) throw SUPERSEDED;
      first = await this.renderPage(doc, 1, DECK_WIDTH, DECK_HEIGHT);
      if (gen !== this.openGen) throw SUPERSEDED;

      // Swap: the old document goes; the canvas and its stream stay.
      this.dropDocument();
      this.doc = doc;
      this.task = task;
      this.objectUrl = objectUrl;
      task = null;
      objectUrl = null;
      this.set({ ...IDLE, status: "ready", name, count: doc.numPages, deckId: this.docGen });
      this.slides.set(1, first);
      this.show(1, first);
      first = null;
      if (!this.stream) {
        this.stream = this.canvas.captureStream();
        const track = this.stream.getVideoTracks()[0];
        if (track) {
          try {
            track.contentHint = "detail";
          } catch {
            /* read-only in a few engines */
          }
        }
      }
      if (!this.stopTicker) this.stopTicker = startTicker(REDRAW_MS, () => this.redraw());
      this.prefetch(1);
      return { ok: true };
    } catch (e) {
      if (first) closeFrame(first);
      if (task) void task.destroy();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (gen !== this.openGen) return { ok: false, error: null };
      const message = friendlyError(e);
      if (this.doc) {
        // The deck on screen stays as it was.
        this.set({ opening: null });
      } else {
        this.release();
        this.set({ ...IDLE, status: "error", name, error: message });
      }
      return { ok: false, error: message };
    }
  }

  go(page: number) {
    const { count } = this.snap;
    if (!this.doc || count === 0) return;
    const target = Math.min(count, Math.max(1, Math.round(page)));
    if (target === this.snap.page && this.snap.drawn) return;
    this.set({ page: target, drawn: this.shown?.page === target, pageError: null });
    const cached = this.slides.get(target);
    if (cached) this.show(target, cached);
    else {
      const docGen = this.docGen;
      void this.request(target, false).then((f) => {
        if (docGen !== this.docGen || this.snap.page !== target) return;
        if (f) this.show(target, f);
        else this.set({ pageError: `Couldn't draw slide ${target}.` });
      });
    }
    this.prefetch(target);
  }

  next = () => this.go(this.snap.page + 1);
  prev = () => this.go(this.snap.page - 1);
  /** Draw the current slide again after it failed. */
  retry = () => this.go(this.snap.page);

  /** A small rendering of a page for the thumbnails rail (cached; null if closed). */
  thumbnail(page: number): Promise<Frame | null> {
    const hit = this.thumbs.get(page);
    if (hit) return Promise.resolve(hit);
    return this.request(page, true);
  }

  /** Stop presenting: end the stream, drop the document and every cached frame. */
  close() {
    this.openGen++;
    this.release();
    this.set(IDLE);
  }

  private release() {
    this.stopTicker?.();
    this.stopTicker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.dropDocument();
    this.paintBlack();
  }

  /** Forget the current document, its queue and its frames. The canvas keeps its last paint. */
  private dropDocument() {
    this.docGen++;
    const queue = this.queue;
    this.queue = [];
    for (const job of queue) job.waiters.forEach((w) => w(null));
    const shown = this.shown;
    this.shown = null;
    this.slides.clear();
    this.thumbs.clear();
    if (shown) closeFrame(shown.frame);
    // Destroying the loading task frees the document (and cancels a load in flight).
    if (this.task) void this.task.destroy();
    this.task = null;
    this.doc = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  private paintBlack() {
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, DECK_WIDTH, DECK_HEIGHT);
  }

  private show(page: number, frame: Frame) {
    const prev = this.shown;
    this.shown = { page, frame };
    // The previous frame is closed only if the cache let go of it already.
    if (prev && prev.frame !== frame && !this.slides.has(prev.page)) closeFrame(prev.frame);
    this.redraw();
    if (this.snap.page === page) this.set({ drawn: true });
  }

  private redraw() {
    if (!this.shown) return;
    const f = this.shown.frame;
    const r = fitRect(f.width, f.height, DECK_WIDTH, DECK_HEIGHT);
    this.paintBlack();
    this.ctx.drawImage(f, r.x, r.y, r.w, r.h);
  }

  private prefetch(page: number) {
    for (const p of [page + 1, page - 1, page + 2]) {
      if (p >= 1 && p <= this.snap.count && !this.slides.has(p)) void this.request(p, false);
    }
  }

  private request(page: number, thumb: boolean): Promise<Frame | null> {
    return new Promise((resolve) => {
      const existing = this.queue.find((j) => j.page === page && j.thumb === thumb);
      if (existing) existing.waiters.push(resolve);
      else this.queue.push({ page, thumb, waiters: [resolve] });
      void this.pump();
    });
  }

  /**
   * One render at a time: the current slide first, then other slides, then
   * the next-slide preview, then thumbnails (newest first: what was just
   * scrolled into view).
   */
  private async pump() {
    const doc = this.doc;
    if (this.busy || !doc) return;
    const current = this.queue.findIndex((j) => !j.thumb && j.page === this.snap.page);
    let idx = current;
    if (idx < 0) idx = this.queue.findIndex((j) => !j.thumb);
    if (idx < 0) idx = this.queue.findIndex((j) => j.page === this.snap.page + 1);
    if (idx < 0) idx = this.queue.length - 1;
    if (idx < 0) return;
    const [job] = this.queue.splice(idx, 1);
    this.busy = true;
    const docGen = this.docGen;
    let frame: Frame | null = null;
    try {
      frame = job.thumb ? await this.renderThumb(doc, docGen, job.page) : await this.renderSlide(doc, docGen, job.page);
    } catch {
      frame = null;
    }
    this.busy = false;
    if (docGen !== this.docGen) {
      // Rendered for a document that has since been swapped out or closed.
      job.waiters.forEach((w) => w(null));
    } else {
      job.waiters.forEach((w) => w(frame));
      // A slide render also makes its thumbnail: answer a queued request for it now.
      const t = job.thumb ? -1 : this.queue.findIndex((j) => j.thumb && j.page === job.page);
      const thumb = t >= 0 ? this.thumbs.get(job.page) : undefined;
      if (thumb) this.queue.splice(t, 1)[0].waiters.forEach((w) => w(thumb));
    }
    void this.pump();
  }

  private async renderSlide(doc: PDFDocumentProxy, docGen: number, n: number): Promise<Frame | null> {
    const cached = this.slides.get(n);
    if (cached) return cached;
    const frame = await this.renderPage(doc, n, DECK_WIDTH, DECK_HEIGHT);
    if (docGen !== this.docGen) {
      closeFrame(frame);
      return null;
    }
    const keep = [this.snap.page, this.shown?.page ?? -1, this.snap.page + 1, this.snap.page - 1];
    this.slides.set(n, frame, keep);
    if (!this.thumbs.has(n)) {
      const t = await this.scaleDown(frame);
      if (docGen === this.docGen) this.thumbs.set(n, t);
      else closeFrame(t);
    }
    return frame;
  }

  private async renderThumb(doc: PDFDocumentProxy, docGen: number, n: number): Promise<Frame | null> {
    const cached = this.thumbs.get(n);
    if (cached) return cached;
    const big = this.slides.get(n);
    const frame = big ? await this.scaleDown(big) : await this.renderPage(doc, n, THUMB_WIDTH, THUMB_HEIGHT);
    if (docGen !== this.docGen) {
      closeFrame(frame);
      return null;
    }
    this.thumbs.set(n, frame);
    return frame;
  }

  /** Draw one page of `doc` into a box (white page, scaled to fit). Throws when it can't. */
  private async renderPage(doc: PDFDocumentProxy, n: number, boxW: number, boxH: number): Promise<Frame> {
    const page = await doc.getPage(n);
    try {
      const base = page.getViewport({ scale: 1 });
      const fit = fitRect(base.width, base.height, boxW, boxH);
      const viewport = page.getViewport({ scale: fit.scale });
      const scratch = document.createElement("canvas");
      scratch.width = Math.max(1, Math.floor(viewport.width));
      scratch.height = Math.max(1, Math.floor(viewport.height));
      await page.render({ canvas: scratch, viewport, background: "#ffffff" }).promise;
      return await toFrame(scratch);
    } finally {
      page.cleanup();
    }
  }

  private async scaleDown(src: Frame): Promise<Frame> {
    const fit = fitRect(src.width, src.height, THUMB_WIDTH, THUMB_HEIGHT);
    const c = document.createElement("canvas");
    c.width = Math.max(1, fit.w);
    c.height = Math.max(1, fit.h);
    c.getContext("2d")?.drawImage(src, 0, 0, c.width, c.height);
    return toFrame(c);
  }
}

async function toFrame(c: HTMLCanvasElement): Promise<Frame> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(c);
      // Free the scratch canvas's backing store now (Safari keeps it otherwise).
      c.width = 0;
      c.height = 0;
      return bmp;
    } catch {
      /* fall through */
    }
  }
  return c;
}
