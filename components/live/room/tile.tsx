"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Maximize2, MicOff, Minimize2, Pin, PinOff, Users } from "lucide-react";
import { useSpeaking } from "./audio-levels";
import { FOCUS, Spinner, initials } from "./ui";

/**
 * One video on the stage, in the filmstrip, the grid or the PiP.
 *
 * Video is always muted here: sound plays through AudioSinks, independent of
 * which tiles are on screen. Presentations are `contain` on black (never
 * cropped); cameras are `cover`.
 */

export type TileVariant = "main" | "film" | "grid" | "pip";

export function Tile({
  name,
  stream,
  audio,
  fit,
  showVideo,
  mirror = false,
  micOff = false,
  reconnecting = false,
  variant,
  badge,
  pinned = false,
  onPin,
  onPinForEveryone,
  fullscreen = null,
  className = "",
  style,
  children,
  testId,
}: {
  name: string;
  stream: MediaStream | null;
  /** The person's audio, for the speaking ring. */
  audio?: MediaStream | null;
  fit: "cover" | "contain";
  /** False: initials instead of video (camera off). */
  showVideo: boolean;
  mirror?: boolean;
  micOff?: boolean;
  reconnecting?: boolean;
  variant: TileVariant;
  /** Short label after the name: "You", "Host", "Presenting". */
  badge?: string | null;
  pinned?: boolean;
  onPin?: () => void;
  onPinForEveryone?: () => void;
  /**
   * Offer a fullscreen button (main stage). The element that goes full
   * screen: the stage area, so the view survives the main tile changing.
   */
  fullscreen?: React.RefObject<HTMLElement | null> | null;
  className?: string;
  style?: React.CSSProperties;
  children?: ReactNode;
  testId?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const fs = useFullscreen(fullscreen ?? box, video);
  const small = variant === "film" || variant === "pip";
  // Callers that place the tile themselves pass `absolute`; otherwise it is a normal box.
  const position = /\b(absolute|fixed)\b/.test(className) ? "" : "relative";

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (stream) el.play?.().catch(() => {});
  }, [stream]);

  return (
    <div
      ref={box}
      data-testid={testId}
      data-variant={variant}
      style={style}
      className={`group isolate overflow-hidden rounded-md ${position} ${
        fit === "contain" ? "bg-[#000]" : "bg-[#1b1b1f]"
      } ${className}`}
    >
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        className={`absolute inset-0 h-full w-full ${fit === "contain" ? "object-contain" : "object-cover"} ${
          showVideo && stream ? "" : "invisible"
        } ${mirror ? "-scale-x-100" : ""}`}
      />

      {!(showVideo && stream) && (
        <div className="absolute inset-0 grid place-items-center">
          <div
            className={`grid place-items-center rounded-full bg-[#34343a] font-medium text-[#f4f4f5] ${
              small ? "h-10 w-10 text-sm" : variant === "grid" ? "h-16 w-16 text-xl" : "h-20 w-20 text-2xl sm:h-24 sm:w-24 sm:text-3xl"
            }`}
            aria-hidden
          >
            {initials(name)}
          </div>
        </div>
      )}

      {children}

      {reconnecting && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-[rgba(12,12,14,0.6)]">
          <span className="inline-flex items-center gap-2 text-xs font-medium text-[#f4f4f5] sm:text-sm">
            <Spinner className="h-4 w-4" />
            {small ? null : "Reconnecting…"}
          </span>
        </div>
      )}

      <SpeakingRing stream={audio ?? null} />

      {/* Name + state, bottom left. */}
      <div
        className={`pointer-events-none absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-12px)] items-center gap-1.5 rounded bg-[rgba(0,0,0,0.6)] text-[#fff] ${
          small ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs"
        }`}
      >
        {micOff && <MicOff className={small ? "h-3 w-3 shrink-0 text-[#ff8a8d]" : "h-3.5 w-3.5 shrink-0 text-[#ff8a8d]"} aria-label="Muted" />}
        <span className="truncate">{name}</span>
        {badge ? <span className="shrink-0 text-[#c4c4cc]">· {badge}</span> : null}
        {pinned ? <Pin className="h-3 w-3 shrink-0 text-[#FFBB00]" aria-label="Pinned" /> : null}
      </div>

      {/* Actions, top right: visible on hover / focus, always on touch screens. */}
      {(onPin || onPinForEveryone || (fullscreen && fs.supported)) && (
        <div className="absolute right-1.5 top-1.5 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          {onPinForEveryone ? (
            <TileAction label="Pin for everyone" onClick={onPinForEveryone} testId="tile-pin-everyone" text={!small}>
              <Users className="h-3.5 w-3.5" />
            </TileAction>
          ) : null}
          {onPin ? (
            <TileAction label={pinned ? `Unpin ${name}` : `Pin ${name}`} onClick={onPin} testId="tile-pin">
              {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            </TileAction>
          ) : null}
          {fullscreen && fs.supported ? (
            <TileAction label={fs.active ? "Exit full screen" : "Full screen"} onClick={fs.toggle} testId="tile-fullscreen">
              {fs.active ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </TileAction>
          ) : null}
        </div>
      )}
    </div>
  );
}

function TileAction({
  label,
  onClick,
  children,
  testId,
  text = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
  text?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`inline-flex h-7 items-center gap-1.5 rounded bg-[rgba(0,0,0,0.65)] px-2 text-xs text-[#fff] hover:bg-[rgba(0,0,0,0.85)] ${FOCUS}`}
    >
      {children}
      {text ? <span>{label}</span> : null}
    </button>
  );
}

/** The phosphor ring while this person speaks. A leaf: only it re-renders. */
function SpeakingRing({ stream }: { stream: MediaStream | null }) {
  const speaking = useSpeaking(stream);
  if (!speaking) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-inset ring-[#FFBB00]"
      data-testid="speaking-ring"
      aria-hidden
    />
  );
}

const fsSubscribe = (l: () => void) => {
  document.addEventListener("fullscreenchange", l);
  return () => document.removeEventListener("fullscreenchange", l);
};

/** Element fullscreen; iOS falls back to the video element's native fullscreen. */
function useFullscreen(
  target: React.RefObject<HTMLElement | null>,
  video: React.RefObject<HTMLVideoElement | null>,
) {
  const element = useSyncExternalStore(
    fsSubscribe,
    () => document.fullscreenElement,
    () => null,
  );
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    const v = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    setSupported(!!document.fullscreenEnabled || typeof v?.webkitEnterFullscreen === "function");
  }, [video]);
  const active = !!element && element === target.current;
  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    const el = target.current;
    if (el && document.fullscreenEnabled) {
      void el.requestFullscreen().catch(() => {});
      return;
    }
    const v = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    v?.webkitEnterFullscreen?.();
  }, [target, video]);
  return { supported, active, toggle };
}
