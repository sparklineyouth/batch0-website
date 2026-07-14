"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";

/**
 * Light/dark switch for the marketing navbar. Flips between explicit light and
 * dark (not back to "system") so a deliberate choice sticks; next-themes
 * persists it to localStorage and re-applies it before paint (no flash).
 *
 * Rendering is gated on `mounted` because the server can't know the resolved
 * theme — until hydration we render a stable, theme-neutral icon to avoid a
 * hydration mismatch, while the button stays clickable.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={
        mounted
          ? isDark
            ? "Switch to light mode"
            : "Switch to dark mode"
          : "Toggle theme"
      }
      title={mounted ? (isDark ? "Light mode" : "Dark mode") : "Toggle theme"}
      className={`press flex h-9 w-9 items-center justify-center rounded-md border border-line text-ink-soft transition-colors duration-200 hover:bg-wash hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${className}`}
    >
      {/* Before mount, show a fixed icon so SSR and the first client render
          agree. suppressHydrationWarning covers the post-mount icon swap. */}
      <span suppressHydrationWarning>
        {mounted && isDark ? (
          <Sun size={17} aria-hidden />
        ) : (
          <Moon size={17} aria-hidden />
        )}
      </span>
    </button>
  );
}
