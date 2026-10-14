"use client";
import { useEffect, useRef, useState } from "react";
import { MonitorUp } from "lucide-react";
import { RoomButton } from "./ui";

/**
 * What a screen-sharing presenter sees instead of their own capture (which
 * would mirror itself endlessly): a short note, a small preview they can hide,
 * and Stop.
 */
export function PresentingScreen({ stream, onStop }: { stream: MediaStream | null; onStop: () => void }) {
  const [preview, setPreview] = useState(true);
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (stream) el.play?.().catch(() => {});
  }, [stream, preview]);
  return (
    <div
      className="grid h-full w-full place-items-center overflow-auto rounded-md bg-[#141416] p-4"
      data-testid="presenting-self"
    >
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <MonitorUp className="h-6 w-6 text-[#FFBB00]" aria-hidden />
        <p className="mt-2 text-base font-medium text-[#f4f4f5]">You&rsquo;re presenting</p>
        <p className="mt-1 text-sm text-[#a1a1aa]">Everyone sees your screen.</p>
        {preview && stream ? (
          <video
            ref={ref}
            muted
            autoPlay
            playsInline
            className="mt-4 aspect-video w-full max-w-[280px] rounded-md bg-[#000] object-contain ring-1 ring-[#34343a]"
            data-testid="presenting-preview"
          />
        ) : null}
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <RoomButton variant="danger" onClick={onStop} data-testid="presenting-stop">
            Stop presenting
          </RoomButton>
          <RoomButton variant="ghost" onClick={() => setPreview((p) => !p)}>
            {preview ? "Hide preview" : "Show preview"}
          </RoomButton>
        </div>
      </div>
    </div>
  );
}
