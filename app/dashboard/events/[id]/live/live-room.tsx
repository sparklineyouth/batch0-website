"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type DailyIframe from "@daily-co/daily-js";
import type { DailyCall } from "@daily-co/daily-js";
import { PreJoin } from "@/components/live/pre-join";
import { LiveDot } from "@/components/live/call-stage";
import { QAPanel } from "@/components/live/qa-panel";
import { Button, ButtonLink } from "@/components/ui/button";
import {
  canSeeRoster,
  headcountLabel,
  type LiveRole,
  type WebinarQuestion,
} from "@/lib/live";
import { AlertTriangle } from "lucide-react";

type Phase = "prejoin" | "joining" | "joined" | "left" | "error";

/**
 * The Daily SDK, fetched once per page load and shared.
 *
 * daily-js is ~264 kB. Importing it inside the click handler meant every join
 * paid a full download-and-parse *after* the user had already committed —
 * dead time on the one action where the room is presumed to be waiting. The
 * green room is the natural place to spend it: someone checking their camera
 * is busy for several seconds, and the module is warm by the time they press
 * the button.
 *
 * Module-level rather than a ref, so leaving and rejoining doesn't re-import,
 * and so the promise is shared if anything else on the page wants it.
 */
let dailyModule: Promise<typeof DailyIframe> | null = null;
function loadDaily(): Promise<typeof DailyIframe> {
  // daily-js touches browser globals as it loads, which is why this is never
  // a static import — a top-level one would execute during SSR.
  dailyModule ??= import("@daily-co/daily-js").then((m) => m.default);
  return dailyModule;
}

/**
 * Warm the connection to the room's origin.
 *
 * Joining opens a WebSocket and pulls media from Daily's edge. Doing the DNS
 * lookup and TLS handshake now, while the user is still looking at their own
 * face, takes that setup off the join path. React 18 has no `preconnect`
 * primitive, so this is injected by hand; it is idempotent per origin.
 */
function preconnect(url: string) {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  if (document.head.querySelector(`link[rel="preconnect"][href="${origin}"]`)) {
    return;
  }
  for (const rel of ["preconnect", "dns-prefetch"]) {
    const link = document.createElement("link");
    link.rel = rel;
    link.href = origin;
    if (rel === "preconnect") link.crossOrigin = "anonymous";
    document.head.appendChild(link);
  }
}

/**
 * Pull something legible out of whatever daily-js threw.
 *
 * A rejected join() is frequently not an Error at all: Daily rejects with
 * plain objects carrying `errorMsg` (sometimes a nested `error.msg`), so
 * reading only `.message` flattened every distinct failure — a room that no
 * longer exists, an expired token, a room at capacity — into one generic
 * sentence. That is precisely what made this class of bug undiagnosable from
 * a screenshot, so the real reason is preferred and the sentence is only the
 * last resort.
 */
function joinErrorMessage(err: any, fallback: string): string {
  const detail =
    err?.errorMsg ?? err?.error?.msg ?? err?.error?.localizedMsg ?? err?.message;
  return typeof detail === "string" && detail.trim() ? detail : fallback;
}

/**
 * A live room, on batch0.org.
 *
 * Two halves. Ours is the green room (device check before anyone is watching)
 * and the chrome around the call; Daily Prebuilt is the call itself, mounted
 * into the container below. We deliberately don't rebuild the grid, screen
 * share, and chat — Prebuilt does those well, and the interesting decisions
 * are all in what we configure it with.
 *
 * The token arrives already minted by the server, after the permission and
 * RLS checks. This component never asks for one and cannot widen what it was
 * given: a viewer token stays a viewer token no matter what happens here.
 */
export function LiveRoom({
  title,
  roomUrl,
  token,
  role,
  backHref,
  displayViewerCount = null,
  qa,
}: {
  title: string;
  roomUrl: string;
  token: string;
  role: LiveRole;
  backHref: string;
  /**
   * Admin-announced headcount shown to everyone in the header. Null = nothing
   * shown here (Daily owns its own participants bar for the host). See
   * `headcountLabel`.
   */
  displayViewerCount?: number | null;
  // Present for webinars, absent for 1:1 calls. When set, the room is a
  // hosted webinar: the audience is hidden, Daily's chat is off, and questions
  // flow through our own Q&A panel instead. A 1:1 has no audience to hide and
  // keeps Daily's built-in chat, so it passes no `qa`.
  qa?: { eventId: string; initialQuestions: WebinarQuestion[] };
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const callRef = useRef<DailyCall | null>(null);
  const [phase, setPhase] = useState<Phase>("prejoin");
  const [error, setError] = useState<string | null>(null);

  // The announced headcount, if the admin set one. Daily manages its own
  // roster, so a host relies on Prebuilt's participants bar for the truth and
  // this only ever renders the announced figure — to everyone, or to no one.
  const headcount = headcountLabel({
    role,
    displayCount: displayViewerCount,
    realCount: null,
  });

  const destroy = useCallback(() => {
    const call = callRef.current;
    callRef.current = null;
    // destroy() releases the camera and tears the iframe out. Skipping it on
    // unmount leaves the device light on after navigating away, which reads
    // as the site still watching you.
    call?.destroy().catch(() => {});
  }, []);

  useEffect(() => destroy, [destroy]);

  // Spend the green room usefully: pull the SDK down and open a connection to
  // the room's origin while the user is still checking their camera, so the
  // Join click has nothing left to wait for. Both are best-effort — a failure
  // here costs the optimisation, not the join, which imports again and gets
  // the same (already settled or in-flight) promise.
  useEffect(() => {
    void loadDaily().catch(() => {});
    preconnect(roomUrl);
  }, [roomUrl]);

  const join = useCallback(
    async ({ cameraOn, micOn }: { cameraOn: boolean; micOn: boolean }) => {
      if (!containerRef.current || callRef.current) return;
      setPhase("joining");
      setError(null);
      try {
        // Almost always already resolved — the green room started this on
        // mount. On a fast click it falls back to awaiting the same in-flight
        // promise rather than starting a second download.
        const Daily = await loadDaily();

        const call = Daily.createFrame(containerRef.current, {
          url: roomUrl,
          token,
          showLeaveButton: true,
          showFullscreenButton: true,
          // The audience-privacy requirement, at the Prebuilt layer.
          //
          // Viewers must not be able to tell how many people are watching, so
          // they get no participants bar. This is the third of three layers —
          // our own UI hides the roster (canSeeRoster), the meeting token sets
          // hasPresence:false so viewers are absent from everyone else's
          // participant list, and this stops Prebuilt's own chrome from
          // showing what the other two withheld.
          showParticipantsBar: canSeeRoster(role),
          showUserNameChangeUI: false,
          iframeStyle: {
            width: "100%",
            height: "100%",
            border: "0",
            borderRadius: "12px",
          },
        });
        callRef.current = call;

        call.on("left-meeting", () => {
          setPhase("left");
          destroy();
        });
        call.on("error", (e: any) => {
          setError(joinErrorMessage(e, "The call ended unexpectedly."));
          setPhase("error");
        });

        await call.join({
          url: roomUrl,
          token,
          // Honour what they chose in the green room. A viewer has no devices
          // to start in the first place — owner_only_broadcast means the room
          // itself refuses them media — so this only affects hosts.
          startVideoOff: role !== "host" || !cameraOn,
          startAudioOff: role !== "host" || !micOn,
        });
        setPhase("joined");
      } catch (err: any) {
        setError(joinErrorMessage(err, "Could not connect to the room."));
        setPhase("error");
        destroy();
      }
    },
    [roomUrl, token, role, destroy],
  );

  if (phase === "left") {
    return (
      <Centered title="You've left the call">
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => router.refresh()}>Rejoin</Button>
          <ButtonLink variant="secondary" href={backHref}>
            Back
          </ButtonLink>
        </div>
      </Centered>
    );
  }

  if (phase === "error") {
    return (
      <Centered title="Couldn't join">
        <div className="mx-auto mb-4 flex max-w-md items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-400/10 p-3 text-left">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-xs text-ink-soft">{error}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => router.refresh()}>Try again</Button>
          <ButtonLink variant="secondary" href={backHref}>
            Back
          </ButtonLink>
        </div>
      </Centered>
    );
  }

  return (
    <div className={qa ? "mx-auto max-w-6xl" : "mx-auto max-w-5xl"}>
      {/*
        The container is mounted at all times, not conditionally. Daily needs a
        real element to attach to at the moment createFrame runs, and mounting
        it only once phase === "joining" means the ref is still null when the
        click handler fires.
      */}
      <div className={phase === "prejoin" ? "hidden" : "block"}>
        <header className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="truncate font-display text-lg font-semibold tracking-[-0.02em] text-ink">
              {title}
            </h1>
            {phase === "joined" && <LiveDot />}
          </div>
          <div className="flex items-center gap-2 text-xs text-ink-faint">
            {headcount && (
              <span>{headcount.count.toLocaleString()} watching</span>
            )}
            <span
              className={`shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                role === "host"
                  ? "border-phosphor/50 bg-phosphor/10 text-phosphor-ink"
                  : "border-line text-ink-faint"
              }`}
            >
              {role === "host" ? "Hosting" : "Watching"}
            </span>
          </div>
        </header>
        {/*
          Webinar: video and the Q&A panel side by side on desktop, stacked on
          mobile. 1:1: video only, full width. The container itself is the same
          element in both — only what sits next to it changes.
        */}
        <div className="flex flex-col gap-3 lg:flex-row">
          {/*
            The video container is wrapped rather than positioned directly,
            because Daily replaces this element's contents with its own iframe —
            anything rendered as a sibling *inside* it would be blown away on
            join. The overlay sits on the wrapper instead.
          */}
          <div className="relative min-w-0 flex-1">
            <div
              ref={containerRef}
              className="h-[60vh] min-h-[360px] w-full overflow-hidden rounded-xl border border-line bg-ink-900 lg:h-[70vh]"
            />
            {phase === "joining" && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl bg-ink-900/80">
                <div className="flex flex-col items-center gap-3">
                  <span className="h-7 w-7 animate-spin rounded-full border-2 border-line border-t-phosphor" />
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
                    Connecting
                  </p>
                </div>
              </div>
            )}
          </div>
          {qa && phase !== "prejoin" && (
            <div className="h-[50vh] min-h-[320px] w-full shrink-0 lg:h-[70vh] lg:w-80">
              <QAPanel
                eventId={qa.eventId}
                role={role}
                initialQuestions={qa.initialQuestions}
              />
            </div>
          )}
        </div>
      </div>

      {phase === "prejoin" && (
        <PreJoin
          title={title}
          subtitle={
            role === "host"
              ? "You're the host — your camera and mic will be live."
              : qa
                ? // Not "use the chat": in a webinar, Daily's chat is off for
                  // viewers (a hidden participant can read it but not send),
                  // which is exactly why the Q&A panel exists. Promising chat
                  // sends them looking for a control that isn't there.
                  "Your camera and mic stay off, and nobody can see who else is here. You can ask questions beside the video."
                : "You'll be able to watch and listen."
          }
          role={role}
          onJoin={join}
          joinLabel={role === "host" ? "Start" : "Join"}
        />
      )}
    </div>
  );
}

function Centered({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-2xl py-16 text-center">
      <h1 className="font-display text-2xl font-semibold tracking-[-0.02em] text-ink">
        {title}
      </h1>
      <div className="mt-5">{children}</div>
    </div>
  );
}
