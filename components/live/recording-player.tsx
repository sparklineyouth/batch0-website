"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, CircleDot, Download, Loader2, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import { downloadName, formatDuration, SHORT_TAKE_MS } from "@/lib/recording-parts";

/**
 * Watching recordings back.
 *
 * A take (one Record → Stop, or one auto-recorded stretch) is ONE file:
 * /api/recordings/<id>/media serves its stored parts as a single seekable
 * stream, so the player is a plain <video>. Download assembles the same file
 * in the browser from short-lived part URLs (lib/recording-parts.ts), so big
 * files never pass through a function.
 *
 * Recordings made before that (two-minute segments) play through the legacy
 * player: one <video> that walks the parts in order.
 *
 * `CallRecordings` and `EventRecordings` take only an id and fetch the list
 * themselves (GET /api/recordings, which checks who may watch), so a server
 * page and a client card can both drop them in.
 */

/** A take, as GET /api/recordings lists it (RecordingSummary). */
export type Recording = {
  id: string;
  status: "finished" | "interrupted";
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  byName: string | null;
  container: "webm" | "mp4";
  bytes: number;
  title: string | null;
};

type Listing = {
  recordings: Recording[];
  legacy: { parts: { seconds: number | null }[] } | null;
  canDelete: boolean;
};

export function CallRecordings({ inviteId }: { inviteId: string }) {
  return <RoomRecordings kind="call" roomId={inviteId} compact />;
}

export function EventRecordings({
  eventId,
  emptyText,
}: {
  eventId: string;
  /** Shown when there is nothing; omitted, nothing renders. */
  emptyText?: string;
}) {
  return <RoomRecordings kind="webinar" roomId={eventId} emptyText={emptyText} />;
}

function RoomRecordings({
  kind,
  roomId,
  compact = false,
  emptyText,
}: {
  kind: "webinar" | "call";
  roomId: string;
  /** Collapsed rows (a list of calls) rather than open players. */
  compact?: boolean;
  emptyText?: string;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Fetched when it scrolls into view: a list of past calls holds dozens of
  // these, most never looked at (and a closed <details> is never "in view").
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const load = () => {
      fetch(`/api/recordings?kind=${kind}&room=${roomId}`, { cache: "no-store" })
        .then(async (res) => {
          if (cancelled) return;
          if (res.status === 404) return setListing({ recordings: [], legacy: null, canDelete: false });
          if (!res.ok) throw new Error(String(res.status));
          setListing((await res.json()) as Listing);
        })
        .catch(() => !cancelled && setFailed(true));
    };
    if (typeof IntersectionObserver === "undefined") {
      load();
      return () => {
        cancelled = true;
      };
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        load();
      }
    });
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [kind, roomId]);

  const remove = useCallback((id: string) => {
    setListing((l) => (l ? { ...l, recordings: l.recordings.filter((r) => r.id !== id) } : l));
  }, []);

  const takes = listing?.recordings ?? [];
  const long = takes.filter((t) => t.durationMs >= SHORT_TAKE_MS);
  const main = long.length > 0 ? long : takes;
  const extra = long.length > 0 ? takes.filter((t) => t.durationMs < SHORT_TAKE_MS) : [];
  const legacy = listing?.legacy ?? null;
  const empty = !!listing && takes.length === 0 && !legacy;
  const shown = takes.length > 0 || !!legacy || failed || (empty && !!emptyText);

  return (
    <div ref={ref} className={!shown ? "" : compact ? "mt-2 space-y-2" : "space-y-4"}>
      {failed && <p className="text-xs text-ink-faint">Couldn&rsquo;t load the recording.</p>}
      {empty && emptyText && <p className="text-sm text-ink-soft">{emptyText}</p>}
      {main.map((r) => (
        <RecordingPlayer
          key={r.id}
          recording={r}
          compact={compact}
          canDelete={!!listing?.canDelete}
          onDeleted={() => remove(r.id)}
        />
      ))}
      {extra.length > 0 && (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-ink-faint hover:text-ink [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            Also recorded · {extra.length}
          </summary>
          <div className="mt-2 space-y-2">
            {extra.map((r) => (
              <RecordingPlayer
                key={r.id}
                recording={r}
                compact
                canDelete={!!listing?.canDelete}
                onDeleted={() => remove(r.id)}
              />
            ))}
          </div>
        </details>
      )}
      {legacy && <LegacyPlayer kind={kind} roomId={roomId} parts={legacy.parts} compact={compact} />}
    </div>
  );
}

/**
 * One take: a <video> (behind a Watch button when `compact`), its length,
 * date and who recorded it, Download, and Delete for staff.
 */
export function RecordingPlayer({
  recording: r,
  compact = false,
  canDelete = false,
  onDeleted,
}: {
  recording: Recording;
  compact?: boolean;
  canDelete?: boolean;
  onDeleted?: () => void;
}) {
  const [open, setOpen] = useState(!compact);
  return (
    <div className={compact ? "" : "space-y-2"}>
      {open && (
        <video
          controls
          playsInline
          preload="metadata"
          autoPlay={compact}
          src={`/api/recordings/${r.id}/media`}
          className="aspect-video w-full rounded-md border border-line bg-[#000]"
        />
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-soft">
        <span className="inline-flex items-center gap-1.5 font-medium text-ink">
          <CircleDot className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
          {formatDuration(r.durationMs)}
        </span>
        <LocalTime value={r.startedAt} mode="datetime-short" />
        {r.byName && <span className="text-ink-faint">by {r.byName}</span>}
        {r.status === "interrupted" && <span className="text-ink-faint">· cut short</span>}
        <span className="ml-auto inline-flex items-center gap-1">
          {!open && (
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
              <Play className="h-3.5 w-3.5" />
              Watch
            </Button>
          )}
          <DownloadButton recording={r} />
          {canDelete && <DeleteButton id={r.id} onDeleted={onDeleted} />}
        </span>
      </div>
    </div>
  );
}

type Manifest = {
  filename: string;
  type: string;
  size: number;
  head: { url: string; size: number } | null;
  parts: { url: string; size: number; skip: number }[];
};

type SaveFilePicker = (opts: {
  suggestedName: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{
  createWritable: () => Promise<{
    write: (data: Uint8Array | Blob) => Promise<void>;
    close: () => Promise<void>;
    abort: () => Promise<void>;
  }>;
}>;

/** Download: a save dialog streamed part by part where the browser has one, else one Blob. */
function DownloadButton({ recording: r }: { recording: Recording }) {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setError(null);
    const filename = downloadName(r.title, r.startedAt, r.container);
    const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
    // The picker first, while the click still counts as a user gesture.
    let file: Awaited<ReturnType<Awaited<ReturnType<SaveFilePicker>>["createWritable"]>> | null = null;
    if (picker) {
      try {
        const handle = await picker({
          suggestedName: filename,
          types: [{ description: "Video", accept: { [`video/${r.container}`]: [`.${r.container}`] } }],
        });
        file = await handle.createWritable();
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        file = null; // no picker after all: fall back to a Blob
      }
    }
    setProgress(0);
    const blobs: Blob[] = [];
    try {
      let manifest = await fetchManifest(r.id);
      const total = manifest.size || r.bytes || 1;
      let done = 0;
      const sources = (m: Manifest) => [
        ...(m.head ? [{ url: m.head.url, skip: 0 }] : []),
        ...m.parts.map((p) => ({ url: p.url, skip: p.skip })),
      ];
      let list = sources(manifest);
      for (let i = 0; i < list.length; i++) {
        let res = await fetch(list[i].url);
        if (!res.ok) {
          // Signed URLs are short-lived; a long download renews them once.
          manifest = await fetchManifest(r.id);
          list = sources(manifest);
          res = await fetch(list[i].url);
          if (!res.ok) throw new Error(`part ${i}: ${res.status}`);
        }
        let blob = await res.blob();
        if (list[i].skip > 0) blob = blob.slice(list[i].skip);
        if (file) await file.write(blob);
        else blobs.push(blob);
        done += blob.size;
        setProgress(Math.min(99, Math.floor((done / total) * 100)));
      }
      if (file) {
        await file.close();
      } else {
        const url = URL.createObjectURL(new Blob(blobs, { type: manifest.type }));
        const a = document.createElement("a");
        a.href = url;
        a.download = manifest.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch {
      await file?.abort().catch(() => {});
      setError("Download failed. Try again.");
    } finally {
      setProgress(null);
    }
  }, [r]);

  return (
    <>
      <Button size="sm" variant="ghost" onClick={run} disabled={progress !== null}>
        {progress !== null ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {progress}%
          </>
        ) : (
          <>
            <Download className="h-3.5 w-3.5" />
            Download
          </>
        )}
      </Button>
      {error && <span className="text-amber-600 dark:text-amber-400">{error}</span>}
    </>
  );
}

async function fetchManifest(id: string): Promise<Manifest> {
  const res = await fetch(`/api/recordings/${id}/download`, { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as Manifest;
}

/** Delete, in two presses. */
function DeleteButton({ id, onDeleted }: { id: string; onDeleted?: () => void }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);

  const note = error && (
    <span className="text-amber-600 dark:text-amber-400" role="status">
      {error}
    </span>
  );
  if (!armed) {
    return (
      <>
        {note}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setError(null);
            setArmed(true);
          }}
          aria-label="Delete recording"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </>
    );
  }
  return (
    <>
      <Button
        size="sm"
        variant="danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await fetch(`/api/recordings/${id}`, { method: "DELETE" }).catch(() => null);
          setBusy(false);
          if (res?.ok) {
            onDeleted?.();
            return;
          }
          // 409 and 503 say why ("Stop the recording first."); anything else doesn't.
          const body = res && (res.status === 409 || res.status === 503) ? await res.json().catch(() => ({})) : {};
          setArmed(false);
          setError(typeof body.error === "string" ? body.error : "Couldn't delete it. Try again.");
        }}
      >
        {busy ? "Deleting…" : "Delete for good"}
      </Button>
      {note}
    </>
  );
}

/**
 * A recording from before one-take recording: its two-minute parts, played
 * back to back in one <video> (each part is checked and signed as it starts —
 * /api/recordings/legacy).
 */
function LegacyPlayer({
  kind,
  roomId,
  parts,
  compact,
}: {
  kind: "webinar" | "call";
  roomId: string;
  parts: { seconds: number | null }[];
  compact: boolean;
}) {
  const [open, setOpen] = useState(!compact);
  const [part, setPart] = useState(1);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const seconds = parts.every((p) => p.seconds !== null)
    ? parts.reduce((n, p) => n + (p.seconds ?? 0), 0)
    : null;

  // Carry on into the next part when one ends, if it was playing.
  useEffect(() => {
    if (playing) void videoRef.current?.play().catch(() => {});
  }, [part, playing]);

  const src = `/api/recordings/legacy?kind=${kind}&room=${roomId}&part=${part}`;
  return (
    <div className={compact ? "" : "space-y-2"}>
      {open && (
        <video
          ref={videoRef}
          key={src}
          controls
          playsInline
          preload="metadata"
          src={src}
          onPlay={() => setPlaying(true)}
          onPause={(e) => {
            if (!e.currentTarget.ended) setPlaying(false);
          }}
          onEnded={() => {
            if (part < parts.length) setPart(part + 1);
            else setPlaying(false);
          }}
          className="aspect-video w-full rounded-md border border-line bg-[#000]"
        />
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-soft">
        <span className="inline-flex items-center gap-1.5 font-medium text-ink">
          <CircleDot className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
          {seconds !== null ? formatDuration(seconds * 1000) : "Recording"}
        </span>
        {parts.length > 1 && (
          <span className="text-ink-faint">
            Part {part} of {parts.length}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1">
          {!open ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpen(true);
                setPlaying(true);
              }}
            >
              <Play className="h-3.5 w-3.5" />
              Watch
            </Button>
          ) : (
            parts.length > 1 && (
              <>
                <Button size="sm" variant="ghost" disabled={part <= 1} onClick={() => setPart(part - 1)}>
                  Previous
                </Button>
                <Button size="sm" variant="ghost" disabled={part >= parts.length} onClick={() => setPart(part + 1)}>
                  Next
                </Button>
              </>
            )
          )}
        </span>
      </div>
    </div>
  );
}
