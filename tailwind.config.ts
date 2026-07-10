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
          // Light-surface ink ramp (DESIGN.md). The numbered dark shades
          // below are legacy tokens still used by the product app.
          DEFAULT: "#141414",
          soft: "#4A4A4A",
          // 4.74:1 on the wash background, 5.05:1 on white — AA on both.
          faint: "#6F6F6F",
          950: "#000000",
          900: "#0A0A0A",
          800: "#111111",
          700: "#1A1A1A",
          600: "#222222",
        },
        // DESIGN.md tokens — marketing surface.
        paper: "#FFFFFF",
        wash: "#F7F7F5",
        line: "#E4E4E1",
        // The accent as *text on white* (AA 5.4:1). Same hue family as
        // spark, darkened — not a second accent.
        "spark-ink": "#8A6A00",
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
