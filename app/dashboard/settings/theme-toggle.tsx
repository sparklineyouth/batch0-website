"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sun, Moon } from "lucide-react";
import { setTheme } from "./theme-actions";
import type { Theme } from "@/lib/types";
import { getActionError } from "@/lib/action-error";

export function ThemeToggle({ initial }: { initial: Theme }) {
  const router = useRouter();
  const [theme, setLocal] = useState<Theme>(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function pick(next: Theme) {
    if (next === theme) return;
    const previous = theme;
    setLocal(next);
    setError(undefined);
    // Apply instantly client-side so the user sees the change without
    // waiting for the round-trip.
    if (typeof document !== "undefined") {
      document.documentElement.classList.remove(
        previous === "light" ? "theme-light" : "dark",
      );
      document.documentElement.classList.add(
        next === "light" ? "theme-light" : "dark",
      );
    }
    start(async () => {
      try {
        await setTheme(next);
        router.refresh();
      } catch (e: any) {
        setLocal(previous);
        if (typeof document !== "undefined") {
          document.documentElement.classList.remove(
            next === "light" ? "theme-light" : "dark",
          );
          document.documentElement.classList.add(
            previous === "light" ? "theme-light" : "dark",
          );
        }
        setError(getActionError(e));
      }
    });
  }

  return (
    <div>
      <div className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/30 p-1">
        <button
          type="button"
          onClick={() => pick("dark")}
          disabled={pending}
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition ${
            theme === "dark"
              ? "bg-spark text-black"
              : "text-white/60 hover:text-white"
          }`}
        >
          <Moon className="h-3.5 w-3.5" /> Dark
        </button>
        <button
          type="button"
          onClick={() => pick("light")}
          disabled={pending}
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition ${
            theme === "light"
              ? "bg-spark text-black"
              : "text-white/60 hover:text-white"
          }`}
        >
          <Sun className="h-3.5 w-3.5" /> Light
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
