---
title: "How to Build and Run a Startup for Basically $0"
description: "You can run a real product on free tiers alone. Here's a stack of free tools for hosting, database, email, and analytics to launch without spending money."
date: "2026-02-12"
updated: "2026-02-12"
category: "Build"
author: "taran"
tags: ["free tier", "build for free", "startup stack", "free hosting", "student startup"]
---

**You can build and run a real, working product for $0 by stacking the free tiers of tools like Vercel (hosting), Supabase (database), Resend (email), and Plausible or PostHog (analytics) — the only thing you truly have to pay for is a domain name, which is about $12 a year.**

If you're 16 with a $40-a-month allowance, "start a company" sounds like it needs a bank loan. It doesn't. A "free tier" is the version of a paid tool that a company gives away for free, up to some usage limit — enough visitors, enough emails, enough database rows. Those limits are almost always way above what a new founder actually uses. You don't have 10,000 users yet. You have zero. So the free tier isn't a compromise. For where you are, it's the whole thing.

Here's which tools to use, where the free limits actually run out, and how to launch without spending money you don't have.

## What does a startup actually need to run?

Strip away the hype and a software product needs four things:

1. A place to put your website or app so people can visit it (**hosting**).
2. A place to store information — user accounts, form submissions, orders (**a database**).
3. A way to send emails automatically, like a "thanks for signing up" message (**transactional email**).
4. A way to see if anyone's actually showing up (**analytics**).

That's it. Everything else — logos, fancy dashboards, a custom domain — is a nice-to-have you can add for free or a few dollars. The four things above each have excellent free tiers, and you can wire them together over a weekend. If you're not writing code at all, you can skip most of this and use a no-code builder; the [best free no-code tools for students](/blog/best-no-code-tools-for-students) guide covers that path.

## The free stack: what to use for each piece

Here's a stack that costs $0 and can handle your first several hundred (often several thousand) users.

| What you need | Free tool to use | What the free tier gives you |
|---|---|---|
| Hosting a site or app | Vercel or Netlify | Unlimited hobby projects, custom domains, HTTPS |
| Hosting a plain website | GitHub Pages or Cloudflare Pages | Free static hosting, no card needed |
| Database + logins | Supabase or Firebase | Real Postgres DB, auth, ~500MB storage |
| Sending emails | Resend | ~3,000 emails/month free |
| Collecting form answers | Tally or Google Forms | Unlimited forms and responses |
| Analytics | Plausible (trial) or PostHog | See visitors, clicks, signups |
| Design and logo | Canva, Figma | Free forever for one person |
| A landing page fast | Carrd | One-page sites free |

Pick one from each row. You don't need all of them. A common beginner stack is Vercel + Supabase + Resend + PostHog, plus Canva for graphics and a domain you actually pay for. That's a complete company for the price of a pizza per year.

If your whole idea is just "will anyone want this," you may not need a database or email at all yet — a free one-page site with a signup form is enough to test demand. That's exactly how a [landing page that converts](/blog/build-landing-page-that-converts) works, and it's the cheapest way to learn something real.

## Do free tiers actually work, or is it a trap?

They work. The catch isn't quality — these are the same tools that real funded startups use. The catch is that free tiers have limits, and you want to know where the wall is *before* you hit it, so a surprise bill never lands on your parents' card.

Here's the honest version of where free tiers usually stop:

- **Hosting (Vercel/Netlify):** Fine until you get real traffic — think tens of thousands of visits a month. You'll know long before it matters.
- **Database (Supabase/Firebase):** Free until roughly 500MB of data or a couple hundred MB of monthly transfer. That's a *lot* of text. You hit it when you have real, active users, which is a good problem.
- **Email (Resend):** ~3,000 emails a month free. If you're emailing more than that, you have an audience, which means you can afford the $20 plan.
- **Analytics:** PostHog's free tier covers a huge number of events. Plausible is a paid tool with a free trial, so if you want free-forever analytics, PostHog or Cloudflare Web Analytics is the move.

Two rules keep you safe. First: **don't put a credit card on file until you have to.** No card, no surprise bill. Second: turn on any "spending limit" or billing alert the tool offers. If you outgrow a free tier, that's a milestone, not an emergency — it means people are using your thing.

## The one thing worth paying for

Spend the $12 on a domain name. A domain is your web address, like `batch0.org`. You *can* launch on a free subdomain like `yourthing.vercel.app`, and that's genuinely fine for testing an idea. But the moment you want people to take you seriously — in a pitch, on a college app, in a DM to a potential customer — `yourthing.com` reads like a real company and `yourthing-final-v2.netlify.app` reads like a school project.

Buy it from Cloudflare or Namecheap (they sell at cost; some registrars lure you with a cheap first year, then triple the price at renewal — read the renewal price, not the intro price). Twelve dollars a year is one dollar a month. If you want a walkthrough, see [how to pick and buy a domain](/blog/how-to-buy-and-set-up-a-domain). Everything else on this page can stay free.

## What about taking payments?

Here's the good news: accepting money is also free to set up. Stripe, the standard tool for taking card payments online, has no monthly fee. It only takes a cut when you actually make a sale — roughly 2.9% plus 30 cents per transaction. So if nobody buys, you pay nothing. If someone pays you $10, you keep about $9.41.

The real wrinkle for you isn't cost, it's age: most payment tools require you to be 18, so you'll likely process payments through a parent's account or a simple business setup. That's a solvable, normal thing — walk through it in [how to accept payments when you're under 18](/blog/how-to-set-up-payments-for-teen-business). And before you build a whole checkout, remember you can charge people *before* you build anything as a test; the [presell method](/blog/presell-before-you-build) lets you collect real money (and real proof people want it) with almost no setup.

## A weekend plan to go from $0 to live

You don't have to do this all at once. Here's an order that works:

1. **Buy your domain** (~$12). Only paid step. Do it first so it's not blocking you later.
2. **Put up a landing page** on Vercel, Netlify, or Carrd — free. One clear headline, what you do, and an email signup box.
3. **Connect a form** (Tally or a Supabase table) so signups actually go somewhere you can see.
4. **Add analytics** (PostHog or Cloudflare) so you know if anyone visited.
5. **Wire up one email** with Resend that auto-replies to signups. Optional for day one.
6. **Share the link** and watch. If people sign up, you've validated something for basically nothing.

If you want to be brutal about it, don't even build the product in step 2 — build the *promise* of it and see who bites. The [fake door test](/blog/fake-door-test-explained) is the cheapest experiment in existence, and it's free.

## The point of building cheap

Building for $0 isn't about being broke. It's about being fast and honest. When your only real cost is $12 a year, you can start, be wrong, kill the idea, and start again without it costing anything but time. That freedom is the real advantage of building young — no salary to cover, no investors to answer to, no reason to cling to an idea that isn't working.

The tools will never be the reason you didn't start. Money won't be the reason. The only thing between you and a live product this weekend is deciding to do it.

If you want people around you while you do it — deadlines, mentors, and a live demo day at the end — that's exactly what batch0 is built for. You build a real company across four one-week sprints, and [applying is free](/apply). Or read more about how the [program](/program) works first.
