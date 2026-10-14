"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  LiveRoom,
  usePresentation,
  type LiveRoomProps,
  type PanelTab,
  type PresentationController,
  type RoomPeer,
  type RoomRecordingView,
} from "@/components/live/room";
import { useLocalMedia } from "@/components/live/use-local-media";
import { LocalTime } from "@/components/ui/local-time";
import { FakePanel, FakeReactionsButton, FakeReactionsOverlay } from "./fake-panel";
import { makeDeckPdf, useFakeFeeds, useFakeLocalMedia, type FakeFeeds } from "./fake-media";
import { HARNESS_STATES as STATES } from "./states";

/**
 * The room on fake data: every state of <LiveRoom/> without a server, a
 * second browser or a camera. /dev/live lists the states (./states.ts);
 * `npm run room-screens` screenshots them.
 */

const SELF = { id: "me", name: "Rish" };
const ANA = { id: "ana", name: "Ana Ruiz" };
const BEN = { id: "ben", name: "Ben Okafor" };
const CY = { id: "cy", name: "Cy Tan" };
const DI = { id: "di", name: "Di Park" };

type Opts = { state: string; w: string; realMedia: boolean };

export function Harness({ state, w, realMedia }: Opts) {
  if (!state || !STATES[state]) return <Index />;
  return <Scenario key={`${state}:${w}:${realMedia}`} state={state} w={w || STATES[state][0]} realMedia={realMedia} />;
}

function Index() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10 font-sans text-sm">
      <h1 className="text-lg font-semibold">Live room harness</h1>
      <p className="mt-1 text-ink-soft">Fake session, no server. Add &amp;media=real to use your camera.</p>
      <ul className="mt-6 space-y-3">
        {Object.entries(STATES).map(([s, variants]) => (
          <li key={s}>
            <span className="font-medium">{s}</span>
            <span className="ml-2 inline-flex flex-wrap gap-x-3 gap-y-1">
              {variants.map((v) => (
                <Link key={v} className="underline decoration-phosphor decoration-2" href={`/dev/live?state=${s}&w=${v}`}>
                  {v}
                </Link>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}

function peer(
  who: { id: string; name: string },
  feeds: FakeFeeds,
  opts: {
    camera?: boolean;
    voice?: boolean;
    screen?: [number, number] | null;
    state?: RoomPeer["state"];
    seenLive?: boolean;
    hue?: number;
    freq?: number;
    offset?: number;
  } = {},
): RoomPeer {
  const state = opts.state ?? "live";
  const carrying = state === "live" || state === "reconnecting";
  return {
    peerId: who.id,
    name: who.name,
    state,
    seenLive: opts.seenLive ?? carrying,
    streams: carrying
      ? {
          camera: opts.camera === false ? undefined : feeds.camera(who.name, opts.hue ?? 30),
          audio: opts.voice === false ? undefined : feeds.voice(opts.freq ?? 220, opts.offset ?? 0),
          screen: opts.screen ? feeds.screen(`${who.name}'s screen`, opts.screen[0], opts.screen[1]) : undefined,
        }
      : {},
  };
}

/**
 * A recording with useRoomRecording's semantics: `mine` only while this tab
 * records; another host's take shows as `by` with this tab left idle;
 * `elapsedMs` is a getter and nothing re-renders per second.
 */
function useFakeRecording(initial: "idle" | "mine" | "other", pendingUploads = 0): RoomRecordingView {
  const [state, setState] = useState<RoomRecordingView["state"]>(initial === "mine" ? "recording" : "idle");
  const [startedAt, setStartedAt] = useState<number | null>(() => (initial === "idle" ? null : Date.now() - 754_000));
  const mine = state === "recording";
  const other = initial === "other";
  return useMemo(() => {
    const since = mine || other ? startedAt : null;
    return {
      state,
      mine,
      by: mine ? { id: SELF.id, name: SELF.name } : other ? { id: ANA.id, name: ANA.name } : null,
      get elapsedMs() {
        return since !== null ? Math.max(0, Date.now() - since) : 0;
      },
      error: null,
      pendingUploads,
      start: () => {
        setState("starting");
        setTimeout(() => {
          setStartedAt(Date.now());
          setState("recording");
        }, 600);
      },
      stop: () => {
        setState("stopping");
        setTimeout(() => {
          setStartedAt(null);
          setState("idle");
        }, 600);
      },
    };
  }, [state, mine, other, startedAt, pendingUploads]);
}

/** A presentation controller frozen in "presenting a screen" (no picker needed). */
function fakeScreenPresentation(base: PresentationController, stream: MediaStream, stop: () => void): PresentationController {
  return { ...base, kind: "screen", stream, startedAt: Date.now() - 60_000, stop };
}

function Scenario({ state, w, realMedia }: { state: string; w: string; realMedia: boolean }) {
  const feeds = useFakeFeeds();
  if (!feeds) return null;
  return <ScenarioBody state={state} w={w} realMedia={realMedia} feeds={feeds} />;
}

function ScenarioBody({ state, w, realMedia, feeds }: { state: string; w: string; realMedia: boolean; feeds: FakeFeeds }) {
  const isCall = state.startsWith("call") || w === "call" || w === "left-call" || w === "cancelled";
  const kind: LiveRoomProps["kind"] = isCall ? "call" : "webinar";
  const viewer =
    !isCall &&
    (state === "live-viewer" ||
      (state === "prejoin" && w === "viewer") ||
      (state === "connecting" && w === "viewer") ||
      (state === "presenting-screen" && (w === "viewer" || w === "portrait")) ||
      (state === "presenting-deck" && w === "viewer") ||
      (state === "ended" && ["viewer", "reopened", "left", "closed", "revoked"].includes(w)));
  const broadcaster = !viewer;

  // Phase and session state.
  let initialPhase: LiveRoomProps["phase"] = "live";
  if (state === "prejoin") initialPhase = "prejoin";
  else if (state === "ended") {
    if (w === "left" || w === "left-call") initialPhase = "left";
    else if (w === "closed" || w === "revoked") initialPhase = "closed";
    else initialPhase = "ended";
  }
  const [phase, setPhase] = useState<LiveRoomProps["phase"]>(initialPhase);
  const [busy, setBusy] = useState<LiveRoomProps["busy"]>(null);
  const [joined, setJoined] = useState(state !== "connecting" && !(state === "live-viewer" && w === "failed") && !(state === "live-host" && w === "failed"));
  const [joinFailed, setJoinFailed] = useState(w === "failed");
  const [primaryId, setPrimaryId] = useState<string | null>(
    state === "live-host" ? SELF.id : isCall ? null : ANA.id,
  );
  const [endedByMe, setEndedByMe] = useState(w === "byme");
  // Rehearsal: the go-live window opens in two hours.
  const [opensAt] = useState(() => new Date(Date.now() + 2 * 3600_000).toISOString());

  const fakeMedia = useFakeLocalMedia(feeds, SELF.name, {
    cameraOn: !(state === "prejoin" && w === "cohost"),
    micOn: !(state === "prejoin" && w === "cohost"),
    status: w === "denied" ? "denied" : undefined,
    cameraBusy: w === "busycam",
  });
  const real = useLocalMedia({ autoStart: realMedia && broadcaster });
  const media = broadcaster ? (realMedia ? real : fakeMedia) : null;

  const deckPdf = useMemo(() => makeDeckPdf(14), []);
  // Made in an effect (not a memo) so StrictMode's re-run can't revoke the URL in use.
  const [eventDeckUrl, setEventDeckUrl] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([deckPdf as BlobPart], { type: "application/pdf" }));
    setEventDeckUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [deckPdf]);
  const eventDeck = useMemo(
    () => (kind === "webinar" && eventDeckUrl ? { url: eventDeckUrl, name: "Week 3 - Pricing.pdf" } : null),
    [kind, eventDeckUrl],
  );
  const realPresentation = usePresentation({ enabled: broadcaster, eventDeck });

  // presenting-deck: open the generated PDF on arrival (file or event deck).
  const { startDeck, stop: stopPresenting } = realPresentation;
  useEffect(() => {
    if (state !== "presenting-deck" || viewer) return;
    if (w === "event") startDeck("event");
    else startDeck(new File([deckPdf as BlobPart], "Generated deck.pdf", { type: "application/pdf" }));
    return stopPresenting;
  }, [state, w, viewer, deckPdf, startDeck, stopPresenting]);

  const [fakeScreenOn, setFakeScreenOn] = useState(state === "presenting-screen" && w === "self");
  const presentation: PresentationController | null = !broadcaster
    ? null
    : fakeScreenOn
      ? fakeScreenPresentation(realPresentation, feeds.screen("Your screen", 1512, 982), () => setFakeScreenOn(false))
      : realPresentation;

  // Remotes for each scenario.
  const remotes = useMemo<RoomPeer[]>(() => {
    switch (state) {
      case "connecting":
        return [];
      case "live-host":
        if (w === "solo" || w.startsWith("rehearsal")) return [];
        return [
          peer(BEN, feeds, { hue: 140, freq: 260, offset: 3000, state: w === "reconnecting" ? "reconnecting" : "live" }),
        ];
      case "live-viewer":
        if (w === "waiting" || w === "starts") return [];
        if (w === "away") return [peer(ANA, feeds, { state: "left", seenLive: true })];
        // Joined while Ana is on air; the link to her is still being set up.
        if (w === "joining") return [peer(ANA, feeds, { state: "connecting", seenLive: false })];
        if (w === "reconnecting") return [peer(ANA, feeds, { state: "connecting", seenLive: true })];
        if (w === "failed") return [];
        return [peer(ANA, feeds, { hue: 20, freq: 210 }), peer(BEN, feeds, { hue: 140, freq: 260, offset: 3000 })];
      case "presenting-screen":
        if (w === "self") return [peer(ANA, feeds, { hue: 20, freq: 210 })];
        if (w === "call") return [peer(ANA, feeds, { hue: 20, screen: [1440, 900] })];
        return [
          peer(ANA, feeds, { hue: 20, freq: 210, screen: w === "portrait" ? [900, 1400] : [1440, 900] }),
          peer(BEN, feeds, { hue: 140, freq: 260, offset: 3000 }),
        ];
      case "presenting-deck":
        if (w === "viewer") return [peer(ANA, feeds, { hue: 20, screen: [1920, 1080] })];
        // Ana (the primary) shares her screen: it keeps the stage, our slides wait.
        if (w === "behind") return [peer(ANA, feeds, { hue: 20, freq: 210, screen: [1440, 900] })];
        return [peer(ANA, feeds, { hue: 20, freq: 210 })];
      case "call-2":
        if (w === "waiting") return [peer(ANA, feeds, { state: "connecting", seenLive: false })];
        if (w === "left") return [peer(ANA, feeds, { state: "left", seenLive: true })];
        return [peer(ANA, feeds, { hue: 20, freq: 210, screen: w === "present" ? [1280, 800] : null })];
      case "call-4":
        return [
          peer(ANA, feeds, { hue: 20, freq: 210, screen: w === "present" ? [1440, 900] : null }),
          peer(BEN, feeds, { hue: 140, freq: 260, offset: 3000, state: w === "reconnecting" ? "reconnecting" : "live" }),
          peer(CY, feeds, { hue: 280, camera: false, freq: 300, offset: 1000 }),
        ];
      default:
        return [];
    }
  }, [state, w, feeds]);

  // Small extras for call-4 so 4+ grid looks real.
  const allRemotes = useMemo(
    () => (state === "call-4" && w === "default" ? [...remotes, peer(DI, feeds, { hue: 60, voice: false })] : remotes),
    [remotes, state, w, feeds],
  );

  const recording = useFakeRecording(
    w === "rec" ? "mine" : w === "rec-other" ? "other" : "idle",
    state === "ended" && w === "uploading" ? 3 : 0,
  );
  const canRecord = broadcaster && (isCall || state === "live-host" || state.startsWith("presenting"));

  const panel = useMemo<LiveRoomProps["panel"]>(() => {
    if (kind !== "webinar") return null;
    const tabs: PanelTab[] = broadcaster ? ["chat", "qa", "polls", "people"] : ["chat", "qa", "polls"];
    return { tabs, render: (ctx) => <FakePanel tabs={tabs} {...ctx} /> };
  }, [kind, broadcaster]);

  const later = (fn: () => void, ms = 700) => setTimeout(fn, ms);
  const actions = useMemo<LiveRoomProps["actions"]>(
    () => ({
      join: () => {
        setBusy("joining");
        later(() => {
          setBusy(null);
          setPhase("live");
          setJoined(false);
          later(() => setJoined(true), 900);
        });
      },
      leave: () => {
        setBusy("leaving");
        later(() => {
          setBusy(null);
          setPhase("left");
        }, 300);
      },
      end: () => {
        setBusy("ending");
        later(() => {
          setBusy(null);
          setEndedByMe(true);
          setPhase("ended");
        });
      },
      rejoin: () => setPhase("prejoin"),
      reopen: () => {
        setBusy("reopening");
        later(() => {
          setBusy(null);
          setPhase("live");
        });
      },
      retry: () => {
        setJoinFailed(false);
        later(() => setJoined(true), 600);
      },
      pinForEveryone: (id: string) => {
        setPrimaryId(id);
        return Promise.resolve({ ok: true as const });
      },
    }),
    [],
  );

  const onSharedLayout = useCallback((l: { mainId: string | null; mainIsPresentation: boolean }) => {
    (window as unknown as { __b0layout?: unknown }).__b0layout = l;
  }, []);

  // Playwright hooks: the presentation stream, for frame checks.
  useEffect(() => {
    (window as unknown as { __b0harness?: unknown }).__b0harness = {
      presentationStream: () => presentation?.stream ?? null,
      deckSnapshot: () => realPresentation.deck?.getSnapshot() ?? null,
      deck: () => realPresentation.deck,
      presentationError: () => realPresentation.error,
    };
  });

  const props: LiveRoomProps = {
    kind,
    title: kind === "call" ? "1:1 with Ana Ruiz" : "Week 3: Pricing your first product",
    self: { id: SELF.id, name: SELF.name, broadcaster, staff: broadcaster && !(state === "prejoin" && w === "cohost") },
    phase,
    backHref: "/dev/live",
    startsAt: w === "starts" ? new Date(Date.now() + 25 * 60_000).toISOString() : new Date(Date.now() - 10 * 60_000).toISOString(),
    media,
    presentation,
    remotes: allRemotes,
    connection: {
      state: w === "reconnecting" && state === "live-host" ? "reconnecting" : joined ? "live" : "connecting",
      joined,
      // Like the engine: a refused join sets `error` too (the room shows it once);
      // a reconnect with an error stacks the banner and the chip.
      error:
        w === "error" || (w === "reconnecting" && state === "live-host")
          ? "Couldn't reach one viewer. Retrying."
          : w === "failed" && joinFailed
            ? "The room isn't open yet."
            : null,
      joinFailed: joinFailed ? { message: "The room isn't open yet." } : null,
    },
    room: {
      primaryId,
      liveStartedAt:
        kind === "webinar" &&
        !(state === "live-viewer" && (w === "waiting" || w === "starts")) &&
        state !== "connecting" &&
        !w.startsWith("rehearsal")
          ? new Date(Date.now() - 754_000).toISOString()
          : null,
      liveEndedAt: null,
      canEnd: broadcaster && !w.startsWith("rehearsal"),
      recording:
        w === "recorded"
          ? { sessionId: "s1", byUserId: SELF.id, byName: SELF.name, startedAt: new Date(Date.now() - 300_000).toISOString() }
          : w === "rec-other"
          ? { sessionId: "s1", byUserId: ANA.id, byName: ANA.name, startedAt: new Date(Date.now() - 754_000).toISOString() }
          : recording.mine
            ? { sessionId: "s1", byUserId: SELF.id, byName: SELF.name, startedAt: new Date().toISOString() }
            : null,
    },
    audienceCount: broadcaster && kind === "webinar" ? 23 : null,
    recording: broadcaster ? recording : null,
    canRecord,
    hosting: state === "prejoin" && w === "cohost" ? [ANA.name] : [],
    recordingNotice:
      kind === "call"
        ? "This call is recorded. Only you, Ana and batch0 admins can watch it."
        : "This webinar is recorded.",
    panel,
    reactions: kind === "webinar" ? { button: <FakeReactionsButton />, overlay: <FakeReactionsOverlay /> } : null,
    end: {
      at: new Date(Date.now() - 5 * 60_000).toISOString(),
      byMe: endedByMe,
      reopened: w === "reopened",
      canReopen: broadcaster && kind === "webinar",
      rejoinUntil: new Date(Date.now() + 2 * 3600_000).toISOString(),
      reason: w === "revoked" ? "revoked" : w === "cancelled" ? "cancelled" : w === "closed" ? "closed" : undefined,
      recording:
        w === "saved"
          ? { saved: true, error: null }
          : w === "rec-error"
            ? { saved: true, error: "Recording stopped. What reached the server is saved." }
            : null,
    },
    busy,
    actionError: w === "toast" ? "Couldn't pin that host. Try again." : null,
    leaveHint: state === "live-host" && w === "leave" ? "You're the only host on air." : null,
    notice:
      state === "live-host" && w.startsWith("rehearsal") ? (
        <span>
          Not live yet: students can join from <LocalTime value={opensAt} mode="time" />
        </span>
      ) : null,
    subline:
      w === "recorded" ? "This call is recorded. Only you, Ana Ruiz and batch0 admins can watch it back." : null,
    rehearsalUntil: state === "prejoin" && w === "rehearsal" ? opensAt : null,
    actions,
    onSharedLayout,
  };

  return <AutoOpen state={state} w={w} props={props} />;
}

/** Opens a menu / dialog / panel on arrival for the `w` variants that show one. */
function AutoOpen({ state, w, props }: { state: string; w: string; props: LiveRoomProps }) {
  useEffect(() => {
    const click = (testId: string) => {
      const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      el?.click();
    };
    const t = setTimeout(() => {
      if (w === "leave") {
        click("ctrl-leave");
        setTimeout(() => click("leave-end"), 150);
      }
      if (w === "devices") {
        if (window.innerWidth >= 640) click("ctrl-settings");
        else {
          click("ctrl-more");
          setTimeout(() => click("more-settings"), 150);
        }
      }
      if ((w === "panel" || w === "toast" || w === "rehearsal-chat") && window.innerWidth < 1024) click("ctrl-panel");
      if (w === "pin-self") document.querySelector<HTMLElement>('[data-testid="stage-pip"] [data-testid="tile-pin"]')?.click();
    }, 400);
    return () => clearTimeout(t);
  }, [state, w]);
  return <LiveRoom {...props} />;
}
