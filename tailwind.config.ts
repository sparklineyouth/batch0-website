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
          950: "#000000",
          900: "#0A0A0A",
          800: "#111111",
          700: "#1A1A1A",
          600: "#222222",
        },
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Inter", "sans-serif"],
      },
      animation: {
        "spark-pulse": "sparkPulse 2.4s ease-in-out infinite",
        "fade-up": "fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) both",
        "fade-in": "fadeIn 0.5s ease-out both",
        "slide-down": "slideDown 0.5s cubic-bezier(0.16, 1, 0.3, 1) both",
        "marquee": "marquee 40s linear infinite",
      },
      keyframes: {
        sparkPulse: {
          "0%, 100%": { opacity: "1", filter: "drop-shadow(0 0 16px rgba(250,204,21,0.6))" },
          "50%": { opacity: "0.85", filter: "drop-shadow(0 0 32px rgba(250,204,21,0.9))" },
        },
        fadeUp: {
          "0%": { opacity: "0", transform: "translateY(24px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideDown: {
          "0%": { opacity: "0", transform: "translateY(-24px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        marquee: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
      },
      backgroundImage: {
        "spark-grid":
          "radial-gradient(circle at 1px 1px, rgba(250,204,21,0.08) 1px, transparent 0)",
        "spark-radial":
          "radial-gradient(ellipse at top, rgba(250,204,21,0.15), transparent 60%)",
      },
    },
  },
  plugins: [],
};
export default config;
