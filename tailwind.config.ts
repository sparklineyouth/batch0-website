import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // The one accent: amber CRT phosphor, sampled straight from the
        // batch0 wordmark (#FFBB00). The ramp is built around 300 = DEFAULT;
        // 200 is the hover lift, 400/500 are pressed//muted states.
        phosphor: {
          // CHROME amber — theme-reactive: #FFBB00 on phosphor (dark),
          // burnt #8A5A00 on paper (light) so amber-as-text stays AA.
          DEFAULT: "rgb(var(--phosphor-rgb) / <alpha-value>)",
          // FILL amber — constant in both themes; always pairs with
          // text-on-phosphor (#141414). Buttons, highlight blocks, cursor.
          fill: "#FFBB00",
          "fill-hover": "#FFD75C",
          50: "#FFF7DB",
          100: "#FFEBAD",
          200: "#FFD75C",
          300: "#FFBB00",
          400: "#E5A800",
          500: "#B38300",
        },
        ink: {
          // Light-surface ink ramp (DESIGN.md). DEFAULT/soft/faint are
          // theme-reactive CSS variables (see globals.css :root/.dark) so
          // the marketing surface flips light↔dark from one place. The
          // <alpha-value> placeholder keeps opacity modifiers (text-ink/30)
          // working. The numbered dark shades below are legacy fixed tokens
          // still used by the product app.
          DEFAULT: "rgb(var(--ink) / <alpha-value>)",
          soft: "rgb(var(--ink-soft) / <alpha-value>)",
          faint: "rgb(var(--ink-faint) / <alpha-value>)",
          950: "#000000",
          900: "#0A0A0A",
          800: "#111111",
          700: "#1A1A1A",
          600: "#222222",
        },
        // DESIGN.md tokens — marketing surface. Theme-reactive CSS vars.
        paper: "rgb(var(--paper) / <alpha-value>)",
        wash: "rgb(var(--wash) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        // The accent as *text* (AA on both surfaces). Same hue family as
        // phosphor, darkened on light / brightened on dark — not a second accent.
        "phosphor-ink": "rgb(var(--phosphor-ink) / <alpha-value>)",
        // Text/icons that sit ON the constant yellow `phosphor` fill (buttons,
        // highlight, badges). The fill never changes with the theme, so this
        // MUST stay dark in both light and dark mode — never use the reactive
        // `text-ink` on a phosphor background or it turns white-on-yellow.
        "on-phosphor": "#141414",
      },
      fontFamily: {
        // `sans` is the body role, not a sans face — the whole site reads as
        // a terminal, so it resolves to IBM Plex Mono. Kept under the `sans`
        // key so every existing font-sans/default-body usage inherits it
        // without touching hundreds of call sites.
        sans: [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
        // VT323 falls back to the mono stack, never to a proportional face —
        // a pixel headline degrading into system-ui would break the whole
        // look on a font failure.
        display: [
          "var(--font-display)",
          "var(--font-mono)",
          "ui-monospace",
          "monospace",
        ],
        mono: [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      boxShadow: {
        // The one shadow (DESIGN.md) — primary CTA only.
        cta: "0 1px 2px rgb(20 20 20 / 0.08)",
      },
      animation: {
        // Marketing hero: the single orchestrated moment. CSS-only,
        // runs once, disabled by prefers-reduced-motion in globals.css.
        rise: "rise 0.5s cubic-bezier(0.16, 1, 0.3, 1) both",
      },
      keyframes: {
        rise: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
