# batch0 — batch0.org

The marketing site for batch0, the 4-week virtual startup accelerator for high schoolers.

## Stack

- Next.js 14 (App Router) + React 18 + TypeScript
- Tailwind CSS (custom `phosphor` amber palette, sampled from the batch0 wordmark)
- framer-motion (scroll + entrance animations, including the 21st.dev-style ContainerScroll)
- lucide-react (icons)

## Getting started

```bash
cd batch0-website
npm install
npm run dev
```

Open http://localhost:3000.

## Deploy

Site is built to deploy to Vercel and point at `batch0.org`.

```bash
npm run build
```

Then connect the repo to Vercel and add `batch0.org` (and `batch0.org`) as production domains.

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
