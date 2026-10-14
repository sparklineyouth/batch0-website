"use client";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { fitRect, looksLikePdf, Lru, MAX_DECK_BYTES } from "../logic";

/**
 * Renders a PDF deck to a 1920×1080 canvas and streams it.
 *
 * The canvas stream goes through the SAME screen slot a screen share uses, so
 * viewers and the recorder see slides with no protocol change. Pages render
 * lazily (current first, then neighbours, then whatever thumbnails are on
 * screen); rendered slides are cached as ImageBitmaps with a small cap so a
 * 300-page deck never holds more than a handful of full-size frames.
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
  status: "idle" | "loading" | "ready" | "error";
  name: string | null;
  /** 1-based. */
  page: number;
  count: number;
  /** The current page is drawn on the canvas. */
  drawn: boolean;
  error: string | null;
};

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
  if (name === "PasswordException") return "That PDF is password-protected.";
  if (name === "InvalidPDFException") return "That file isn't a PDF we can open.";
  if (name === "MissingPDFException" || name === "ResponseException" || name === "UnexpectedResponseException") {
    return "Couldn't load the slides. Try again.";
  }
  return "Couldn't open the slides.";
}

type Job = { page: number; thumb: boolean; waiters: ((f: Frame | null) => void)[] };

export class DeckEngine {
  readonly canvas: HTMLCanvasElement;
  stream: MediaStream | null = null;

  private ctx: CanvasRenderingContext2D;
  private doc: PDFDocumentProxy | null = null;
  private task: PDFDocumentLoadingTask | null = null;
  private objectUrl: string | null = null;
  private gen = 0;
  private snap: DeckSnapshot = { status: "idle", name: null, page: 1, count: 0, drawn: false, error: null };
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

  /** Open a deck. Resolves true once the first slide is on the canvas and the stream is live. */
  async open(source: DeckSource): Promise<boolean> {
    const gen = ++this.gen;
    this.release();
    const name = source.kind === "file" ? source.file.name : source.name;
    this.set({ status: "loading", name, page: 1, count: 0, drawn: false, error: null });
    try {
      let params: Parameters<Pdfjs["getDocument"]>[0];
      if (source.kind === "file") {
        if (source.file.size > MAX_DECK_BYTES) {
          throw Object.assign(new Error("too big"), { name: "TooBig" });
        }
        const head = new Uint8Array(await source.file.slice(0, 1029).arrayBuffer());
        if (!looksLikePdf(head)) throw Object.assign(new Error("not a pdf"), { name: "InvalidPDFException" });
        this.objectUrl = URL.createObjectURL(source.file);
        params = { url: this.objectUrl, disableAutoFetch: true, verbosity: 0 };
      } else {
        params = { url: source.url, disableAutoFetch: true, rangeChunkSize: 1 << 20, verbosity: 0 };
      }
      const pdfjs = await loadPdfjs();
      if (gen !== this.gen) return false;
      const task = pdfjs.getDocument(params);
      this.task = task;
      const doc = await task.promise;
      if (gen !== this.gen) return false;
      this.doc = doc;
      this.set({ count: doc.numPages });
      const first = await this.request(1, false);
      if (gen !== this.gen) return false;
      if (!first) throw new Error("render failed");
      this.show(1, first);
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
      this.stopTicker?.();
      this.stopTicker = startTicker(REDRAW_MS, () => this.redraw());
      this.set({ status: "ready" });
      this.prefetch(1);
      return true;
    } catch (e) {
      if (gen !== this.gen) return false;
      const message =
        (e as { name?: string })?.name === "TooBig"
          ? "That PDF is too big (150 MB max)."
          : friendlyError(e);
      this.release();
      this.set({ status: "error", error: message, drawn: false, count: 0 });
      return false;
    }
  }

  go(page: number) {
    const { count } = this.snap;
    if (!this.doc || count === 0) return;
    const target = Math.min(count, Math.max(1, Math.round(page)));
    if (target === this.snap.page && this.snap.drawn) return;
    this.set({ page: target, drawn: this.shown?.page === target });
    const cached = this.slides.get(target);
    if (cached) this.show(target, cached);
    else {
      const gen = this.gen;
      void this.request(target, false).then((f) => {
        if (f && gen === this.gen && this.snap.page === target) this.show(target, f);
      });
    }
    this.prefetch(target);
  }

  next = () => this.go(this.snap.page + 1);
  prev = () => this.go(this.snap.page - 1);

  /** A small rendering of a page for the thumbnails rail (cached; null if closed). */
  thumbnail(page: number): Promise<Frame | null> {
    const hit = this.thumbs.get(page);
    if (hit) return Promise.resolve(hit);
    return this.request(page, true);
  }

  /** Stop presenting: end the stream, drop the document and every cached frame. */
  close() {
    this.gen++;
    this.release();
    this.set({ status: "idle", name: null, page: 1, count: 0, drawn: false, error: null });
  }

  private release() {
    this.stopTicker?.();
    this.stopTicker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    for (const job of this.queue) job.waiters.forEach((w) => w(null));
    this.queue = [];
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
    this.paintBlack();
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

  /** One render at a time: the current slide first, then other slides, then thumbnails (newest first). */
  private async pump() {
    if (this.busy || !this.doc) return;
    const current = this.queue.findIndex((j) => !j.thumb && j.page === this.snap.page);
    let idx = current;
    if (idx < 0) idx = this.queue.findIndex((j) => !j.thumb);
    if (idx < 0) idx = this.queue.length - 1;
    if (idx < 0) return;
    const [job] = this.queue.splice(idx, 1);
    this.busy = true;
    const gen = this.gen;
    let frame: Frame | null = null;
    try {
      frame = job.thumb ? await this.renderThumb(job.page) : await this.renderSlide(job.page);
    } catch {
      frame = null;
    }
    this.busy = false;
    if (gen !== this.gen) {
      if (frame) closeFrame(frame);
      job.waiters.forEach((w) => w(null));
      return;
    }
    job.waiters.forEach((w) => w(frame));
    void this.pump();
  }

  private async renderSlide(n: number): Promise<Frame | null> {
    const cached = this.slides.get(n);
    if (cached) return cached;
    const frame = await this.renderPage(n, DECK_WIDTH, DECK_HEIGHT);
    if (!frame) return null;
    const keep = [this.snap.page, this.shown?.page ?? -1, this.snap.page + 1, this.snap.page - 1];
    this.slides.set(n, frame, keep);
    if (!this.thumbs.has(n)) {
      const t = await this.scaleDown(frame);
      if (t) this.thumbs.set(n, t);
    }
    return frame;
  }

  private async renderThumb(n: number): Promise<Frame | null> {
    const cached = this.thumbs.get(n);
    if (cached) return cached;
    const big = this.slides.get(n);
    const frame = big ? await this.scaleDown(big) : await this.renderPage(n, THUMB_WIDTH, THUMB_HEIGHT);
    if (frame) this.thumbs.set(n, frame);
    return frame;
  }

  private async renderPage(n: number, boxW: number, boxH: number): Promise<Frame | null> {
    const doc = this.doc;
    if (!doc) return null;
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

  private async scaleDown(src: Frame): Promise<Frame | null> {
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
