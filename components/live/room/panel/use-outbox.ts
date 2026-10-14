"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  newRowId,
  retryDelayMs,
  OUTBOX_MAX_ATTEMPTS,
  type PanelWrite,
} from "@/lib/webinar-panel";

export type OutboxItem = {
  /** Client-minted row id: a retry can never post twice. */
  id: string;
  body: string;
  state: "sending" | "failed";
  error: string | null;
};

type Job = { id: string; body: string; attempts: number };

/**
 * Sends one at a time, in order, without ever locking the composer. A
 * refusal worth retrying (rate limit, a dropped connection) is retried with
 * backoff; anything else, or too many attempts, waits for Retry / Discard.
 */
export function useOutbox<T>({
  send,
  onSent,
}: {
  send: (id: string, body: string) => Promise<PanelWrite<T>>;
  onSent: (row: T) => void;
}) {
  const [items, setItems] = useState<OutboxItem[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const queue = useRef<Job[]>([]);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const sendRef = useRef(send);
  sendRef.current = send;
  const onSentRef = useRef(onSent);
  onSentRef.current = onSent;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const setItem = useCallback((id: string, patch: Partial<OutboxItem> | null) => {
    setItems((list) =>
      patch === null
        ? list.filter((i) => i.id !== id)
        : list.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    );
  }, []);

  const pump = useCallback(async () => {
    if (busy.current || timer.current || !alive.current) return;
    const job = queue.current[0];
    if (!job) return;
    busy.current = true;
    job.attempts += 1;
    setItem(job.id, { state: "sending", error: null });
    let res: PanelWrite<T>;
    try {
      res = await sendRef.current(job.id, job.body);
    } catch {
      res = { ok: false, error: "Couldn't reach the server.", retryInMs: 0 };
    }
    busy.current = false;
    if (!alive.current) return;
    const queued = queue.current.includes(job);
    if (res.ok) {
      queue.current = queue.current.filter((j) => j !== job);
      setItem(job.id, null);
      onSentRef.current(res.data);
    } else if (queued && res.retryInMs !== undefined && job.attempts < OUTBOX_MAX_ATTEMPTS) {
      timer.current = setTimeout(() => {
        timer.current = null;
        void pump();
      }, retryDelayMs(job.attempts, res.retryInMs));
      return;
    } else {
      // Parked: out of the queue, so later messages still go out.
      queue.current = queue.current.filter((j) => j !== job);
      if (queued) setItem(job.id, { state: "failed", error: res.error });
    }
    void pump();
  }, [setItem]);

  const enqueue = useCallback(
    (body: string) => {
      const id = newRowId();
      queue.current.push({ id, body, attempts: 0 });
      setItems((list) => [...list, { id, body, state: "sending", error: null }]);
      void pump();
    },
    [pump],
  );

  const retry = useCallback(
    (id: string) => {
      const item = itemsRef.current.find((i) => i.id === id);
      if (!item || item.state !== "failed") return;
      queue.current.push({ id, body: item.body, attempts: 0 });
      setItem(id, { state: "sending", error: null });
      void pump();
    },
    [pump, setItem],
  );

  const discard = useCallback(
    (id: string) => {
      queue.current = queue.current.filter((j) => j.id !== id);
      setItem(id, null);
    },
    [setItem],
  );

  return { items, enqueue, retry, discard };
}
