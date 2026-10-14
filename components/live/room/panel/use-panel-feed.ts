"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ROOM_BUMP_DEBOUNCE_MS, ROOM_RESYNC_MS } from "@/lib/live-signal";
import { sortQuestions, type ChatMessage, type RoomQuestion, type WebinarPoll } from "@/lib/webinars";
import {
  applyRead,
  baseFrom,
  contradictedHints,
  emptyReadRequest,
  fullReadRequest,
  mergeReadRequests,
  parseRoomHint,
  pruneOverrides,
  requestFor,
  viewChat,
  viewPinned,
  withOverrides,
  hideRow,
  PANEL_POLL_NO_TOPIC_MS,
  type Override,
  type PanelBase,
  type PanelRead,
  type PanelWrite,
  type ReadRequest,
  type WebinarPanelInitial,
} from "@/lib/webinar-panel";
import { listenRoom } from "./room-channel";

type OverrideMap<T> = Map<string, Override<T>>;
type SetOverrides<T> = (fn: (o: OverrideMap<T>) => OverrideMap<T>) => void;
type Patch<T> = [id: string, patch: (row: T) => T | null];

/**
 * The panel's data: the server's last answer plus optimistic edits, kept
 * fresh by realtime hints, a resync timer, and reads after the tab returns.
 *
 * Reads go to GET /api/live/panel one at a time (a hint during a read is
 * queued, never dropped), so a chat send — a server action — never waits
 * behind them.
 */
export function usePanelFeed({
  eventId,
  initial,
  roomTopic,
  moderationTopic,
  live,
}: {
  eventId: string;
  initial: WebinarPanelInitial;
  roomTopic: string | null;
  moderationTopic: string | null;
  live: boolean;
}) {
  const [base, setBase] = useState<PanelBase>(() => baseFrom(initial));
  const [chatO, setChatO] = useState<OverrideMap<ChatMessage>>(() => new Map());
  const [qaO, setQaO] = useState<OverrideMap<RoomQuestion>>(() => new Map());
  const [pollO, setPollO] = useState<OverrideMap<WebinarPoll>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  const baseRef = useRef(base);
  baseRef.current = base;

  // --- reads ---------------------------------------------------------------

  const inFlight = useRef(false);
  /** Ids whose removal hint a read contradicted: their hints only trigger reads. */
  const distrusted = useRef(new Set<string>());
  const queued = useRef<ReadRequest | null>(null);
  const failures = useRef(0);
  const readRef = useRef<(req: ReadRequest) => void>(() => {});

  const read = useCallback(
    async (req: ReadRequest) => {
      if (inFlight.current) {
        queued.current = queued.current ? mergeReadRequests(queued.current, req) : req;
        return;
      }
      if (req.parts.size === 0) return;
      inFlight.current = true;
      const startedAt = Date.now();
      const since =
        req.parts.has("chat") && !req.fullChat ? baseRef.current.cursor : null;
      const q = new URLSearchParams({ event: eventId, parts: [...req.parts].join(",") });
      if (since) q.set("since", since);
      try {
        const res = await fetch(`/api/live/panel?${q}`, { cache: "no-store" });
        if (res.status === 200) {
          const next = (await res.json()) as PanelRead;
          baseRef.current = applyRead(baseRef.current, next);
          setBase(baseRef.current);
          if (next.chat) {
            const ids = new Set(next.chat.messages.map((m) => m.id));
            const full = next.chat.full;
            setChatO((o) => {
              // Idempotent, so safe in an updater React may run twice.
              if (full) {
                for (const id of contradictedHints(o, startedAt, ids)) distrusted.current.add(id);
              }
              return pruneOverrides(o, startedAt, full ? undefined : ids);
            });
          }
          if (next.questions) setQaO((o) => pruneOverrides(o, startedAt));
          if (next.polls) setPollO((o) => pruneOverrides(o, startedAt));
        }
        // 204 (window closed under us) is a non-answer, not a failure.
        if (res.ok) failures.current = 0;
        else failures.current += 1;
      } catch {
        failures.current += 1;
      } finally {
        setOffline(failures.current >= 3);
        inFlight.current = false;
        const next = queued.current;
        queued.current = null;
        if (next) readRef.current(next);
      }
    },
    [eventId],
  );
  readRef.current = (req) => void read(req);

  // Hints are debounced into one read of exactly the parts they named.
  const pendingHint = useRef<ReadRequest>(emptyReadRequest());
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedule = useCallback((req: ReadRequest) => {
    pendingHint.current = mergeReadRequests(pendingHint.current, req);
    if (hintTimer.current) return;
    hintTimer.current = setTimeout(() => {
      hintTimer.current = null;
      const r = pendingHint.current;
      pendingHint.current = emptyReadRequest();
      readRef.current(r);
    }, ROOM_BUMP_DEBOUNCE_MS);
  }, []);
  useEffect(
    () => () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
    },
    [],
  );

  // --- realtime + resync (only while the session is live) ------------------

  useEffect(() => {
    if (!live) return;
    const onPayload = (payload: unknown) => {
      const hint = parseRoomHint(payload);
      if (!hint || hint.kind !== "bump") return;
      if (hint.removed && !distrusted.current.has(hint.removed)) {
        // Drop it now; the full read this schedules confirms it — or, for a
        // forged hint, brings the row straight back.
        const id = hint.removed;
        setChatO((o) =>
          new Map(o).set(id, { settledAt: Date.now(), patch: hideRow, fromHint: true }),
        );
      }
      schedule(requestFor(emptyReadRequest(), hint));
    };
    const offs = [roomTopic, moderationTopic]
      .filter((t): t is string => !!t)
      .map((t) => listenRoom(t, onPayload));
    return () => offs.forEach((off) => off());
  }, [live, roomTopic, moderationTopic, schedule]);

  useEffect(() => {
    if (!live) return;
    const every = roomTopic ? ROOM_RESYNC_MS : PANEL_POLL_NO_TOPIC_MS;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      timer ??= setInterval(() => readRef.current(fullReadRequest()), every);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) return stop();
      readRef.current(fullReadRequest());
      start();
    };
    // Catch up on whatever happened before the session went live.
    readRef.current(fullReadRequest());
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [live, roomTopic]);

  // --- writes --------------------------------------------------------------

  /**
   * Apply patches now, call the server, then either settle them (a read that
   * starts after this moment carries the truth) or roll them back and say why.
   * A later write to the same row replaces the override; settling checks it is
   * still ours.
   */
  const write = useCallback(
    async <T, R>(
      set: SetOverrides<T>,
      patches: Patch<T>[],
      call: () => Promise<PanelWrite<R>>,
    ): Promise<PanelWrite<R>> => {
      set((o) => {
        const n = new Map(o);
        for (const [id, patch] of patches) n.set(id, { settledAt: null, patch });
        return n;
      });
      let res: PanelWrite<R>;
      try {
        res = await call();
      } catch {
        res = { ok: false, error: "Couldn't reach the server." };
      }
      set((o) => {
        const n = new Map(o);
        for (const [id, patch] of patches) {
          const cur = n.get(id);
          if (cur?.patch !== patch) continue;
          if (res.ok) n.set(id, { ...cur, settledAt: Date.now() });
          else n.delete(id);
        }
        return n;
      });
      setError(res.ok ? null : res.error);
      return res;
    },
    [],
  );

  /** Show a row the server has confirmed (an own send) before a read returns it. */
  const insertChat = useCallback((row: ChatMessage) => {
    setChatO((o) => new Map(o).set(row.id, { settledAt: Date.now(), insert: row }));
  }, []);
  const insertQuestion = useCallback((row: RoomQuestion) => {
    setQaO((o) => new Map(o).set(row.id, { settledAt: Date.now(), insert: row }));
  }, []);

  const refreshPolls = useCallback(() => schedule({ parts: new Set(["poll"]), fullChat: false }), [schedule]);

  // --- what is drawn -------------------------------------------------------

  const chat = useMemo(() => viewChat(base, chatO), [base, chatO]);
  const pinned = useMemo(() => viewPinned(base, chat, chatO), [base, chat, chatO]);
  const questions = useMemo(
    () => sortQuestions(withOverrides(base.questions, qaO)),
    [base.questions, qaO],
  );
  const polls = useMemo(() => withOverrides(base.polls, pollO), [base.polls, pollO]);

  return {
    audienceMode: base.audienceMode,
    chat,
    pinned,
    questions,
    polls,
    error,
    offline,
    clearError: useCallback(() => setError(null), []),
    showError: setError,
    write,
    setChatO,
    setQaO,
    setPollO,
    insertChat,
    insertQuestion,
    refreshPolls,
  };
}

export type PanelFeed = ReturnType<typeof usePanelFeed>;
