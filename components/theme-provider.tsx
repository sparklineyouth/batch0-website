"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * The single theme controller for the ENTIRE site — marketing, auth, and the
 * authenticated product app — so a visitor's choice persists across every page
 * (hero → login → dashboard → admin) and every reload.
 *
 * It maps its two themes onto the class names both surfaces already understand
 * and sets that class on <html>:
 *   light → `theme-light`  (marketing tokens go light; the app's light compat
 *                            layer in globals.css flips its dark-authored
 *                            utilities to light)
 *   dark  → `dark`         (marketing tokens go dark; the app renders its
 *                            native dark-authored palette)
 * defaultTheme "system" follows the OS on first visit; next-themes' inline
 * script applies the class before paint (no flash), which is why <html> needs
 * suppressHydrationWarning in the root layout.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      value={{ light: "theme-light", dark: "dark" }}
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
