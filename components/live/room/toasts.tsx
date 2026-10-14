"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, Info, X } from "lucide-react";
import { FOCUS } from "./ui";

/**
 * Short messages. The provider hands back the list; the room decides where
 * it goes (the top of the stage, or inside the phone's chat sheet) so a toast
 * never covers the control bar, the filmstrip or the chat composer.
 * Same message twice is shown once. Errors stay longer.
 */

export type Toast = {
  id: string;
  message: string;
  tone: "info" | "error";
  action?: { label: string; onClick: () => void };
  /** Stays until dismissed or removed. */
  sticky?: boolean;
  onDismiss?: () => void;
};

type ToastApi = {
  push: (t: Omit<Toast, "id"> & { id?: string }) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export function useToasts(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToasts outside ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: (toasts: ReactNode, count: number) => ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const current = useRef<Toast[]>([]);
  useEffect(() => {
    current.current = toasts;
  }, [toasts]);

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    current.current.find((x) => x.id === id)?.onDismiss?.();
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (input: Omit<Toast, "id"> & { id?: string }) => {
      const id = input.id ?? `${input.tone}:${input.message}`;
      setToasts((list) => {
        const without = list.filter((x) => x.id !== id);
        return [...without, { ...input, id }].slice(-3);
      });
      const old = timers.current.get(id);
      if (old) clearTimeout(old);
      timers.current.delete(id);
      if (!input.sticky) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), input.tone === "error" ? 8000 : 4000),
        );
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach((t) => clearTimeout(t));
  }, []);

  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  const layer = (
    <div
      className="pointer-events-none flex w-full flex-col items-center gap-2"
      aria-live="polite"
      data-testid="room-toasts"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          className="pointer-events-auto flex max-w-[min(560px,100%)] items-start gap-2.5 rounded-md border border-[#34343a] bg-[#1b1b1f] py-2 pl-3 pr-1.5 text-sm text-[#f4f4f5] shadow-[0_6px_20px_rgba(0,0,0,0.45)]"
        >
          {t.tone === "error" ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#ffb224]" aria-hidden />
          ) : (
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#a1a1aa]" aria-hidden />
          )}
          <span className="min-w-0 flex-1 py-0.5">{t.message}</span>
          {t.action ? (
            <button
              type="button"
              onClick={() => {
                t.action?.onClick();
                dismiss(t.id);
              }}
              className={`shrink-0 rounded px-2 py-1 text-sm font-semibold text-[#FFBB00] hover:bg-[#2a2a30] ${FOCUS}`}
            >
              {t.action.label}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
            className={`shrink-0 rounded p-1 text-[#a1a1aa] hover:bg-[#2a2a30] hover:text-[#fff] ${FOCUS}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );

  return <ToastContext.Provider value={api}>{children(layer, toasts.length)}</ToastContext.Provider>;
}
