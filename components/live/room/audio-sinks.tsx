"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { applySpeaker, useSpeakerId } from "@/components/live/audio-output";
import { resumeAudio } from "./audio-levels";
import type { RoomPeer } from "./types";

/**
 * Remote voices: one hidden <audio> per remote with an audio track, whatever
 * the layout, so a presenter going full-screen or a host with their camera off
 * is still heard. Routed to the chosen speaker. When the browser refuses to
 * autoplay, `onBlocked(true)` lets the room offer "Click to enable sound";
 * `unblock()` (from that click) plays everything.
 */
export function useAudioSinks(): {
  blocked: boolean;
  onBlocked: (b: boolean) => void;
  unblock: () => void;
  register: (el: HTMLAudioElement) => () => void;
} {
  const [blocked, setBlocked] = useState(false);
  const els = useRef(new Set<HTMLAudioElement>());
  const register = useCallback((el: HTMLAudioElement) => {
    els.current.add(el);
    return () => {
      els.current.delete(el);
    };
  }, []);
  const unblock = useCallback(() => {
    void resumeAudio();
    let failed = false;
    const plays = [...els.current].map((el) =>
      el.play().catch(() => {
        failed = true;
      }),
    );
    void Promise.all(plays).then(() => setBlocked(failed));
  }, []);
  return { blocked, onBlocked: setBlocked, unblock, register };
}

export function AudioSinks({
  peers,
  onBlocked,
  register,
}: {
  peers: readonly RoomPeer[];
  onBlocked: (blocked: boolean) => void;
  register: (el: HTMLAudioElement) => () => void;
}) {
  const speakerId = useSpeakerId();
  return (
    <div className="hidden" aria-hidden data-testid="audio-sinks">
      {peers.map((p) =>
        p.streams.audio && p.state !== "left" ? (
          <Sink
            key={p.peerId}
            stream={p.streams.audio}
            speakerId={speakerId}
            onBlocked={onBlocked}
            register={register}
          />
        ) : null,
      )}
    </div>
  );
}

function Sink({
  stream,
  speakerId,
  onBlocked,
  register,
}: {
  stream: MediaStream;
  speakerId: string;
  onBlocked: (blocked: boolean) => void;
  register: (el: HTMLAudioElement) => () => void;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const unregister = register(el);
    if (el.srcObject !== stream) el.srcObject = stream;
    el.play()
      .then(() => onBlocked(false))
      .catch((e: { name?: string }) => {
        if (e?.name === "NotAllowedError") onBlocked(true);
      });
    return unregister;
  }, [stream, onBlocked, register]);
  useEffect(() => {
    const el = ref.current;
    if (el) void applySpeaker(el, speakerId);
  }, [speakerId]);
  return <audio ref={ref} autoPlay playsInline data-testid="audio-sink" />;
}
