# Sparkline — sparklineyouth.org

The marketing site for Sparkline, the 4-week virtual startup accelerator for high schoolers.

## Stack

- Next.js 14 (App Router) + React 18 + TypeScript
- Tailwind CSS (custom `spark` yellow palette to match the lightning-bolt logo)
- framer-motion (scroll + entrance animations, including the 21st.dev-style ContainerScroll)
- lucide-react (icons)

## Getting started

```bash
cd sparkline-website
npm install
npm run dev
```

Open http://localhost:3000.

## Deploy

Site is built to deploy to Vercel and point at `sparklineyouth.org`.

```bash
npm run build
```

Then connect the repo to Vercel and add `sparklineyouth.org` (and `www.sparklineyouth.org`) as production domains.

## Sections

- Hero (animated logo + Cohort 1 announcement)
- Marquee
- Problem (LaunchX/LeanGap/YEA pain points)
- Scroll Preview (21st.dev `ContainerScroll` showing the cohort dashboard)
- 4-week Curriculum (Validate / Build / Market / Pitch)
- Stats (16M, $97, 4 weeks, 100% virtual)
- Comparison table
- Founders (Rishabh Dagli, Shresht Chopra)
- FAQ
- CTA + Footer
