"use client";
import { useEffect, useMemo, useState } from "react";
import type { LocalMediaView } from "@/components/live/room";

/**
 * Fake media for the room harness: cameras and screens drawn on canvases
 * (a moving pattern + a name, so a frozen frame is obvious), voices from
 * oscillators that talk in bursts (so the speaking ring moves around).
 * Nothing here touches a real device.
 */

type Painter = (ctx: CanvasRenderingContext2D, t: number, w: number, h: number) => void;

const painters = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function paintLoop(fn: () => void): () => void {
  painters.add(fn);
  if (!ticker) ticker = setInterval(() => painters.forEach((p) => p()), 1000 / 15);
  return () => {
    painters.delete(fn);
    if (!painters.size && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

function canvasStream(w: number, h: number, paint: Painter): { stream: MediaStream; stop: () => void } {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const start = performance.now();
  const draw = () => paint(ctx, (performance.now() - start) / 1000, w, h);
  draw();
  const stopLoop = paintLoop(draw);
  const stream = c.captureStream(15);
  return {
    stream,
    stop: () => {
      stopLoop();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

function cameraPainter(name: string, hue: number): Painter {
  return (ctx, t, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${hue} 45% 22%)`);
    g.addColorStop(1, `hsl(${(hue + 40) % 360} 50% 12%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // A "head" that bobs, so motion is visible.
    const cx = w / 2 + Math.sin(t * 0.9) * w * 0.06;
    const cy = h * 0.46 + Math.cos(t * 1.3) * h * 0.03;
    ctx.fillStyle = `hsl(${hue} 35% 62%)`;
    ctx.beginPath();
    ctx.arc(cx, cy, h * 0.17, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - h * 0.28, cy + h * 0.2, h * 0.56, h * 0.4);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = `600 ${Math.round(h * 0.08)}px ui-monospace, monospace`;
    ctx.textAlign = "left";
    ctx.fillText(name, w * 0.04, h * 0.12);
    ctx.font = `${Math.round(h * 0.05)}px ui-monospace, monospace`;
    ctx.fillText(`${t.toFixed(1)}s`, w * 0.04, h * 0.2);
  };
}

/** A screen with corner markers: a crop is impossible to miss in a screenshot. */
function screenPainter(label: string): Painter {
  return (ctx, t, w, h) => {
    ctx.fillStyle = "#f6f6f4";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#24292f";
    ctx.fillRect(0, 0, w, h * 0.06);
    ctx.fillStyle = "#fff";
    ctx.font = `${Math.round(h * 0.03)}px ui-monospace, monospace`;
    ctx.textAlign = "left";
    ctx.fillText(label, w * 0.02, h * 0.04);
    ctx.fillStyle = "#141414";
    ctx.font = `600 ${Math.round(h * 0.06)}px ui-monospace, monospace`;
    ctx.fillText("Customer interviews: week 3", w * 0.06, h * 0.2);
    ctx.font = `${Math.round(h * 0.035)}px ui-monospace, monospace`;
    const lines = ["12 calls booked", "4 said they'd pay", "Biggest pain: onboarding", "Next: price test"];
    lines.forEach((l, i) => ctx.fillText(`• ${l}`, w * 0.08, h * (0.32 + i * 0.08)));
    // Cursor.
    const x = w * (0.5 + 0.3 * Math.sin(t * 0.7));
    const y = h * (0.6 + 0.2 * Math.cos(t * 0.5));
    ctx.fillStyle = "#e5484d";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w * 0.015, y + h * 0.04);
    ctx.lineTo(x + w * 0.005, y + h * 0.035);
    ctx.fill();
    // Corner markers + frame.
    ctx.strokeStyle = "#e5484d";
    ctx.lineWidth = Math.max(4, w * 0.004);
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
    ctx.fillStyle = "#e5484d";
    ctx.font = `700 ${Math.round(h * 0.035)}px ui-monospace, monospace`;
    const pad = w * 0.012;
    ctx.textAlign = "left";
    ctx.fillText("TL", pad, h * 0.1);
    ctx.fillText("BL", pad, h - pad);
    ctx.textAlign = "right";
    ctx.fillText("TR", w - pad, h * 0.1);
    ctx.fillText("BR", w - pad, h - pad);
  };
}

let audioCtx: AudioContext | null = null;
function ac(): AudioContext {
  audioCtx ??= new AudioContext();
  return audioCtx;
}

/** A voice that talks for ~2s, pauses ~3s (offset so voices take turns). */
function voiceStream(freq: number, offset: number): { stream: MediaStream; stop: () => void } {
  const a = ac();
  const osc = a.createOscillator();
  const am = a.createOscillator();
  const amGain = a.createGain();
  const gain = a.createGain();
  const dest = a.createMediaStreamDestination();
  osc.type = "triangle";
  osc.frequency.value = freq;
  am.frequency.value = 5;
  amGain.gain.value = 0.03;
  am.connect(amGain);
  amGain.connect(gain.gain);
  osc.connect(gain);
  gain.connect(dest);
  gain.gain.value = 0;
  osc.start();
  am.start();
  const cycle = 5000;
  const timer = setInterval(() => {
    const phase = (Date.now() + offset) % cycle;
    gain.gain.setTargetAtTime(phase < 2000 ? 0.06 : 0, a.currentTime, 0.05);
  }, 100);
  return {
    stream: dest.stream,
    stop: () => {
      clearInterval(timer);
      osc.stop();
      am.stop();
      dest.stream.getTracks().forEach((t) => t.stop());
    },
  };
}

export type FakeFeeds = {
  camera: (name: string, hue: number) => MediaStream;
  screen: (label: string, w: number, h: number) => MediaStream;
  voice: (freq: number, offset: number) => MediaStream;
};

/** Feeds created for one harness view and stopped when it goes away. */
export function useFakeFeeds(): FakeFeeds | null {
  const [feeds, setFeeds] = useState<{ api: FakeFeeds; stop: () => void } | null>(null);
  useEffect(() => {
    const stops: (() => void)[] = [];
    const cache = new Map<string, MediaStream>();
    const memo = (key: string, make: () => { stream: MediaStream; stop: () => void }) => {
      const hit = cache.get(key);
      if (hit) return hit;
      const f = make();
      stops.push(f.stop);
      cache.set(key, f.stream);
      return f.stream;
    };
    const api: FakeFeeds = {
      camera: (name, hue) => memo(`cam:${name}`, () => canvasStream(640, 360, cameraPainter(name, hue))),
      screen: (label, w, h) => memo(`scr:${label}:${w}x${h}`, () => canvasStream(w, h, screenPainter(label))),
      voice: (freq, offset) => memo(`voice:${freq}:${offset}`, () => voiceStream(freq, offset)),
    };
    setFeeds({ api, stop: () => stops.forEach((s) => s()) });
    return () => stops.forEach((s) => s());
  }, []);
  return feeds?.api ?? null;
}

const DEVICES = {
  mics: [
    { deviceId: "default", label: "Default - MacBook Pro Microphone" },
    { deviceId: "mic-usb", label: "Yeti Stereo Microphone" },
  ],
  cameras: [
    { deviceId: "cam-built-in", label: "FaceTime HD Camera" },
    { deviceId: "cam-usb", label: "Logitech C920" },
  ],
  speakers: [
    { deviceId: "default", label: "Default - MacBook Pro Speakers" },
    { deviceId: "spk-hp", label: "AirPods Pro" },
  ],
};

/** A LocalMediaView over a fake camera + voice. */
export function useFakeLocalMedia(
  feeds: FakeFeeds | null,
  name: string,
  opts: { cameraOn?: boolean; micOn?: boolean; status?: LocalMediaView["status"] } = {},
): LocalMediaView {
  const [cameraOn, setCameraOn] = useState(opts.cameraOn ?? true);
  const [micOn, setMicOn] = useState(opts.micOn ?? true);
  const [micId, setMicId] = useState("default");
  const [cameraId, setCameraId] = useState("cam-built-in");
  const stream = useMemo(() => {
    if (!feeds || opts.status === "denied") return null;
    return new MediaStream([
      ...feeds.camera(name, 210).getVideoTracks(),
      ...feeds.voice(180, 1500).getAudioTracks(),
    ]);
  }, [feeds, name, opts.status]);
  useEffect(() => {
    stream?.getVideoTracks().forEach((t) => (t.enabled = cameraOn));
    stream?.getAudioTracks().forEach((t) => (t.enabled = micOn));
  }, [stream, cameraOn, micOn]);
  return useMemo(
    () => ({
      stream,
      status: opts.status ?? (stream ? "ready" : "requesting"),
      error: null,
      cameraOn,
      micOn,
      toggleCamera: () => setCameraOn((v) => !v),
      toggleMic: () => setMicOn((v) => !v),
      start: () => {},
      devices: DEVICES,
      micId,
      cameraId,
      setMic: setMicId,
      setCamera: setCameraId,
      switching: false,
      deviceError: null,
    }),
    [stream, opts.status, cameraOn, micOn, micId, cameraId],
  );
}

/**
 * A small real PDF (16:9 slides plus a 4:3 and a portrait page, to check
 * letterboxing), built byte by byte so the harness needs no fixture file.
 */
export function makeDeckPdf(pages = 12): Uint8Array {
  const enc = new TextEncoder();
  const objs: string[] = [];
  const pageIds: number[] = [];
  const fontId = 3 + pages * 2;
  for (let i = 0; i < pages; i++) {
    const n = i + 1;
    const [w, h] = n === 5 ? [720, 540] : n === 6 ? [612, 792] : [960, 540];
    const pageId = 3 + i * 2;
    const contentId = pageId + 1;
    pageIds.push(pageId);
    const hue = [0.95, 0.73, 0.0];
    const bar = `${hue[0]} ${hue[1]} ${hue[2]} rg 0 ${h - 36} ${w} 36 re f`;
    const block = `0.1 0.1 0.12 rg ${40 + (i % 4) * 60} 60 ${w * 0.3} ${h * 0.18} re f`;
    const text = [
      `BT /F1 ${Math.round(h * 0.11)} Tf 40 ${Math.round(h * 0.55)} Td (Slide ${n}) Tj ET`,
      `BT /F1 ${Math.round(h * 0.045)} Tf 40 ${Math.round(h * 0.42)} Td (batch0 deck test - ${w}x${h}) Tj ET`,
    ].join("\n");
    const content = `q ${bar} Q q ${block} Q\n${text}`;
    objs[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${contentId} 0 R ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objs[contentId] = `<< /Length ${enc.encode(content).length} >>\nstream\n${content}\nendstream`;
  }
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`;
  objs[fontId] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = enc.encode(out).length;
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xref = enc.encode(out).length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc.encode(out);
}
