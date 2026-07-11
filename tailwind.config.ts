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
        spark: {
          DEFAULT: "#FACC15",
          50: "#FEF9C3",
          100: "#FEF08A",
          200: "#FDE047",
          300: "#FACC15",
          400: "#EAB308",
          500: "#CA8A04",
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
        // spark, darkened on light / brightened on dark — not a second accent.
        "spark-ink": "rgb(var(--spark-ink) / <alpha-value>)",
        // Text/icons that sit ON the constant yellow `spark` fill (buttons,
        // highlight, badges). The fill never changes with the theme, so this
        // MUST stay dark in both light and dark mode — never use the reactive
        // `text-ink` on a spark background or it turns white-on-yellow.
        "on-spark": "#141414",
      },
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        display: [
          "var(--font-display)",
          "var(--font-sans)",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
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
