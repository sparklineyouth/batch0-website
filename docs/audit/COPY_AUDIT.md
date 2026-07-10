# COPY_AUDIT.md — every piece of user-facing copy (BEFORE state)

Extracted 2026-07-10 from the pre-overhaul site. The AFTER copy deck is appended by Phase 4.


## Route: (global) app/layout.tsx metadata + shared config

### Root metadata — app/layout.tsx

> Title: "SparkLine Youth — The 4-Week Entrepreneurship Program for High Schoolers"
> Description: "Apply, learn how to launch a real startup in 4 weeks, then pitch live to our investor network. Curriculum, mentor support, and optional sponsorship for standouts — funding never guaranteed. For U.S. high schoolers."
> Keywords: "high school startup accelerator", "youth entrepreneurship", "teen entrepreneur program", "virtual accelerator", "SparkLine Youth"
> OG title: "SparkLine Youth — The 4-Week Entrepreneurship Program for High Schoolers"
> OG description: "Apply, learn how to launch a real startup in 4 weeks, then pitch live to our investor network. Optional sponsorship for standouts; funding never guaranteed. Keep 100% of your equity."
> OG siteName: "SparkLine Youth" · OG url: https://sparklineyouth.org
> Twitter title: "SparkLine Youth — The 4-Week Entrepreneurship Program for High Schoolers"
> Twitter description: "Apply, learn how to launch a real startup in 4 weeks, then pitch live to our investor network. Optional sponsorship for standouts; funding never guaranteed. Keep 100% of your equity."

### JSON-LD structured data — app/layout.tsx

> name: "SparkLine Youth" · alternateName: "SparkLine"
> description: "SparkLine Youth is a 4-week, fully virtual entrepreneurship program for U.S. high schoolers. Students learn how to launch a real startup with mentor support, then pitch live in front of our investor network — keeping 100% of their equity. Optional sponsorship for standouts; funding is never guaranteed."
> contactPoint email: hello@impetusai.net (contactType: "customer support")
> audienceType: "U.S. high school students, ages 13–18"
> offer: price "130" USD, category "Tuition", description: "4-week virtual entrepreneurship program cohort tuition. Reduced regional pricing available in select countries."

### Skip link — app/layout.tsx

> "Skip to content"

### Site config derived/dynamic copy — lib/site-config.ts

> Fallback cohort (used when DB has none): name "Summer 2026", cohortNumber 1, starts 2026-06-15, ends 2026-07-13, capacity 24, priceCents 13000 (=$130).
> Derived labels produced:
> - cohortLabel: "Cohort {n}" (e.g. "Cohort 1") or ""
> - cohortHeadline: "{cohortLabel} · {cohortName}" → "Cohort 1 · Summer 2026"
> - dateRangeLabel: "{Mon D} → {Mon D}" → "Jun 15 → Jul 13"
> - priceLabel: "${dollars}" → "$130" default; basePriceLabel "$130"
> - capacityLabel: "24"
> - spotsLabel: "Cohort full" when 0 left; "{n} spots left" when 1–9 left; "" otherwise
> - applicationsCountdownLabel: "Applications closed" (past close) / "Applications close in 1 day" / "Applications close in {n} days" (≤14 days) / "Apply by {Mon D}" (further out) / ""
> Fallback settings: contactEmail "hello@impetusai.net"; applicationsClosedMessage "Applications are currently closed. Check back soon for the next cohort."

### Regional pricing values — lib/pricing.ts

> All amounts billed in USD. Default price = cohort price_cents ($130 via fallback). Override table: IN (India) = 11500 cents → "$115" (PPP-adjusted vs. the U.S. base). Detection via x-vercel-ip-country / cf-ipcountry / x-country headers; unknown codes ("XX", "T1") fall back to default price. isRegionalPrice=true only when an override applies.

### OG image (dynamic) — app/opengraph-image.tsx

> Alt: "SparkLine Youth — The 4-Week Entrepreneurship Program for High Schoolers"
> Brand: "SparkLine Youth" (Spark / Line / Youth)
> Badge (dynamic): "{cohortHeadline} · {priceLabel}" → e.g. "Cohort 1 · Summer 2026 · $130"
> Headline: "Learn to build a startup." / "Pitch it to investors."
> Sub: "The 4-week, fully virtual entrepreneurship program for U.S. high schoolers."
> Footer row: "sparklineyouth.org" · "Ages 13–18 · Fully Virtual"

### Shared auth error copy — lib/auth-errors.ts

> "Something went wrong. Try again."
> "That email and password don't match. Double-check, or reset your password."
> "Please verify your email first — check your inbox for the link we sent at signup."
> "An account with that email already exists. Try logging in instead."
> "Pick a stronger password — at least 8 characters, mixing letters and numbers."
> "Too many attempts in a row. Wait a minute, then try again."
> "That email doesn't look right. Check for typos."
> "New signups are temporarily closed. Try again later."
> "Connection problem. Check your internet and try again."

## Route: /

### Navbar — components/navbar.tsx

> Brand: "SparkLine Youth" (rendered Spark/Line/Youth with accent on "Line")
> Nav links: "Program" (/#how-it-works), "Curriculum" (/#curriculum), "Sponsors" (/sponsors), "FAQ" (/#faq)
> Desktop CTAs: "Create account" (/signup); primary button "Apply" → (authed: "Dashboard") with "→"
> Hamburger aria-label: "Open menu"
> Mobile drawer: aria-label "Site navigation"; close button aria-label "Close menu" (x2 — backdrop + X button)
> Drawer CTAs: "Apply" → (authed: "Go to dashboard") with "→"; "Create account"; "Already have an account? Log in"
> Drawer footer links: "Terms" · "Privacy" · "Refunds"
> Logo alt: "SparkLine Youth"

### Hero — components/hero.tsx

> Eyebrow pill (dynamic): "{cohortHeadline} · {acceptingLabel}" — acceptingLabel is the live signal (countdown label or "{n} spots left" when ≤5 left) or "Applications open" / "Applications closed"
> H1: "Learn to build a startup." / "Pitch it to investors." ("investors" has shine treatment)
> Subhead: "SparkLine Youth is a 4-week, fully virtual entrepreneurship program for U.S. high schoolers. You get the curriculum, mentor support, and a live pitch to our investor network. Funding is never guaranteed — we open the room; what investors decide is up to them."
> Primary CTA: "Start your application" (authed: "Go to dashboard") with "→"
> Secondary CTA: "See how it works"
> Sub-CTA line (unauthed): "Free to apply · {priceLabel} only if accepted" (+ optional "· {spotsLabel}")
> Proof stats (label / value / sub):
> - "Cohort size" / "{capacityLabel}" (24) / "Seats per cohort"
> - "Tuition" / "{priceLabel}" ($130) / "Free to apply" (accent)
> - "Format" / "4 wks" / "Fully virtual"
> - "Pitch Day" / "Live" / "Sponsors + investors"

### Marquee — components/marquee.tsx (aria-hidden decorative strip)

> "Customer Discovery" / "Lean Canvas" / "MVP & Product" / "Business Model" / "Pricing Strategy" / "Go-to-Market" / "Brand Positioning" / "Pitch Deck" / "SparkLine Sponsorship" / "Investor Intros" / "Zero Equity" (items repeat, separated by "/") — NOTE: section is aria-hidden

### Problem — components/problem.tsx

> Eyebrow: "The problem"
> H2: "Youth entrepreneurship is broken."
> Intro: "Teens with real startup ideas don't need another business-plan competition. They need a structured way to build the skills, a coach who's done it, and a shot at investor exposure that doesn't depend on which zip code they grew up in."
> 01 "Priced for the few": "LaunchX, LeanGap, and most serious entrepreneurship programs gate access behind $3,000–$8,000+ tuition. The teens who would benefit most can't afford to apply."
> 02 "Skills, but no scaffolding": "YouTube and ChatGPT can teach you a Lean Canvas — they can't tell you which skill to build next, give you live mentor feedback, or hand you a deadline. Self-teaching stalls; real founders need a sequence."
> 03 "Certificates, not connections": "Programs that end with a plaque don't change much. We end with mentor support, a live pitch in front of our investor network, and optional sponsorship for cohort standouts. No equity taken. Funding is never guaranteed."

### Builds (what you'll learn) — components/builds.tsx

> Eyebrow: "What you'll learn"
> H2: "The skills founders actually use."
> Intro: "Six core skill blocks. Taught in sequence, applied to your own startup, with feedback from mentors who have shipped."
> Cards:
> - "Customer discovery": "Find a real problem worth solving. Lean Canvas, problem-solution fit, structured user interviews."
> - "MVP & product": "Ship a v1 fast — landing page, no-code MVP, or working prototype — without overbuilding before validation."
> - "Business model": "Revenue, pricing, unit economics. Turn your idea into something investors can actually back."
> - "Go-to-market": "Brand, positioning, distribution. Land your first hundred users with a wedge you can actually execute."
> - "Pitch & storytelling": "A deck that holds up to investor scrutiny, and the live delivery to back it up."
> - "Fundraising fundamentals": "How sponsorship, angel, and pre-seed capital actually work — and how to ask for it without giving away the farm."

### Scroll preview / product section — components/scroll-preview.tsx (#how-it-works)

> MOBILE + DESKTOP shared header — Eyebrow: "The product"; H2: "From idea to investor-ready" ("investor-ready" shine); Sub: "Live startup curriculum, weekly deliverables, real founder mentors, and a cohort dashboard that keeps everything in one place."
> MOBILE feature cards (eyebrow / title / body):
> - "Curriculum" / "Weekly skill blocks + live sessions" / "Pre-recorded startup modules you can watch on your schedule, plus a weekly group session with mentors and peers."
> - "Always-on" / "Your AI co-founder" / "Stuck on a Lean Canvas at 11pm? Your AI co-founder is trained on the cohort curriculum and your own progress."
> - "Pitch Day" / "Investor pitch + intros" / "Week 4 ends live on Zoom in front of the SparkLine team and our investor network. Standouts may be offered sponsorship and warm intros — zero equity, ever. Funding is never guaranteed."
> Mobile footer line: "Everything ships inside one dashboard · Apply" (link to #apply)
> DESKTOP mock-dashboard copy: sidebar brand "SparkLine Youth"; badge "2"; nav items "Home, Application, Course, Assignments, Check-in, Events, Resources, Community, AI co-founder, Files, Billing, Settings"; "Welcome, Riya."; "Your startup, your skill blocks, your investor prep."; card "Application" + badge "Accepted" + "You're in" + button "Pay {priceLabel}" ($130); card "Course access" + "{cohortName}" (Summer 2026) + "{dateRangeLabel}" (Jun 15 → Jul 13) + button "Open course"; "Quick links": "View application", "Billing", "Settings", "Community"; banner "This week" / "Week 1 · Customer discovery due Sunday" / button "Open"

### Curriculum — components/curriculum.tsx (#curriculum)

> Eyebrow: "The 4-week sprint"
> H2: "Idea to investor-ready."
> Intro: "Each week is a startup skill block, with a deliverable built on your own company. You finish with an investor-ready startup package and a live pitch in front of our investor network — not a participation certificate. Funding is never guaranteed."
> Week 1 "Validate" (deliverable "Validated Lean Canvas"): "Lean Canvas. Problem-solution fit. Real customer interviews — not friends and family. End the week with a hypothesis you've actually tested in the wild."
> Week 2 "Build" (deliverable "MVP + Business Model"): "Ship a v1 — landing page, no-code MVP, or working prototype. Business model, pricing, and unit economics that hold up to a sharp question."
> Week 3 "Market" (deliverable "GTM Plan + Brand"): "Go-to-market plan, competitive landscape, brand positioning. Find your first hundred users — and the distribution wedge that gets you there."
> Week 4 "Pitch" (deliverable "Sponsor + Investor Pitch (Live)"): "Final pitch deck. Rehearsals with mentors. Pitch live on Zoom in front of our investor network — cohort standouts may be offered SparkLine sponsorship and warm intros. Funding is never guaranteed."

### Stats / tuition band — components/stats.tsx

> Eyebrow: "Tuition"
> Big number: "{priceLabel}" ($130) + "one-time"
> Body: "Compare to LaunchX or LeanGap at $3,000–$8,000+. Free to apply, charged only if accepted. Sponsorship and investor intros are merit-based — never paid, and never guaranteed."
> Supporting stats (value / label / sub):
> - "{capacityLabel}" (24) / "Seats per cohort" / "Capped on purpose"
> - "4 wks" / "Idea → pitch" / "Live mentor feedback"
> - "100%" / "Virtual" / "Open to U.S. teens"

### Sponsor (Impetus AI) — components/sponsor.tsx (#sponsor)

> Badge: "Presenting sponsor"
> H2: "Powered by Impetus AI."
> Body: "SparkLine Youth runs on the backing of Impetus AI — AI consulting for local businesses. They bring enterprise-grade AI strategy to small and medium-sized companies that don't have Fortune 500 resources, and they fund the seats, mentors, and infrastructure that make this cohort free to apply."
> Pillars:
> - "AI Audit": "Free 48-hour operations review with a prioritized opportunity map and vendor recommendations."
> - "AI Roadmap": "90-day implementation plan with budget projections and build-vs-buy analysis."
> - "Full Build": "Custom AI tools, system integration, staff training, and post-launch support."
> Stats: "10+" / "AI products shipped" / "Across medical, e-commerce, ops" — "8 yrs" / "Founder experience" / "Quantiphi, Schroders, robotics" — "12–20 hr" / "Weekly time saved" / "Reported by clients"
> CTAs: "Visit impetusai.net" (→ https://impetusai.net); "hello@impetusai.net" (mailto)
> Tagline: "New Jersey · serving global clients"

### Comparison — components/comparison.tsx (#compare)

> Eyebrow: "Why SparkLine Youth"
> H2: "Affordable. Virtual. Real investor exposure."
> Intro: "Four axes worth comparing: cost, what happens after Pitch Day, whether it actually runs online, and whether you can join when it fits your year. Funding is never guaranteed — but the room is."
> Badge: "Zero equity. Ever."
> Table headers: "Program", "Cost", "Investor exposure", "Virtual", "Year-round"
> Rows:
> - LaunchX: "$3,000–$8,000" / "Investors" / "Partial" / No
> - LeanGap: "Varies" / "Investors" / "Partial" / No
> - YEA!: "School-based" / "Panel only" / No / "Academic year"
> - SparkLine Youth (highlighted): "{priceLabel}" ($130) / "Pitch + intros" / Yes / Yes
> Boolean cells render as "Yes" / "No"

### FAQ — components/faq.tsx (#faq)

> Eyebrow: "FAQ" · H2: "Questions, answered."
> Q: "Who is SparkLine Youth for?" A: "Any U.S. high schooler ages 13–18 who wants to learn how to build a real startup — and is willing to put in 4 weeks of focused work. Bring an idea, a half-formed hunch, or nothing at all. No prior experience required, but the application is selective."
> Q: "How much does it cost?" A: "{priceLabel} for the full 4-week cohort. No hidden fees, no upsells. Comparable programs run $3,000–$8,000."
> Q: "Is it really fully virtual?" A: "Yes. Pre-recorded skill modules plus live weekly group sessions on Zoom, 1:1 mentor checkpoints, and an active Discord community. You can join from anywhere in the U.S."
> Q: "How does the sponsorship and investor side actually work?" A: "Pitch Day at the end of Week 4 happens live on Zoom in front of the SparkLine team and our investor network. Cohort standouts may be offered direct sponsorship from SparkLine, and we make warm introductions to investors in our network — angels, scout funds, and pre-seed VCs interested in young founders. Sponsorship, if offered, is a non-dilutive grant. Investor intros are connections, not checks. We make no guarantee any of this leads to funding; what investors decide is up to them."
> Q: "What am I actually paying for?" A: "Tuition pays for the program: the 4-week curriculum, our team's mentor support, the Discord community, and a live pitch slot in front of our investor network. You are not paying for funding, an investment, or a sponsorship offer — those are merit-based, separate, and never guaranteed."
> Q: "What if I don't have an idea yet?" A: "Week 1 is built for that. We walk you through customer discovery and structured idea validation — so you find a real problem worth solving, not just guess at one."
> Q: "How big are the cohorts?" A: "Small enough that mentors and peers know you by name. {cohortPrefix} is capped at {capacityLabel} students." (cohortPrefix → "Cohort 1 (Summer 2026)")
> Q: "What do I walk away with?" A: "A validated Lean Canvas, a working v1 of your startup, a real business model, a go-to-market plan, and an investor-ready pitch deck — plus a live pitch in front of our investor network, with warm intros and a shot at SparkLine sponsorship for cohort standouts. Funding is never guaranteed."
> Q: "Does SparkLine Youth take equity or own my idea?" A: "No. You own 100% of your idea, your work, and your company — before, during, and after the cohort. SparkLine Youth takes no equity, no IP, and no royalties on the program itself. Sponsorship, if offered, is a non-dilutive grant. Any investment that comes from our investor intros is a separate conversation between you and the investor — we never take a cut, and we never guarantee a check."

### CTA — components/cta.tsx (#apply)

> Eyebrow: "Reserve your seat"
> H2: "Your startup, in front of investors."
> Intro (dynamic): "{cohortLabel} launches {cohortName}. {capacityLabel} seats. {priceLabel} if accepted. Mentor support, a live investor pitch, and optional sponsorship for cohort standouts — funding is never guaranteed." → e.g. "Cohort 1 launches Summer 2026. 24 seats. $130 if accepted. …"
> Price column: label "Tuition if accepted"; "{priceLabel}" ($130) + "one-time"; "$0" chip + "Free to apply · ~5 minutes"
> Bullets: "4 weeks, fully virtual — startup skill blocks" / "Mentor sessions + Discord community" / "Live pitch in front of our investor network" / "Optional sponsorship + warm intros for standouts — zero equity, funding never guaranteed"
> Urgency chip (dynamic): "{applicationsCountdownLabel}" and/or "{spotsLabel}" separated by "·"
> Button: "Start your application" with "→" (→ /signup?next=%2Fapply)
> "Rolling admissions · Reviewed weekly"
> "Already applied? Log in"
> Footer: "Questions? {contactEmail}" (hello@impetusai.net)

### Footer — components/footer.tsx

> Brand: "SparkLine Youth" (logo alt "SparkLine Youth")
> Blurb: "A 4-week, fully virtual entrepreneurship program for U.S. high schoolers. Curriculum, mentor support, and a live pitch in front of our investor network. Optional sponsorship for standouts — zero equity, ever. Funding is never guaranteed."
> "sparklineyouth.org"
> Column "Program": "How it works", "Curriculum", "Why SparkLine Youth", "Sponsors", "Apply"
> Column "Connect": "{contactEmail}" (hello@impetusai.net), "Log in", "Apply"
> Legal row: "© {year} SparkLine Youth. All rights reserved." · "Terms" · "Privacy" · "Refunds"

### Sticky mobile CTA — components/sticky-mobile-cta.tsx

> Button (→ /apply): "Apply to SparkLine Youth" / subline "Free · {priceLabel} if accepted" ($130) / "→" — shown only on mobile, after scrolling past hero, when unauthenticated and applications are open

## Route: /sponsors

### Metadata — app/sponsors/page.tsx

> Title: "Sponsor SparkLine Youth — Fund the next generation of founders"
> Description: "Get your brand in front of 100 vetted teen founders per cohort. Fund standout founders directly. Build pipeline."

### Hero — app/sponsors/page.tsx

> Badge: "Sponsorship"
> H1: "Sponsor the next generation of founders." ("founders" shine)
> Subhead: "Get your brand in front of 100 vetted teen founders per cohort. Fund standout founders directly, side-by-side with our investor network."
> CTAs: "See tiers" with "→" (#tiers); "Get in touch" (#contact)

### Why sponsor — app/sponsors/page.tsx

> Eyebrow: "Why sponsor SparkLine?" · H2: "Three things you get back."
> - "Pipeline": "100 vetted teen founders per cohort, many headed to top engineering and business programs in 12–24 months. Get early reads on talent before recruiters do."
> - "Brand": "Logo on the cohort dashboard, workshop slot, presence on Pitch Day alongside our investor network. Be visible where teen founders actually spend their time."
> - "Impact": "Direct, non-dilutive sponsorship to teen founders. Real outcomes, real reportable impact for ESG and community programs."

### Tiers — app/sponsors/page.tsx + app/sponsors/tiers.ts

> Eyebrow: "Sponsor tiers" · H2: "Pick the level that fits."
> Intro: "Every tier contributes to direct founder sponsorships for cohort standouts. Custom packages available — just ask."
> Badge on highlighted tier: "Most popular"
> - "Supporter" — "$1,500" — "Get on the board." — perks: "Logo on the cohort dashboard", "Mention in the cohort newsletter"
> - "Partner" (highlight) — "$5,000" — "Show up where the work happens." — perks: "Everything in Supporter", "One workshop slot with the cohort", "Direct contribution to the grant pool", "Demo Day attendance"
> - "Lead" — "$15,000" — "Be the headline." — perks: "Everything in Partner", "Presenting sponsor branding", "Named grant: \"The [Sponsor] Founder Grant\"", "First look at standout teens for internships and recruiting"
> Per-tier button: "Talk to us" with "→"

### Contact — app/sponsors/page.tsx + app/sponsors/sponsor-contact-form.tsx

> Eyebrow: "Get in touch" · H2: "Let's build something together."
> Intro: "Tell us a bit about your company and which tier looks right — we'll come back with a tailored proposal."
> Form labels: "Name"* , "Company"* , "Email"* , "Tier interest", "Message"
> Placeholders: "Your name", "Company or organization", "you@company.com", "Anything else we should know? Goals, timing, questions."
> Tier select options: "Supporter ($1,500)", "Partner ($5,000)", "Lead ($15,000)", "Custom / not sure yet"
> Helper: "Opens your mail client. We reply within 2 business days."
> Submit: "Send inquiry" with "→"
> Generated mailto (to hello@impetusai.net) subject: "Sponsorship inquiry — {company|name|SparkLine Youth}"; body fields: "Name:", "Company:", "Email:", "Tier interest:", "Message:"

## Route: /login

### Auth layout (shared) — app/(auth)/layout.tsx

> Brand link: "SparkLine Youth" (logo alt "SparkLine Youth")

### Login page — app/(auth)/login/page.tsx

> Meta title: "Log in · SparkLine Youth"
> H1: "Welcome back"
> Sub: "Log in to continue your SparkLine Youth journey."
> "New here? Create an account"
> "Forgot your password?"

### Login form — app/(auth)/login/login-form.tsx

> Labels: "Email", "Password" (required, sr-only " required" suffix)
> Submit: "Log in" / loading: "Logging in…"
> Errors: via lib/auth-errors.ts friendlyAuthError (see global section)

## Route: /signup

### Signup page — app/(auth)/signup/page.tsx

> Meta title: "Sign up · SparkLine Youth"
> H1: "Create your account"
> Sub: "Sign up to apply for SparkLine Youth. Takes 30 seconds."
> "Already have an account? Log in"

### Signup form — app/(auth)/signup/signup-form.tsx

> Labels: "Full name", "Email", "Password"
> Password hint: "At least 8 characters. Use letters and numbers — avoid common words."
> Submit: "Create account" / loading: "Creating account…"
> Legal line: "By creating an account you agree to our Terms and Privacy Policy."

### Signup server action errors — app/(auth)/signup/actions.ts

> "Email and password are required."
> "Pick a stronger password — at least 8 characters."
> (plus friendlyAuthError fallbacks)
> Welcome notification (in-app, post-signup): title "Welcome to SparkLine Youth", body "Your account is ready. Apply when you're ready."

## Route: /forgot-password

### Forgot password — app/(auth)/forgot-password/page.tsx

> H1: "Reset password"
> Sub: "Enter your email and we'll send you a reset link."
> Label: "Email"
> Submit: "Send reset link" / loading: "Sending…"
> Success state: "Check your email" / "If an account exists for {email}, a reset link is on its way. The link expires in an hour."
> "Back to login"

## Route: /reset

### Reset password — app/(auth)/reset/page.tsx

> H1: "Set a new password"
> Sub: "Choose something only you'll know. You'll stay signed in after this."
> Labels: "New password", "Confirm password"
> Hint: "At least 8 characters."
> Inline validation errors: "Use at least 8 characters." / "Passwords don't match."
> Submit: "Save password" / loading: "Saving…"

## Route: /terms

### Terms of Service — app/(legal)/terms/page.tsx

> Meta title: "Terms of Service · SparkLine Youth"
> H1: "Terms of Service" · "Last updated: May 12, 2026"
> Intro: "These Terms of Service govern your use of SparkLine Youth (sparklineyouth.org), operated by SparkLine Youth. By creating an account or using the platform, you agree to these terms."
> "Eligibility": "SparkLine Youth is intended for U.S. high schoolers, generally ages 13–18. If you are under 18, you must have permission from a parent or legal guardian to use the platform."
> "Accounts": "You're responsible for keeping your password secure and for all activity under your account. Don't share your credentials. Notify us promptly if you believe your account has been compromised."
> "Payments": "SparkLine Youth charges a one-time enrollment fee per cohort. All payments are processed by Stripe. Prices are listed in USD. See our refund policy for refund terms."
> "Acceptable use": "Don't use SparkLine Youth to harass other users, infringe intellectual property, distribute malware, or attempt to compromise the platform's security."
> "Content you upload": "You retain ownership of anything you upload (drafts, files, pitch decks, submissions). You grant SparkLine Youth a limited license to host and display your content for the purpose of running the program."
> "Your ideas, your IP, your company": "You own 100% of your idea, your intellectual property, and any company you build during or after the program. SparkLine Youth does not take equity, royalties, revenue share, or any ownership interest in your business as a condition of participating. We don't claim your IP, we don't license your work to third parties, and we don't sell information about your idea. Mentors, instructors, and staff are bound by the same rule." + "The only thing we ask: permission to attribute. We may publicly mention that a project, founder, or company \"was built at SparkLine Youth\" or \"started in a SparkLine Youth cohort\" — for example, in case studies, alumni lists, social posts, and our website. This is attribution only and creates no ownership, partnership, or agency relationship between SparkLine Youth and your business. If you'd prefer not to be named publicly, email hello@impetusai.net and we'll honor that."
> "Termination": "You can delete your account at any time from your settings page. SparkLine Youth may suspend or terminate accounts that violate these terms."
> "Disclaimer": "SparkLine Youth is provided \"as is\" without warranties. We don't guarantee investment outcomes — Demo Day connects students with real investors, but funding is at the investors' discretion."
> "Contact": "Questions about these terms? hello@impetusai.net"

## Route: /privacy

### Privacy Policy — app/(legal)/privacy/page.tsx

> Meta title: "Privacy Policy · SparkLine Youth"
> H1: "Privacy Policy" · "Last updated: May 12, 2026"
> Intro: "We collect the minimum personal information needed to run the SparkLine Youth program, and we never sell your data."
> "What we collect": "Account info: name, email, password (hashed via Supabase Auth)." / "Application info: what you submit on /apply — age, grade, school, parent email, links." / "Payment info: we don't store your card. Stripe handles all payment data." / "Program usage: lesson progress, weekly check-ins, team threads, comments, and files you upload to your drive." / "Operational logs: standard server logs (IP, user agent) for security and debugging."
> "How we use it": "To run the application + payment + course flow." / "To send transactional emails about your account and the program." / "To improve the platform and protect against abuse."
> "Who we share with": "Service providers we use to operate the platform: Supabase (database + auth + storage), Stripe (payments), Resend (email), Anthropic (AI co-founder), Vercel (hosting). They process data on our behalf only." / "Mentors and investors only see what you choose to publish (e.g. a public team profile)."
> "Your rights": "You can update your profile or delete your account from settings. You can email us to request a copy of your data or full deletion at hello@impetusai.net."
> "Minors": "Many of our students are under 18. We rely on parental consent captured during application."
> "Your ideas and IP": "Anything you upload — pitch decks, business plans, customer research, code, drafts — belongs to you. SparkLine Youth will never sell, license, or share the substance of your idea with third parties for their own use. We don't take equity in your company and we don't claim ownership of your IP. The only public reference we may make is attribution (e.g. \"built at SparkLine Youth\"). Full terms are in our Terms of Service."
> "Contact": "Questions: hello@impetusai.net"

## Route: /refund-policy

### Refund Policy — app/(legal)/refund-policy/page.tsx

> Meta title: "Refund Policy · SparkLine Youth"
> H1: "Refund Policy" · "Last updated: May 12, 2026"
> Intro: "We want everyone to be happy with SparkLine Youth. Here's how refunds work."
> "Full refund within 7 days": "If you're not satisfied for any reason, you can request a full refund within 7 days of payment. Email us at hello@impetusai.net from the email tied to your account."
> "After the cohort starts": "Once your cohort begins, refunds are at our discretion. We're reasonable — if life happens, write to us."
> "How refunds are processed": "Refunds go back to the original payment method via Stripe. They typically appear within 5–10 business days."
> "Questions": "hello@impetusai.net"

---

# AFTER — the Phase 4 rewrite (key diffs)

Full copy lives in the components (git diff `26f36f6..HEAD`). The moves that matter:

| Where | Before | After | Why |
|---|---|---|---|
| `<title>` | "SparkLine Youth — The 4-Week Entrepreneurship Program…" | "Startup Accelerator for High Schoolers — SparkLine Youth" | Search phrase first; kills the false duration claim; 57 chars |
| Hero H1 | "Learn to build a startup. Pitch it to investors." | "Don't wait for college to start your company." | POV that argues with the reader's real objection; "learn" was course-speak; investor claim unverifiable |
| Hero sub | "…4-week… mentor support, and a live pitch to our investor network." | "…Four one-week build sprints, a company of your own, and a live demo day at the end. Funding is never guaranteed — the work is real either way." | Only owned mechanics; keeps the honest hedge |
| Proof bar | "Cohort size 24 · Tuition $130 · Format 4 wks · Pitch Day Live (Sponsors + investors)" | **The Cohort Ledger** — 6 rows rendered live from the cohorts table | Zero invented values; can't drift from the DB |
| Primary CTA | "Start your application" / "Apply" / "Get Started"-style variance | **"Apply for Cohort 1"** everywhere (config-derived) | One action, one name |
| Problem section | "Youth entrepreneurship is broken." + 3 essays | cut; its one defensible fact (competitor pricing) moved into Pricing | Generic category rant; claims about competitors we can't stand behind |
| Comparison table | 4 programs × 4 axes incl. "SparkLine: Year-round ✓" | cut | "Year-round" was false with one cohort ever |
| Mentor claims | "1:1 mentor checkpoints", "mentors who have shipped", "real founder mentors" | "every live session is run by the SparkLine team, led by founder Rish Dagli… no anonymous 'mentor networks'" | 0 mentors exist; names-before-payment is the promise we can keep |
| Investor claims | "our investor network — angels, scout funds, and pre-seed VCs" | "a live demo day where you pitch what you built" + sponsorship (real, Impetus-funded, merit-based) | The network doesn't verifiably exist; demo day does |
| "Active Discord community" | present-tense asset | cut | discord_url unset, no cohort has run |
| Sponsor section (home) | "Presenting sponsor… backed by Impetus AI" + invented stats | "Who runs this" — Rish Dagli + Impetus AI LLC as operator | Self-sponsorship framed as third-party backing; stats unverifiable |
| Sponsors page | "100 vetted teen founders per cohort… headed to top programs in 12–24 months", "Most popular" badge | "Cohort 1 seats up to 100… A straight ledger: no inflated alumni stats" | All three were fabricated proof |
| FAQ | "the application is selective", cost buried mid-answer | cost is the first sentence of the first answer; "every application gets read… clear thinking beats a long résumé" | Selectivity was a stat we don't have; parents scan for price |
| Fake dashboard | "Welcome, Riya." (invented student) in Aceternity scroll-jack | removed | Fabricated persona |
| Footer | 3-column SaaS footer, "4-week… investor network" blurb | entity + contact + 5 links + legal row | Footer is a legal signature, not a nav dump |

Voice check: second person throughout, every number sourced from the DB or
marked TODO(RISH), one manufactured-contrast construction on the entire
surface ("no participation certificates — the deliverable is the
certificate"), em-dash density sampled at ~1 per 200+ words.
