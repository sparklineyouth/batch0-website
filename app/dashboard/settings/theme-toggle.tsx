"use client";
import { useEffect, useState } from "react";
import { Sun, Moon } from "lucide-react";
import { useTheme } from "next-themes";
import type { Theme } from "@/lib/types";

/**
 * Appearance control for the product settings pages. Wired to the single
 * site-wide next-themes controller (see components/theme-provider), so the
 * choice here is the SAME theme used on the marketing site and persists across
 * every page and reload. `initial` is an optional pre-mount hint to avoid a
 * flash of the wrong active pill before hydration.
 */
export function ThemeToggle({ initial }: { initial?: Theme }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const current = mounted ? resolvedTheme : initial;

  const pill = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition ${
      active ? "bg-phosphor text-on-phosphor" : "text-ink-soft hover:text-ink"
    }`;

  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-line bg-paper p-1">
      <button type="button" onClick={() => setTheme("dark")} className={pill(current === "dark")}>
        <Moon className="h-3.5 w-3.5" /> Dark
      </button>
      <button type="button" onClick={() => setTheme("light")} className={pill(current === "light")}>
        <Sun className="h-3.5 w-3.5" /> Light
      </button>
    </div>
  );
}
