# SLOP_REPORT.md — Phase 1 findings

Severity: CRITICAL = instantly reads as AI-template or fabricated; MAJOR = strong tell; MINOR = weak tell.
Each finding: file:line, issue, evidence, fix. Resolution status is recorded in REPORT.md after Phase 6.

Totals: visual 22 · copy 29 · technical 22

## Visual tells (22)

### [CRITICAL] template-component — components/container-scroll.tsx:97
**Issue:** This is the Aceternity UI 'Container Scroll Animation' component copied near-verbatim — framer-motion scroll-jacked 3D rotateX/scale tilt of a mock dashboard inside a fat-bezel rounded-[30px] #222222 frame. It is one of the most recognizable AI-landing-page components on the internet; the six-layer box-shadow string is the exact Aceternity default.

**Evidence:** `boxShadow: "0 0 #0000004d, 0 9px 20px #0000004a, 0 37px 37px #00000042, 0 84px 50px #00000026, 0 149px 60px #0000000a, 0 233px 65px #00000003" ... className="max-w-5xl mt-6 md:-mt-12 mx-auto h-[22rem] md:h-[40rem] w-full border-2 md:border-4 border-white/15 p-1.5 md:p-6 bg-[#222222] rounded-2xl md:rounded-[30px] shadow-2xl"`

**Fix:** Delete container-scroll.tsx and the 80rem scroll runway it forces (h-[42rem] md:h-[80rem] wrapper, plus the h-[60rem] md:h-[80rem] loading placeholder in app/page.tsx:25). Show the dashboard mock as a static, honestly-framed screenshot/figure (simple border, no 3D tilt, no scroll-linked transform), which also removes the last framer-motion dependency from the marketing bundle.

### [CRITICAL] eyebrow-labels — components/problem.tsx:28
**Issue:** Every single section on the marketing surface opens with the identical tiny uppercase tracked eyebrow kicker in brand yellow — 12+ instances of the same class recipe (text-[11px] uppercase tracking-[0.22em] text-phosphor), 35 uppercase-tracking labels total across the scoped files. The unbroken kicker→bold-heading→white/75-paragraph rhythm on all ~12 sections is the single strongest AI-template signature on the site.

**Evidence:** `problem.tsx:28 "The problem"; builds.tsx:57 "What you'll learn"; scroll-preview.tsx:79/142 "The product"; curriculum.tsx:41 "The 4-week sprint"; stats.tsx:21 "Tuition"; comparison.tsx:72 "Why batch0"; faq.tsx:58 "FAQ"; cta.tsx:17 "Reserve your seat"; sponsors/page.tsx:82/120/192; all: className="text-[11px] sm:text-xs font-medium uppercase tracking-[0.22em] text-phosphor"`

**Fix:** Kill the eyebrow on at least 8 of the 12 sections and let headings carry hierarchy. Where a label genuinely earns its place (e.g. FAQ), vary the treatment — numbered sections, inline lead-ins, or plain-weight small text in white/50 — so no two consecutive sections share the kicker recipe.

### [MAJOR] comparison-table — components/comparison.tsx:36
**Issue:** Named-competitor comparison table (LaunchX, LeanGap, YEA!) with Check/Minus Lucide cells and our-row-highlighted-in-brand-color — the canonical AI 'Us vs Them' table, legally risky and instantly template-flavored. The $3,000–$8,000 competitor price is also repeated in problem.tsx:8, stats.tsx:31, and faq.tsx:19.

**Evidence:** `rows: Row[] = [{ program: "LaunchX", cost: "$3,000–$8,000", ... }, { program: "LeanGap", ... }, { program: "YEA!", ... }, { program: "batch0", ... highlight: true }] ... r.highlight ? "bg-phosphor/[0.04]" : ""`

**Fix:** Replace the named-competitor grid with a single honest positioning statement or an anonymous 'typical programs vs. batch0' two-column contrast (cost, format, outcome) written as prose/definition list. Deduplicate the $3,000–$8,000 claim to one location with a source.

### [MAJOR] neon-glow — components/hero.tsx:71
**Issue:** Dark-mode-only site with a neon accent and a colored glow shadow under the primary CTA — and the identical phosphor-glow shadow recipe is copy-pasted onto six different buttons across the surface (hero, cta.tsx:90, sponsor.tsx:106, sticky-mobile-cta.tsx:49, sponsors/page.tsx:63, sponsor-contact-form.tsx:113).

**Evidence:** `className="press group inline-flex ... bg-phosphor px-5 py-4 sm:py-3 text-[15px] font-semibold text-black shadow-[0_8px_24px_-8px_rgba(250,204,21,0.5)] hover:bg-phosphor-200 ..."`

**Fix:** Drop the colored glow entirely — a solid #FFBB00 button on black has more than enough contrast. If elevation is wanted, use a neutral shadow (shadow-md black) on at most the hero CTA. Extract one Button/CTA class so the recipe lives in one place instead of six copies.

### [MAJOR] gradient-text — app/globals.css:208
**Issue:** The .shine gradient-clipped-text utility applies the 'one shiny word in the hero headline' pattern — used on the key noun in every hero-level heading (hero 'investors', scroll-preview 'investor-ready' twice, sponsors 'founders'). Monochrome yellow rather than purple→blue, but the same instantly-recognizable template move.

**Evidence:** `.shine { background: linear-gradient(110deg, #ffbb00 0%, #fde047 45%, #ffbb00 100%); -webkit-background-clip: text; background-clip: text; color: transparent; } — used at hero.tsx:57 'Pitch it to <span className="shine">investors</span>.'`

**Fix:** Replace .shine spans with plain text-phosphor (flat brand yellow) or no accent at all — the headline copy is strong enough. Delete the .shine utility.

### [MAJOR] pulse-glow — tailwind.config.ts:33
**Issue:** phosphor-pulse is a pulsing drop-shadow glow animation (16px→32px yellow halo) — the flagged 'pulsing glow' tell. Applied to the auth-layout logo (app/(auth)/layout.tsx:13) and the 'Presenting sponsor' pill dot (components/sponsor.tsx:39); hero.tsx:48 additionally uses animate-ping on a fake 'live' status dot inside the eyebrow pill.

**Evidence:** `phosphorPulse: { "0%, 100%": { opacity: "1", filter: "drop-shadow(0 0 16px rgba(250,204,21,0.6))" }, "50%": { opacity: "0.85", filter: "drop-shadow(0 0 32px rgba(250,204,21,0.9))" } } ... hero.tsx:48 <span className="absolute inset-0 animate-ping rounded-full bg-phosphor/70" />`

**Fix:** Delete the phosphor-pulse keyframe and both usages (static logo, static dot). Remove the animate-ping live-dot in the hero pill — a countdown/spots label is a real signal and needs no fake pulse; if a dot must stay, keep it static.

### [MAJOR] marquee — components/marquee.tsx:35
**Issue:** Infinite auto-scrolling text marquee of curriculum keywords directly under the hero — the logo/keyword marquee is a flagged template tell, and this one scrolls marketing claims ('Zero Equity', 'Investor Intros') rather than logos, so it reads as decoration with no proof value.

**Evidence:** `<div className="flex animate-marquee gap-8 sm:gap-10 whitespace-nowrap will-change-transform"> {[...items, ...items].map(...)} — with marquee: "marquee 40s linear infinite" in tailwind.config.ts:37`

**Fix:** Remove the marquee section. If a curriculum teaser is wanted under the hero, render the same terms as a static wrapped row of plain text separated by slashes (no animation), or fold them into the curriculum section where they already live.

### [MAJOR] card-grid — components/builds.tsx:77
**Issue:** Uniform icon-card grid: six identical rounded-2xl border-white/10 bg-white/[0.02] p-6 cards, each opening with a Lucide icon in a 10×10 rounded-xl bg-phosphor/15 chip — the untouched shadcn/template feature-card recipe. The exact same recipe repeats on app/sponsors/page.tsx:95 (3-up WHY cards, same classes and icon chip).

**Evidence:** `className="rounded-2xl border border-white/10 bg-white/[0.02] p-6" ... <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-phosphor/15 text-phosphor"><Icon className="h-5 w-5" /></span>`

**Fix:** Break the grid: the six skill blocks are sequential, so render them as a numbered two-column list (like problem.tsx already does well with its 01/02/03 list) or vary card sizes/orientation. Drop the icon chips entirely — generic Compass/Wrench/LineChart Lucide icons add no information.

### [MAJOR] card-grid — app/sponsors/page.tsx:143
**Issue:** Three-tier pricing cards with a floating 'Most popular' pill on the highlighted middle tier — the default AI pricing-section template (rounded-2xl cards, Check-icon perk lists, highlighted tier with brand gradient background).

**Evidence:** `<span className="absolute -top-3 left-6 rounded-full bg-phosphor px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-black">Most popular</span> ... t.highlight ? "border-phosphor/40 bg-gradient-to-br from-phosphor/[0.08] to-transparent"`

**Fix:** Drop the 'Most popular' badge (with 3 B2B tiers it's presumptuous, not social proof) and flatten the tiers into a single comparison-style list or side-by-side columns with a shared table spine; differentiate the recommended tier with copy ('Best for first-time sponsors') instead of a floating pill.

### [MAJOR] scroll-animation — components/ui/reveal.tsx:15
**Issue:** Identical fade-up-on-scroll reveal applied to virtually every section and list item on the page (problem, builds, curriculum, sponsor, comparison, cta) with mechanical i*60–80ms stagger delays — the uniform whileInView pattern, just re-implemented in IO/CSS. Nothing on the page simply exists; everything animates in the same way.

**Evidence:** `reveal.tsx wraps sections; globals.css:89 .reveal { opacity: 0; transform: translateY(20px); transition: ... 600ms ... } ; usage e.g. problem.tsx:46 <Reveal key={p.title} delay={i * 80} as="li">, builds.tsx delay={i * 60}, sponsor.tsx delay={80/120/160}`

**Fix:** Reserve Reveal for at most 2–3 hero-adjacent moments and let everything else render static. Where kept, shorten to ~300ms and remove per-item stagger on lists (animate the container once).

### [MAJOR] glassmorphism — app/(auth)/layout.tsx:18
**Issue:** The auth shell is the full AI-template stack in one screen: radial yellow glow wash behind (bg-phosphor-radial opacity-60), a glassmorphic card (translucent zinc-900/60 + backdrop-blur + rounded-2xl + border-white/10), and a logo pulsing with the phosphor-pulse glow animation.

**Evidence:** `<div aria-hidden className="pointer-events-none absolute inset-0 bg-phosphor-radial opacity-60" /> ... <Image src="/logo.svg" ... className="animate-phosphor-pulse" /> ... <div className="w-full rounded-2xl border border-white/10 bg-zinc-900/60 p-7 backdrop-blur">`

**Fix:** Make the card opaque (bg-zinc-950 or bg-ink-900), drop backdrop-blur (nothing is behind it worth blurring), remove the radial glow div, and render the logo static. A plain bordered panel on black is cleaner and loads lighter.

### [MAJOR] typography — tailwind.config.ts:30
**Issue:** Zero typographic decisions: the site loads no font at all (no next/font anywhere in app/layout.tsx), the sans stack is the generic system stack with 'Inter' dead-listed as a never-loaded fallback, and every heading uses the same bold + negative-tracking recipe. font-feature-settings "ss01","cv11" in globals.css:22 targets Inter-specific alternates that never activate on system fonts.

**Evidence:** `sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Inter", "sans-serif"]`

**Fix:** Pick an actual typographic identity: load one distinctive display face via next/font (e.g. a grotesque or slab for headlines) paired with the system stack for body, or commit to system-only deliberately and differentiate with weight/size contrast (e.g. medium-weight oversized headlines instead of uniform font-bold tracking-[-0.02em]). Remove the dead 'Inter' entry and the inert font-feature-settings, or load Inter so they do something.

### [MAJOR] og-image — app/opengraph-image.tsx:30
**Issue:** The OG image is the same template stack in static form: black background + radial yellow glow at top, a featureless glowing yellow rounded square standing in for a logo (0 0 80px glow), pill badge, giant tight-tracked headline with one yellow word — reads as AI-generated placeholder art in link previews.

**Evidence:** `backgroundImage: "radial-gradient(ellipse at top, rgba(250,204,21,0.22), rgba(0,0,0,1) 60%)" ... { width: 56, height: 56, borderRadius: 14, background: "#FFBB00", boxShadow: "0 0 80px rgba(250,204,21,0.55)" }`

**Fix:** Embed the real logo.svg (fetch + data-URI or inline path) instead of a glowing square, drop the radial glow and the box-shadow, and let the card be flat black with the yellow reserved for the wordmark and one accent line.

### [MAJOR] pill-badge — components/hero.tsx:46
**Issue:** The rounded-full brand-tinted pill badge with a tiny dot (border-phosphor/30 bg-phosphor/[0.06] + dot + uppercase tracked text) is stamped out five times across the surface — hero eyebrow, sponsor.tsx:38 'Presenting sponsor', comparison.tsx:84 'Zero equity. Ever.', sponsors/page.tsx:46 'Sponsorship' — the 'announcement pill above hero' template pattern generalized to every section.

**Evidence:** `className="inline-flex max-w-full items-center gap-2 rounded-full border border-phosphor/30 bg-phosphor/[0.06] px-3 py-1.5 text-[10px] sm:text-[11px] font-medium uppercase tracking-[0.18em] sm:tracking-[0.2em] text-phosphor"`

**Fix:** Keep the pill only in the hero where it carries live data (countdown/spots), and restyle the other four as plain inline text labels or drop them. The hero pill itself works because it shows real state — the copies are pure chrome.

### [MINOR] imagery — components/scroll-preview.tsx:156
**Issue:** Zero authentic imagery on the entire marketing surface: public/ contains only logo.svg, and the sole 'product shot' is a hand-built JSX facsimile of the dashboard (fake sidebar, fake 'Welcome, Riya.' data) inside the Aceternity frame. No student photos, mentor faces, real screenshots, or cohort artifacts — the absence of proof-imagery is itself a template tell.

**Evidence:** `<h3 className="text-3xl font-bold tracking-tight text-white">Welcome, Riya.</h3> — a mocked JSX dashboard, no <Image> of a real screenshot anywhere; public/ = logo.svg only`

**Fix:** Capture a real dashboard screenshot (even of seeded demo data) and ship it as an optimized next/image, and add at least one section with real human evidence — mentor headshots, Pitch Day Zoom grid, student work — to break the all-vector aesthetic.

### [MINOR] card-nesting — components/cta.tsx:50
**Issue:** Cards nested in cards in the final CTA: the gradient-surfaced pricing card (rounded-2xl + bg-gradient-to-br) contains a bordered '$0 free to apply' box and a bordered countdown/spots box — three bordered boxes deep, with the $0 rendered inside a circular chip as a fourth level.

**Evidence:** `outer: className="...rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.04] to-transparent..." ; inner: className="mt-5 flex items-center gap-3 rounded-lg border border-phosphor/20 bg-phosphor/[0.04] px-3 py-2.5" with <span ... rounded-full bg-phosphor/15 ...>$0</span>`

**Fix:** Flatten one level: keep the outer card, render 'Free to apply · ~5 minutes' as a plain line with the checklist bullets, and show the countdown/spots label as unboxed text above the button.

### [MINOR] decorative-glow — components/hero.tsx:40
**Issue:** Decorative yellow gradient wash floating behind the hero (and duplicated on the sponsors hero at app/sponsors/page.tsx:43) — the soft-glow-behind-hero decoration, a restrained cousin of the blurred-orb pattern.

**Evidence:** `<div aria-hidden className="absolute inset-x-0 -top-16 h-64 bg-gradient-to-b from-phosphor/[0.08] to-transparent pointer-events-none" />`

**Fix:** Remove both washes, or if some warmth is wanted keep exactly one (homepage hero) at lower opacity — the black-on-yellow brand contrast doesn't need atmospheric lighting.

### [MINOR] dead-decor — app/globals.css:183
**Issue:** A drawer of unused AI-template decoration utilities ships in globals.css: .glow-text (yellow text-shadow), .grid-bg (dot grid), .gradient-border (masked gradient border), .noise (SVG turbulence overlay) — none referenced by any scoped component — plus tailwind.config.ts:62 phosphor-grid which duplicates .grid-bg and is also unused (phosphor-radial is used only by auth/apply).

**Evidence:** `.glow-text { text-shadow: 0 0 40px rgba(250, 204, 21, 0.35); } ... .gradient-border::before { ... background: linear-gradient(135deg, rgba(250, 204, 21, 0.6), rgba(250, 204, 21, 0)); ... } ... .noise::after { ... feTurbulence ... }`

**Fix:** Delete .glow-text, .grid-bg, .gradient-border, .noise from globals.css and the phosphor-grid backgroundImage from tailwind.config.ts; keep phosphor-radial only if the auth layout keeps it after its own fix.

### [MINOR] glassmorphism — components/navbar.tsx:174
**Issue:** Translucent blur-backed bars: fixed navbar and the sticky mobile CTA bar (sticky-mobile-cta.tsx:46) both use bg-black/80–95 + backdrop-blur; the mobile drawer scrim adds backdrop-blur-md (line 86). Near-opaque so the effect is subtle, but the blur costs compositing on scroll for close to zero visual payoff on a pure-black site.

**Evidence:** `className="fixed top-0 inset-x-0 z-50 border-b border-white/10 bg-black/95 backdrop-blur supports-[backdrop-filter]:bg-black/80 pt-safe"`

**Fix:** Use solid bg-black with the existing border-b as the separator and remove backdrop-blur from the navbar, sticky CTA bar, and drawer scrim (bg-black/85 alone is enough for the scrim).

### [MINOR] cta-arrow — components/hero.tsx:74
**Issue:** Every CTA on the site appends a '→' arrow, most with the group-hover:translate-x-0.5 scoot micro-animation — 8+ instances (hero, navbar ×2, cta, sponsor, sponsors hero, contact form, sticky mobile CTA). The universal arrow-that-slides-right is a well-worn generated-UI signature.

**Evidence:** `<span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>`

**Fix:** Keep the arrow on the single primary conversion button (hero) if desired and strip it from all secondary/utility CTAs; drop the hover translate everywhere — it conflicts with the site's own 'instant, no-easing' interaction philosophy documented in globals.css.

### [MINOR] stat-tiles — components/stats.tsx:40
**Issue:** The identical stat-tile trio (tiny uppercase tracked label / big bold number / small sub-caption) is repeated in three sections — hero ProofStat (4-up, hero.tsx:95–141), stats.tsx supporting stats (3-up), and sponsor.tsx:81–99 (3-up with the same border-t/border-l dividers) — same dt/dd recipe, same dividers, interchangeable content.

**Evidence:** `<dt className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/55">...</dt><dd className="mt-1.5 text-3xl sm:text-3xl md:text-4xl font-semibold tracking-tight text-white">`

**Fix:** Keep one stat row (the hero proof row earns it) and cut or reformat the other two — sponsor.tsx stats could be a prose sentence with inline numbers; stats.tsx already has the giant price as its focal point and doesn't need a second tile row.

### [MINOR] template-component — components/faq.tsx:83
**Issue:** FAQ accordion uses the stock Plus-icon-rotates-45°-into-an-X pattern with the default one-open-at-a-time state — the shadcn/Radix accordion default look reproduced by hand.

**Evidence:** `<Plus className={'h-4 w-4 shrink-0 text-white/40 transition-transform duration-200 ${isOpen ? "rotate-45 text-phosphor" : ""}'} />`

**Fix:** Lowest priority, but swapping to a native <details>/<summary> with a custom marker, or simply always-open Q&A prose (9 answers of this quality deserve to be read, not hidden), would both read as more deliberate.


## Copy tells (29)

### [CRITICAL] fact-contradiction — components/hero.tsx:61
**Issue:** "4-week" program claim contradicts the real cohort: Summer 2026 runs 2026-07-30 to 2026-09-13 (~6.5 weeks). The same page renders derived.dateRangeLabel ("Jul 30 → Sep 13") in the scroll-preview dashboard mock, so the contradiction is visible on-screen. The claim repeats at hero.tsx:107 ("4 wks"), stats.tsx:13 ("4 wks"), curriculum.tsx:42 ("The 4-week sprint"), footer.tsx:23, faq.tsx:15/19/31, cta.tsx:62, app/layout.tsx:17/28/39/60/78, app/opengraph-image.tsx:11/92, and scroll-preview.tsx:65 ("Week 4 ends live on Zoom").

**Evidence:** `batch0 is a 4-week, fully virtual entrepreneurship program for U.S. high schoolers.`

**Fix:** Pick the true duration. Either restructure the curriculum copy around the actual ~6.5-week window (e.g. "6 weeks, Jul 30–Sep 13") or shorten the cohort in the DB to match. Then sweep every listed location including metadata, JSON-LD, and the OG image — they must all read from one source of truth (site-config), not hardcoded strings.

### [CRITICAL] fabricated-claim — components/builds.tsx:65
**Issue:** Mentor claims with zero mentors in the system (0 mentor accounts; founder is Rish, 18, solo). Variants across the page: "real founder mentors" (scroll-preview.tsx:86-87), "weekly group session with mentors" (scroll-preview.tsx:52), "1:1 mentor checkpoints" (faq.tsx:23), "mentors and peers know you by name" (faq.tsx:39), "Rehearsals with mentors" (curriculum.tsx:30), "Mentor sessions" (cta.tsx:63), "mentor support" (hero.tsx:62, footer.tsx:24, layout.tsx:19/60), "they fund the seats, mentors, and infrastructure" (sponsor.tsx:51).

**Evidence:** `with feedback from mentors who have shipped.`

**Fix:** Either recruit and name real mentors before launch, or rewrite to what is true today: direct feedback from the founder/team, e.g. "weekly feedback from the batch0 team." Never say "mentors" (plural, credentialed) while the mentor count is zero.

### [CRITICAL] fabricated-claim — components/faq.tsx:27
**Issue:** The most specific version of the "investor network" claim — naming investor types ("angels, scout funds, and pre-seed VCs interested in young founders") with zero named investors, zero events in the system, and no cohort ever run. "Our investor network" also appears in hero.tsx:63, problem.tsx:18, curriculum.tsx:30/51, scroll-preview.tsx:65, faq.tsx:31/43, cta.tsx:64, footer.tsx:25, comparison ("Pitch + intros"), sponsors page:57-58, and layout.tsx metadata. The "funding never guaranteed" disclaimers don't cure this — the network itself is the unverified claim.

**Evidence:** `we make warm introductions to investors in our network — angels, scout funds, and pre-seed VCs interested in young founders`

**Fix:** Either secure and name at least a few committed investors/judges (with permission) before this copy ships, or downgrade every instance to what exists: "pitch live to a judging panel" / "we invite investors we're building relationships with." A claimed network of angels and pre-seed VCs that doesn't exist is the single biggest legal/trust risk on the site given money changes hands.

### [CRITICAL] fabricated-claim — components/sponsor.tsx:21
**Issue:** Invented-looking stat block for Impetus AI. Founder is 18 and solo — "8 yrs founder experience" implies founding companies at age 10. "10+ AI products shipped" has no verifiable referent. "12–20 hr weekly time saved — Reported by clients" is a testimonial-style claim with no named client (checklist 6: testimonial without verifiable full name + company).

**Evidence:** `{ v: "10+", k: "AI products shipped", sub: "Across medical, e-commerce, ops" }, { v: "8 yrs", k: "Founder experience", sub: "Quantiphi, Schroders, robotics" }, { v: "12–20 hr", k: "Weekly time saved", sub: "Reported by clients" }`

**Fix:** Delete the stat row or replace with facts that survive a diligence check (e.g. founding year of the LLC, real shipped project names with links). If Quantiphi/Schroders refer to a family member's or advisor's career, attribute it honestly or cut it. "Reported by clients" needs a named, consenting client or it goes.

### [CRITICAL] fabricated-claim — components/sponsor.tsx:47
**Issue:** Self-sponsorship presented as third-party backing. Impetus AI LLC is the legal entity that operates batch0 — the site frames its own owner as a "Presenting sponsor" that "backs" the program, which reads as an external endorsement/funding relationship that doesn't exist.

**Evidence:** `batch0 runs on the backing of Impetus AI — AI consulting for local businesses.`

**Fix:** Reframe truthfully: "batch0 is a program by Impetus AI LLC" — parent-company disclosure, not a sponsor slot. Move the AI-consulting pillars (AI Audit/Roadmap/Full Build — B2B copy aimed at the wrong audience anyway) off the teen landing page entirely, and reserve "Presenting sponsor" for an actual external sponsor.

### [CRITICAL] fabricated-claim — app/sponsors/page.tsx:56
**Issue:** "100 vetted teen founders per cohort" stated as present fact to prospective sponsors. Reality: 0 enrollments, 2 draft applications, no cohort has run. Capacity (100) is real; "vetted teen founders" is invented. Repeated in metadata (line 10) and the Pipeline card (line 18).

**Evidence:** `Get your brand in front of 100 vetted teen founders per cohort.`

**Fix:** Rewrite as forward-looking and honest: "Cohort 1 (Summer 2026) is capped at 100 students" / "be in front of our first cohort of applicant-screened teen founders." Sponsors will diligence this; a fabricated audience number is a deal-killer.

### [CRITICAL] fabricated-claim — app/sponsors/page.tsx:18
**Issue:** Invented outcome statistic about students who don't exist yet — no cohort has run, so no one is "headed" anywhere, and "12–24 months" is a fake-precise horizon.

**Evidence:** `many headed to top engineering and business programs in 12–24 months. Get early reads on talent before recruiters do.`

**Fix:** Cut the trajectory claim entirely until there are alumni. "Real outcomes, real reportable impact" (line 30) has the same problem — no outcomes exist; soften to what the sponsorship funds.

### [CRITICAL] fabricated-claim — app/sponsors/page.tsx:143
**Issue:** "Most popular" badge on the $5,000 Partner tier when zero sponsors exist (0 sponsor relationships in system). Fabricated social proof on a pricing page.

**Evidence:** `Most popular`

**Fix:** Remove the badge (and the `highlight: true` driver in app/sponsors/tiers.ts:29) until at least one tier has actual buyers; if you want visual emphasis, label it "Recommended" — a stance, not a popularity claim.

### [CRITICAL] fabricated-claim — components/faq.tsx:23
**Issue:** "An active Discord community" claimed in present tense — discordUrl is empty in settings fallback, 0 cohorts have run, 8 total student accounts. Same answer also asserts "live weekly group sessions" and "1:1 mentor checkpoints" (0 mentors, 0 events in system). Related: faq.tsx:15 claims "the application is selective" with 2 draft applications ever.

**Evidence:** `an active Discord community`

**Fix:** Future tense and honest scale: "a private Discord for your cohort" — drop "active." Cut "the application is selective" until there's an applicant pool that makes selection real, or state the actual bar ("we review every application; not everyone is admitted").

### [CRITICAL] fact-contradiction — components/comparison.tsx:63
**Issue:** Comparison table awards batch0 "Year-round: Yes" when exactly one cohort exists (Summer 2026) and none has run. The axis is chosen to beat competitors on a capability batch0 doesn't have.

**Evidence:** `yearRound: true,`

**Fix:** Change to the truthful value ("Summer 2026 — more cohorts planned") or drop the year-round column until a second cohort is scheduled.

### [CRITICAL] fabricated-claim — components/hero.tsx:108
**Issue:** Hero proof row sells a "Live" Pitch Day attended by "Sponsors + investors" — 0 events exist in the system, 0 sponsors, no investor network. A proof row containing zero proven things (see also "4 wks" at line 107).

**Evidence:** `<ProofStat label="Pitch Day" value="Live" sub="Sponsors + investors" />`

**Fix:** Proof rows must contain verifiable facts only: cohort dates (Jul 30–Sep 13), capacity (100), price, format. Replace "Sponsors + investors" with what is committed, or describe Pitch Day as a planned program element in body copy, not a stat.

### [MAJOR] fact-contradiction — components/faq.tsx:39
**Issue:** Internal contradiction inside one sentence: "small enough that mentors and peers know you by name" immediately followed by a 100-student cap — and there are 0 mentors. 100 students with one solo 18-year-old founder cannot know anyone "by name."

**Evidence:** `Small enough that mentors and peers know you by name. ${cohortPrefix} is capped at ${derived.capacityLabel} students.`

**Fix:** Either lower the marketed intimacy claim ("capped at 100 so every team gets weekly feedback") or restructure into small pods and say that. Don't pair "know you by name" with a triple-digit cap.

### [MAJOR] slop-vocabulary — app/sponsors/page.tsx:51
**Issue:** Checklist-1 canonical slop: "the next generation of founders" — appears in the H1 and again in metadata title (line 8, "Fund the next generation of founders"). Also fails the swap test: SparkHub could ship this page unchanged.

**Evidence:** `Sponsor the next generation\nof founders.`

**Fix:** Replace with the concrete offer: "Put your brand in front of 100 teen founders this summer" / "Fund a named grant for Cohort 1." Specificity (cohort, date, count) is what a generic competitor can't copy.

### [MAJOR] swap-test — components/problem.tsx:32
**Issue:** Swap-test failures — headlines that work verbatim for "SparkHub" or any teen accelerator: "Youth entrepreneurship is broken." (here), "Learn to build a startup. Pitch it to investors." (hero.tsx:55-57), "The skills founders actually use." (builds.tsx:61), "Idea to investor-ready." (curriculum.tsx:45), "Questions, answered." (faq.tsx:62), "Affordable. Virtual. Real investor exposure." (comparison.tsx:76), "Let's build something together." (sponsors:196), "Pick the level that fits." (sponsors:124). None contains a name, number, date, or claim unique to batch0.

**Evidence:** `Youth entrepreneurship is broken.`

**Fix:** Anchor each headline in a specific: the $130-vs-$3,000 price wedge, the Jul 30 start date, the 100-seat cap, the zero-equity grant. E.g. "$130. Six weeks. A real pitch at the end." is un-swappable; "Youth entrepreneurship is broken" is category wallpaper.

### [MAJOR] swap-test — components/scroll-preview.tsx:83
**Issue:** Duplicate headline: "From idea to investor-ready" (also at line 146 in the desktop variant) is a near-verbatim repeat of curriculum.tsx:45 "Idea to investor-ready." two sections later — reads as template fill, and "investor-ready" is doing slop work in both.

**Evidence:** `From idea to <span className="shine">investor-ready</span>`

**Fix:** Differentiate the two sections: this one is about the product/dashboard — headline it as such ("One dashboard runs your whole cohort"); leave the journey framing to the curriculum section.

### [MAJOR] disclaimer-repetition — components/hero.tsx:64
**Issue:** "Funding is never guaranteed" appears 11 times across the landing page components (hero, problem, curriculum ×2, scroll-preview, stats, comparison, faq ×2, cta, footer) plus 4 more in layout metadata. Legally prudent once or twice; at 11 it becomes a nervous tic that makes the funding promise feel *more* dubious, not less. Similar repetition: "zero equity" variants appear 6+ times.

**Evidence:** `Funding is never guaranteed — we open the room; what investors decide is up to them.`

**Fix:** Say it prominently once (FAQ "What am I actually paying for?" is the right home, plus one line near the primary CTA) and cut the other nine. One clear disclosure beats eleven anxious ones.

### [MAJOR] manufactured-contrast — components/problem.tsx:16
**Issue:** Manufactured-contrast aphorisms ("Not X. Y." pattern) — count: 7 on the landing page. (1) "Certificates, not connections" (here); (2) "Real customer interviews — not friends and family." (curriculum.tsx:9); (3) "not a participation certificate" (curriculum.tsx:51); (4) "Investor intros are connections, not checks." (faq.tsx:27); (5) "a real problem worth solving, not just guess at one" (faq.tsx:35); (6) "Funding is never guaranteed — but the room is." (comparison.tsx:81-82); (7) "don't need another business-plan competition. They need…" (problem.tsx:35-37).

**Evidence:** `Certificates, not connections`

**Fix:** Keep at most one or two of the strongest (the curriculum "not friends and family" earns its contrast; it's concrete). Rewrite the rest as direct statements — when every section pivots on the same rhetorical hinge, it reads as generated copy.

### [MAJOR] em-dash-density — components/builds.tsx:28
**Issue:** Em-dash density far above 1 per 150 words in multiple body blocks. Site-wide: 33 em dashes across the 11 landing components (~1 per 55 words of body copy). Worst offenders: this card (2 em dashes in a 17-word sentence), curriculum.tsx week bodies (4 dashes in ~100 words, lines 9-30), faq.tsx (7), cta.tsx (4), scroll-preview.tsx (4).

**Evidence:** `Ship a v1 fast — landing page, no-code MVP, or working prototype — without overbuilding before validation.`

**Fix:** Budget one em dash per section. Convert most to periods or commas: "Ship a v1 fast: a landing page, no-code MVP, or working prototype. Don't overbuild before validation."

### [MAJOR] cta-inconsistency — components/cta.tsx:92
**Issue:** Same label, different destinations — and inconsistent naming across sections. "Start your application" goes to /apply in the hero (hero.tsx:29-30) but to /signup?next=%2Fapply here. Meanwhile the navbar says "Apply" (/apply), the sticky mobile bar says "Apply to batch0" (/apply), scroll-preview mobile's "Apply" link goes to the #apply in-page anchor (scroll-preview.tsx:131) — not the apply page, and the CTA section eyebrow says "Reserve your seat." Five names, three destinations, one action.

**Evidence:** `href="/signup?next=%2Fapply" … Start your application`

**Fix:** One verb, one destination: standardize on "Start your application" → /apply everywhere (let /apply handle the auth redirect), rename the scroll-preview anchor link so an in-page jump isn't labeled like the application, and align the eyebrow ("Apply for Summer 2026").

### [MAJOR] stale-fallback — lib/site-config.ts:92
**Issue:** FALLBACK_COHORT contradicts the production cohort on every field: dates 2026-06-15→2026-07-13 (real: 2026-07-30→2026-09-13), capacity 24 (real: 100), priceCents 13000 (real: 12999). During any Supabase outage the marketing site confidently displays a wrong start date, wrong seat count, and wrong price — and the FAQ interpolates the wrong capacity into "capped at 24 students."

**Evidence:** `startsOn: "2026-06-15", endsOn: "2026-07-13", capacity: 24, priceCents: 13000,`

**Fix:** Sync the fallback to the real cohort row (2026-07-30 / 2026-09-13 / 100 / 12999), or better: make the fallback omit dates/capacity so derived labels render empty rather than wrong.

### [MAJOR] price-mismatch — app/layout.tsx:74
**Issue:** JSON-LD hardcodes price "130" while the DB price is $129.99 and priceLabel rounds Math.round(12999/100)="$130" (lib/site-config.ts:135,181). Every displayed price says $130 but Stripe will charge $129.99 — a one-cent mismatch between advertised and charged price, plus schema.org data that drifts whenever the admin edits the cohort price.

**Evidence:** `price: "130",`

**Fix:** Decide the price: either set the DB to 13000 so $130 is exact, or display "$129.99" (don't round cents away on a checkout-adjacent number). Generate the JSON-LD offer from getSiteConfig() instead of a literal.

### [MAJOR] naming-inconsistency — app/sponsors/tiers.ts:27
**Issue:** The end-of-cohort event is called "Demo Day" here (and demoDayDate in site settings) but "Pitch Day" everywhere on the landing page (hero, scroll-preview, comparison, faq, sponsors WHY card). A sponsor reading tiers can't tell if these are two events or one.

**Evidence:** `"Demo Day attendance",`

**Fix:** Pick one name — "Pitch Day" is the dominant usage — and sweep tiers.ts, the sponsors page, and admin/dashboard surfaces.

### [MAJOR] fact-contradiction — app/(legal)/terms/page.tsx:13
**Issue:** Terms say the platform is "operated by batch0," but batch0 is not a legal entity — the operator is Impetus AI LLC. A contract that names a non-entity as the counterparty is a real legal defect, not just copy slop. (Noticed in passing; scope for legal pages was titles, which are fine.)

**Evidence:** `(batch0.org), operated by batch0.`

**Fix:** "operated by Impetus AI LLC (d/b/a batch0)" — and check privacy/refund pages for the same entity naming.

### [MINOR] brochure-copy — components/marquee.tsx:14
**Issue:** The marquee is framed (in its own code comment) as a curriculum manifest, but items 9–11 are sales claims, not curriculum: "batch0 Sponsorship," "Investor Intros," "Zero Equity." Benefits dressed as course content — and "Investor Intros" repeats the unverified network claim in a strip that scrolls past sceptical parents.

**Evidence:** `"batch0 Sponsorship", "Investor Intros", "Zero Equity",`

**Fix:** Keep the strip pure curriculum (the first 8 items are genuinely good) and drop the three benefit items.

### [MINOR] brochure-copy — app/sponsors/page.tsx:30
**Issue:** Worst zero-POV brochure block in scope: perfect grammar, no author, could be any CSR deck. "Real outcomes, real reportable impact for ESG and community programs" also asserts outcomes that don't exist yet. Runner-up: comparison.tsx:76 staccato "Affordable. Virtual. Real investor exposure."

**Evidence:** `Direct, non-dilutive sponsorship to teen founders. Real outcomes, real reportable impact for ESG and community programs.`

**Fix:** Write it like a person with a stake: "Your money goes straight to a named grant for a specific kid's company — we'll report exactly where it went." Cut "ESG" jargon; sponsors who care will ask.

### [MINOR] slop-vocabulary — app/(auth)/login/page.tsx:28
**Issue:** Checklist-2 word "journey" on the login screen — the one place a returning user needs zero persuasion.

**Evidence:** `Log in to continue your batch0 journey.`

**Fix:** "Log in to your dashboard." Also "enterprise-grade AI strategy" (components/sponsor.tsx:50) is the same class of filler — swap for a concrete capability.

### [MINOR] swap-test — app/layout.tsx:17
**Issue:** Metadata title claims category ownership with a definite article ("The 4-Week Entrepreneurship Program") — generic enough to be any competitor's title, and carries the wrong duration (see CRITICAL 4-week finding).

**Evidence:** `batch0 — The 4-Week Entrepreneurship Program for High Schoolers`

**Fix:** "batch0 — $130 Virtual Startup Program for High Schoolers (Summer 2026)" — price, format, date; nothing a rival can claim verbatim.

### [MINOR] fabricated-claim — components/cta.tsx:101
**Issue:** "Rolling admissions · Reviewed weekly" is a process commitment from a solo founder with 2 draft applications ever received — plausible, but currently unverifiable and easy to break the first busy week.

**Evidence:** `Rolling admissions · Reviewed weekly`

**Fix:** Only promise the SLA you'll keep: "We review applications on a rolling basis" (no cadence), or keep "weekly" if it's a real operational commitment.

### [MINOR] cta-inconsistency — app/sponsors/page.tsx:72
**Issue:** Vague button labels that don't say what happens: "Get in touch" (hero) and "Talk to us" (every tier card) both jump to the same on-page contact form — neither says a form is coming, and the two labels for one action add noise.

**Evidence:** `Get in touch`

**Fix:** One label describing the action: "Request a sponsor proposal" on both, since the form copy promises "we'll come back with a tailored proposal."


## Technical/marketing tells (22)

### [CRITICAL] copy-accuracy — app/layout.tsx:17
**Issue:** Site-wide '4-week' program claim contradicts the only real cohort: Summer 2026 runs 2026-07-30 to 2026-09-13 (~6.5 weeks). The claim is baked into the <title>, meta description, OG/Twitter titles, JSON-LD description (lines 60, 78), OG image alt+subline (app/opengraph-image.tsx:11,92), hero copy (components/hero.tsx:61-65), hero proof stat 'Format 4 wks' (hero.tsx:107), stats.tsx:13 ('4 wks Idea → pitch'), curriculum.tsx:42 ('The 4-week sprint', Weeks 1-4), faq.tsx:15,19,27,31, footer.tsx:23, and apply metadata (app/apply/page.tsx:13). Worse: scroll-preview.tsx:235-237 renders the REAL cohort dates from the DB ('Jul 30 → Sep 13') on the same homepage, so the site visibly contradicts itself.

**Evidence:** `title: "batch0 — The 4-Week Entrepreneurship Program for High Schoolers" … vs cohort window 2026-07-30→2026-09-13 rendered by dateRangeLabel in scroll-preview.tsx`

**Fix:** Pick one truth. Either restructure the cohort to 4 weeks in the DB, or rewrite every '4-week'/'4 wks'/'Week 4' string to a duration derived from cohort startsOn/endsOn (site-config already computes the dates). Grep: '4-week', '4 wks', 'Week 4', '4-Week'.

### [CRITICAL] copy-accuracy — components/hero.tsx:63
**Issue:** Unverifiable mentor/investor-network claims across the paid marketing funnel: DB has 0 mentors, 0 events, 0 enrollments, and the cohort has never run — yet the site sells 'mentor support', 'our investor network' (hero, curriculum.tsx:30,51, faq.tsx:27,31,43, footer.tsx:24-25, cta.tsx:64, problem.tsx:18), 'real founder mentors' (scroll-preview.tsx:87,150), 'mentors who have shipped' (builds.tsx:65), '1:1 mentor checkpoints' and 'an active Discord community' (faq.tsx:23,31), 'Rehearsals with mentors' (curriculum.tsx:30). This is a $129.99 paid program marketed to minors run by a solo 18-year-old — these read as existing assets, not plans.

**Evidence:** `"You get the curriculum, mentor support, and a live pitch to our investor network." (hero.tsx:61-63); DB facts: 0 mentors, 0 events, 0 enrollments`

**Fix:** Rewrite to forward-looking, truthful copy ('mentors we're recruiting for Cohort 1', 'we invite investors to Pitch Day') or land the mentors/investors before launch. At minimum drop 'our investor network'/'active community' phrasing until either exists — FTC-risk copy for a program charging minors.

### [MAJOR] seo-robots-sitemap — app/robots.ts:16
**Issue:** robots.ts disallows /apply entirely — the target of every Apply CTA (hero, navbar, footer, sticky mobile CTA) is uncrawlable. /apply also self-noindexes (app/apply/page.tsx:28) and 307s anonymous users to /signup, and /signup isn't in the sitemap either (app/sitemap.ts lists only /, /sponsors, and 3 legal pages). Net effect: the entire conversion path is invisible to search engines, and there is no public 'program / how to apply' info page to rank instead.

**Evidence:** `disallow: ["/dashboard", "/admin", "/mentor", "/investor", "/apply", "/auth", "/api"]`

**Fix:** Create a public, crawlable /apply landing (program info + 'Start application' button gated at the form step, not the URL), remove /apply from robots disallow, and add it plus /signup to sitemap.ts. Keep noindex only on the authed form step.

### [MAJOR] seo-canonical — app/layout.tsx:16
**Issue:** Host inconsistency with zero canonicals: production serves https://batch0.org but metadataBase, openGraph.url (line 31), JSON-LD url/logo/sameAs (lines 57-61), sitemap BASE (app/sitemap.ts:3), robots sitemap URL (app/robots.ts:22), and env.siteUrl fallback (lib/env.ts:7) all use apex https://batch0.org. No page sets alternates.canonical anywhere (grep confirms). Crawlers see www pages whose og:url and sitemap point at the apex — split signals across two hosts.

**Evidence:** `metadataBase: new URL("https://batch0.org") … deployed domain is batch0.org`

**Fix:** Standardize on one host (www), set metadataBase to https://batch0.org, add alternates: { canonical: "./" } in root metadata so every page emits a self-canonical, update sitemap/robots/JSON-LD/env fallback, and confirm Vercel 308-redirects apex→www.

### [MAJOR] structured-data — app/layout.tsx:74
**Issue:** JSON-LD Offer price is hardcoded "130" but the real cohort price is $129.99 (12999 cents) — structured-data price won't match the page/checkout price. Compounding: the site itself displays '$130' everywhere because lib/site-config.ts:135 does Math.round(amountCents/100), and apply/page.tsx:126 uses toFixed(0), so the advertised price ($130) differs from the Stripe charge ($129.99). Also no FAQPage schema despite a 9-question FAQ on the homepage (components/faq.tsx) — free rich-result eligibility left on the table.

**Evidence:** `offers: { "@type": "Offer", price: "130", priceCurrency: "USD" … } vs DB price $129.99`

**Fix:** Render JSON-LD from getSiteConfig() with the exact price ("129.99"), display '$129.99' (or set the DB price to 13000 to make $130 true), and add a FAQPage JSON-LD block generated from the same FAQ array.

### [MAJOR] seo-icons — app/layout.tsx:43
**Issue:** public/ contains exactly one asset: logo.svg (697 bytes). icons.icon/shortcut/apple all point at /logo.svg. iOS ignores SVG for apple-touch-icon (home-screen bookmark gets a screenshot/blank), there is no /favicon.ico (legacy agents and hardcoded /favicon.ico requests 404 — middleware.ts:10 even excludes a favicon.ico and og.png that don't exist), no sized PNGs (192/512), and no web manifest.

**Evidence:** `icons: { icon: "/logo.svg", shortcut: "/logo.svg", apple: "/logo.svg" } — ls public/ → logo.svg only`

**Fix:** Generate a real set: app/favicon.ico, app/icon.png (512), app/apple-icon.png (180, opaque background — the brand yellow square works), and reference them via Next file conventions so metadata is emitted automatically.

### [MAJOR] legal — app/(legal)/terms/page.tsx:13
**Issue:** Terms of Service claims the platform is 'operated by batch0' — but the legal entity is Impetus AI LLC. The LLC is never named in Terms, Privacy, or Refund Policy, while payments from minors' families are processed under it and the contact email is on impetusai.net. An unnamed counterparty makes the contract ambiguous.

**Evidence:** `"…batch0 (batch0.org), operated by batch0."`

**Fix:** Name the entity: 'batch0 is a program of Impetus AI LLC' in Terms, Privacy, Refund Policy, and the footer legal line.

### [MAJOR] copy-accuracy — app/sponsors/page.tsx:10
**Issue:** Sponsors page sells '100 vetted teen founders per cohort' (meta description, hero copy line 56-58, WHY card line 18) as present fact. Reality: 0 enrollments, 2 draft applications, cohort has never run. '100' is the capacity, not an audience. Sponsor tiers up to $15,000 (tiers.ts) are being sold against an audience that does not exist yet.

**Evidence:** `"Get your brand in front of 100 vetted teen founders per cohort." — DB: 0 enrollments, 2 applications (both draft)`

**Fix:** Reframe honestly: 'up to 100 seats per cohort' / 'Cohort 1 launches July 2026 — get in as a founding sponsor.' Founding-sponsor framing is actually stronger for a pre-launch program.

### [MAJOR] copy-accuracy — components/sponsor.tsx:19
**Issue:** Impetus AI 'Presenting sponsor' stats are unverifiable and internally implausible: '10+ AI products shipped', '8 yrs founder experience', '12–20 hr weekly time saved — reported by clients'. The founder is 18 and solo — '8 yrs founder experience' implies starting at age 10. Copy also says Impetus AI 'fund[s] the seats, mentors, and infrastructure' (line 52) — there are 0 mentors.

**Evidence:** `{ v: "8 yrs", k: "Founder experience", sub: "Quantiphi, Schroders, robotics" } — founder: Rish, 18, solo`

**Fix:** Cut the stats row or replace with claims that survive scrutiny (what Impetus AI actually is/does today). Remove 'funds the mentors' until mentors exist.

### [MAJOR] seo-metadata — app/layout.tsx:15
**Issue:** No title.template on root metadata and several pages export no metadata at all, so /forgot-password and /reset render the EXACT homepage title (72 chars) + description — duplicate titles across routes. Every page that sets only `title` (login, signup, terms, privacy, refund-policy, apply) inherits the homepage meta description AND homepage og:title/og:description via Next's metadata merge — duplicate descriptions and mismatched social cards on effectively every public route. Only /sponsors and /apply define their own descriptions.

**Evidence:** `app/(auth)/forgot-password/page.tsx is 'use client' with no metadata export; login/signup/legal pages: export const metadata = { title: "…" } only`

**Fix:** Add title: { default: …, template: "%s · batch0" } to root, give every public page a unique ~150-char description, and move forgot-password/reset metadata into a small server wrapper or layout.

### [MAJOR] seo-metadata — app/layout.tsx:17
**Issue:** Length violations: root title is 72 chars (truncates in SERPs at ~60), root description 214 chars (cut at ~155-160), root OG description 182 chars, sponsors title 62 chars (app/sponsors/page.tsx:8), apply description ~245 chars (app/apply/page.tsx:13).

**Evidence:** `"batch0 — The 4-Week Entrepreneurship Program for High Schoolers" = 72 chars; description = 214 chars`

**Fix:** Trim titles to ≤60 ('batch0 — Startup Program for High Schoolers'), descriptions to ≤155 leading with the differentiator (price, live pitch).

### [MAJOR] links — components/footer.tsx:40
**Issue:** Footer 'Program' links use bare hash hrefs (#how-it-works line 40, #curriculum line 48, #compare line 56) but the footer renders on /sponsors and all three legal pages, where those ids don't exist — clicking does nothing (dead anchors) on every page except the homepage. navbar.tsx:8-14 already solved this with '/#anchor' hrefs and even documents why.

**Evidence:** `footer.tsx: href="#how-it-works" vs navbar.tsx comment: "Use absolute hrefs ('/#anchor') so hash links still resolve when the navbar is rendered on subroutes"`

**Fix:** Change footer hashes to /#how-it-works, /#curriculum, /#compare.

### [MAJOR] funnel-analytics — components/cta.tsx:89
**Issue:** Apply funnel click path (traced): hero/navbar/footer/sticky-mobile-cta link to /apply with plain <a> tags → middleware (lib/supabase/middleware.ts:110) 307-redirects logged-out users to /signup?next=%2Fapply → after signup-form's signUpAction + signInWithPassword the user lands back on /apply. A logged-out mobile user tapping the sticky CTA lands on /signup. But cta.tsx alone links straight to /signup?next=%2Fapply — one CTA skips the redirect hop, four others eat it (extra 307 + full page load since they're <a>, not <Link>). AND: zero analytics anywhere — grep for gtag/plausible/posthog/va.track/mixpanel/segment finds nothing; @vercel/analytics not in package.json. No event fires on any Apply click, signup, or application submit. Sentry is the only third-party. The funnel is completely unmeasured.

**Evidence:** `grep analytics/gtag/plausible/posthog/va.track → no hits outside admin page names; hero.tsx:69 <a href="/apply"> vs cta.tsx:89 <Link href="/signup?next=%2Fapply">`

**Fix:** Add @vercel/analytics (or Plausible) with events on apply-CTA click, signup success, application submit; unify all CTAs on one href (direct /signup?next=%2Fapply for logged-out) using <Link>.

### [MINOR] copy-accuracy — components/comparison.tsx:63
**Issue:** Comparison table claims batch0 is 'Year-round: Yes' — exactly one cohort exists and none has ever run. Also asserts specific competitor facts (LaunchX '$3,000–$8,000', repeated in stats.tsx:31 and problem.tsx:8) that invite dispute.

**Evidence:** `{ program: "batch0", … yearRound: true, highlight: true }`

**Fix:** Change to 'Multiple cohorts planned' or drop the row until a second cohort is scheduled; soften competitor pricing to 'typically thousands of dollars'.

### [MINOR] copy-accuracy — components/faq.tsx:39
**Issue:** FAQ self-contradictions: 'Small enough that mentors and peers know you by name. Cohort 1 (Summer 2026) is capped at 100 students' — 100 isn't intimate, and capacity comes live from the DB while the framing assumes ~24. Also 'U.S. high schoolers only' (faq.tsx:15,23; hero; JSON-LD audience) contradicts lib/pricing.ts:14-17 India PPP override and JSON-LD offer text 'Reduced regional pricing available in select countries' (layout.tsx:78).

**Evidence:** `a: 'Small enough that mentors and peers know you by name. ${cohortPrefix} is capped at ${derived.capacityLabel} students.' → renders '…capped at 100 students'`

**Fix:** Rewrite the size answer for the real capacity, and either drop the India price override + 'select countries' line or drop the U.S.-only claim.

### [MINOR] copy-accuracy — components/cta.tsx:26
**Issue:** Template bug risk: `{cohortLabel} launches {derived.cohortName}` where cohortLabel falls back to cohortName when cohort_number is null (line 8) — renders 'Summer 2026 launches Summer 2026.' if the DB cohort row lacks cohort_number. Also 'launches Summer 2026' is a season, not a date, when real dates (Jul 30) exist in config.

**Evidence:** `const cohortLabel = derived.cohortLabel || derived.cohortName; … {cohortLabel} launches {derived.cohortName}.`

**Fix:** Use derived.cohortHeadline + dateRangeLabel: 'Cohort 1 starts Jul 30.' and guard the null-cohortNumber case.

### [MINOR] copy-accuracy — lib/site-config.ts:92
**Issue:** FALLBACK_COHORT is stale on every axis vs the real cohort: dates 2026-06-15→07-13 (real: 07-30→09-13), capacity 24 (real: 100), price 13000¢/$130 (real: 12999¢/$129.99). apply/page.tsx also hardcodes fallbacks 24 (line 123) and 13000 (line 125). If Supabase blips, the site quotes wrong dates, price, and capacity.

**Evidence:** `FALLBACK_COHORT = { name: "Summer 2026", startsOn: "2026-06-15", endsOn: "2026-07-13", capacity: 24, priceCents: 13000 … }`

**Fix:** Sync fallback constants to the real cohort row (07-30→09-13, 100, 12999) and centralize them so apply/page.tsx reuses them.

### [MINOR] forms — app/sponsors/sponsor-contact-form.tsx:27
**Issue:** The sponsor inquiry form doesn't submit anywhere — onSubmit builds a mailto: URL and sets window.location. No server action, no table, no record; silently fails for users without a configured mail client (most desktop browsers), losing $1.5k–$15k sponsorship leads. Contrast: the apply form properly writes to the `applications` table via server actions with strict zod validation (app/apply/actions.ts SubmitSchema: parent email required under 18, draft autosave rate-limited 30/min) and signup works (service-role createUser with email_confirm:true, then signInWithPassword).

**Evidence:** `const href = 'mailto:${CONTACT_EMAIL}?subject=…'; window.location.href = href;`

**Fix:** Add a server action writing to a sponsor_inquiries table (+ Resend notification, already wired for apply), keep mailto as fallback link.

### [MINOR] links — app/page.tsx:24
**Issue:** Hero's 'See how it works' (hero.tsx:77) targets #how-it-works, which lives inside the dynamically-imported ScrollPreview. The loading placeholder (a bare 60/80rem spacer div) has no id, so clicking before the below-fold chunk loads scrolls nowhere; direct visits to /#how-it-works can also miss.

**Evidence:** `loading: () => <div aria-hidden className="h-[60rem] md:h-[80rem]" /> — no id="how-it-works" on the placeholder`

**Fix:** Put id="how-it-works" on the placeholder div (or wrap the dynamic component in a server-rendered <section id="how-it-works">).

### [MINOR] performance — app/opengraph-image.tsx:10
**Issue:** OG image is force-dynamic with runtime nodejs — every scraper hit runs a full Supabase round-trip (getSiteConfig makes 4+ queries) to render an image whose data changes rarely. It also bakes in the '4-week' subline (line 92) and rounded price. Design verdict: the image itself is on-brand, not slop — black bg, #FFBB00 radial glow, brand logomark, live 'Cohort 1 · Summer 2026 · $130' pill, 'Learn to build a startup. Pitch it to investors.' headline, 'batch0.org / Ages 13–18 · Fully Virtual' footer. Worth keeping, just fix the claims and caching.

**Evidence:** `export const dynamic = "force-dynamic"; … "The 4-week, fully virtual entrepreneurship program for U.S. high schoolers."`

**Fix:** Switch to revalidate = 3600 (revalidatePath on admin save already exists), fix the duration copy, use exact price.

### [MINOR] performance — package.json:12
**Issue:** Third-party/perf inventory: @sentry/nextjs is the ONLY third-party script (~30-60KB gz client bundle + /monitoring tunnel route; replays off, traces 0.1 — sane config but nonzero weight for a marketing page with zero analytics). framer-motion is well-contained: only container-scroll.tsx imports it, loaded via next/dynamic below the fold, desktop-only (mobile gets static cards); ui/reveal.tsx is a hand-rolled IntersectionObserver. 'use client' on navbar/faq/sticky-mobile-cta/scroll-preview is justified (interactivity). Sticky CTA scroll listener is passive. Images: public/ has NO raster assets at all (logo.svg only) — no oversized-asset risk; marketing uses next/image with explicit width/height everywhere; raw <img> without dimensions exists only on gated app pages (team logo_url uploads, e.g. app/dashboard/team/team-home.tsx:75) — minor CLS there, invisible to crawlers.

**Evidence:** `"@sentry/nextjs": "^10.52.0", "framer-motion": "^11.11.0" — grep framer-motion → container-scroll.tsx only (reveal.tsx mentions it in a comment)`

**Fix:** Keep Sentry; consider lazyOnload init. If adding analytics (see funnel finding), prefer a <1KB script (Plausible/Vercel Analytics) to keep the marketing bundle lean.

### [MINOR] seo-robots-sitemap — app/sitemap.ts:11
**Issue:** Sitemap lists only 5 URLs (/, /sponsors, terms, privacy, refund-policy) with lastModified: new Date() on every build — a constantly-shifting lastmod that crawlers learn to ignore. /signup and /login (public, indexable, linked from every page) are omitted; no program/curriculum info page exists to list.

**Evidence:** `const now = new Date(); return [{ url: '${BASE}/', lastModified: now, … }]`

**Fix:** Add /signup (and /login), use real content-change dates or drop lastModified, and add the public program page once created.


## Visual auditor notes

Audit covered every scoped file: app/page.tsx and all 15 imported marketing components (plus ui/reveal, ui/button, ui/input used by them), app/(auth)/* (layout, login, signup, forgot-password, reset + forms), app/(legal)/* (layout + terms/privacy/refund prose pages), app/sponsors/* (page, tiers, contact form), app/globals.css, tailwind.config.ts, app/opengraph-image.tsx, app/layout.tsx, and public/ (contains only logo.svg). Clean checklist items — no purple/violet/indigo/blue gradients anywhere (the lone blue hit is a .theme-light dashboard status-color override in globals.css:323, out of marketing scope); no border-l-4 accent strips; no emoji in UI copy on the marketing surface; no italic-serif hero (the opposite problem — no typographic identity at all, filed as MAJOR); no hover scale/rotate on images; no AI stock imagery (instead: zero imagery, filed as MINOR). Legal pages are clean prose via the custom .legal-prose ruleset. Mitigating credits worth preserving in any redesign: prefers-reduced-motion is honored globally and in container-scroll; the mobile scroll-preview deliberately replaces the 3D mock with readable cards; the problem section's numbered-list layout is the best non-template pattern on the page and a good model for fixing builds.tsx; the 'funding never guaranteed' compliance copy is consistent and should survive any rewrite. Biggest wins in order: delete the Aceternity container-scroll (also drops framer-motion from the marketing bundle), break the 12× eyebrow-kicker rhythm, replace the named-competitor table, pick a real typeface, and de-glow the CTAs/pills/pulses.

## Copy auditor notes

SCOPE COVERED: app/page.tsx + all 13 imported landing components, navbar (imported by page.tsx), app/(auth)/login|signup|forgot-password|reset + layout, app/(legal) titles, app/sponsors (page, tiers, form host), app/layout.tsx metadata + JSON-LD, app/opengraph-image.tsx, lib/site-config.ts, lib/pricing.ts. All domain references are batch0.org (correct); no .com references found. No literal customer testimonials exist on the site — the closest is sponsor.tsx \"12–20 hr weekly time saved — Reported by clients\" (flagged CRITICAL as an unattributed testimonial-class claim).

CHECKLIST 10 — FULL STATS INVENTORY (every number shown, verifiable vs invented):
• Hero proof row: capacity \"100\" (VERIFIABLE, from DB) · \"$130\" tuition (NEAR — DB is $129.99; display rounds up, JSON-LD hardcodes 130) · \"4 wks\" (CONTRADICTED — cohort window Jul 30→Sep 13 ≈ 6.5 wks) · Pitch Day \"Live / Sponsors + investors\" (INVENTED — 0 events, 0 sponsors).
• Stats section: capacity 100 (VERIFIABLE) · \"4 wks\" (CONTRADICTED) · \"100% Virtual\" (VERIFIABLE format claim) · \"$3,000–$8,000+\" LaunchX/LeanGap comparison (EXTERNAL, roughly checkable; repeated 4× across problem/stats/faq/comparison).
• Sponsor (Impetus AI) stats: \"10+\" products (UNVERIFIABLE), \"8 yrs\" founder experience (CONTRADICTS founder age 18/solo), \"12–20 hr\" saved \"reported by clients\" (UNVERIFIABLE/testimonial-shaped).
• Sponsors page: \"100 vetted teen founders per cohort\" (capacity real, \"vetted founders\" INVENTED — 0 enrollments), \"12–24 months\" trajectory (INVENTED), tiers $1,500/$5,000/$15,000 (real offers, fine), \"Most popular\" (INVENTED social proof).
• FAQ/CTA micro-numbers: ages 13–18 (fine), \"~5 minutes\" apply, \"30 seconds\" signup (plausible, unverified), \"8 of N spots filled\" spotsLabel (VERIFIABLE, live from DB — good pattern).

COUNTS REQUESTED: manufactured-contrast aphorisms = 7 (listed in finding); em dashes = 33 across landing components (hero 3, problem 1, builds 3, curriculum 5, stats 2, sponsor 1, comparison 2, faq 7, cta 4, footer 1, scroll-preview 4) ≈ 1 per 55 words vs the 1/150 threshold; \"Funding is never guaranteed\" = 11 landing instances + 4 in metadata; \"zero equity\" variants = 6+.

WHAT'S ACTUALLY GOOD (don't destroy in rewrite): the live spotsLabel/countdown derivation in site-config.ts is honest, data-driven urgency; the FAQ answers on equity/what-you-pay-for are unusually candid in structure (just over-hedged); the price-anchoring against $3,000–$8,000 competitors is the site's one defensible, specific wedge; regional pricing rationale in lib/pricing.ts is genuine POV. The single biggest theme: nearly every trust element (mentors, investors, community, sponsor, popularity, duration) is written as if Cohort 3 already happened. The fix is one editorial rule — write from the truth that this is Cohort 1, founder-run, launching Jul 30 — which is itself a stronger, un-swappable story.
