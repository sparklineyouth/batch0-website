---
title: "How to Pick and Buy a Domain for Your Startup"
description: "Your domain is the first thing people judge. Here's how to choose a good name, buy a domain cheaply, and connect it to your site without overpaying."
date: "2026-02-18"
updated: "2026-02-18"
category: "Build"
author: "taran"
tags: ["buy a domain", "domain name", "startup name", "dns setup", "custom domain"]
---

**To buy a domain for your startup, pick a short, easy-to-spell name, check that it's available at a registrar like Namecheap or Cloudflare, buy the `.com` for around $10 to $15 a year, and then point it at your site by changing two DNS settings.** That's the whole thing. The hard part isn't the buying, it's picking a name you won't be embarrassed by in six months and not getting tricked into paying for things you don't need.

Here's how to do all of it without wasting money you don't have.

## What is a domain, actually?

A domain is the address people type to reach your site, like `batch0.org`. Behind the scenes, DNS (Domain Name System, basically the phone book of the internet) translates that address into the numeric server address where your site actually lives.

You don't own a domain forever. You rent it, usually one year at a time, from a company called a **registrar**. Keep paying the yearly fee and it's yours; stop paying and it goes back on the market for someone else to grab. So this isn't a one-time purchase, it's a small recurring cost, like $12 a year.

Two words you'll see constantly:

- **TLD** (top-level domain): the ending. `.com`, `.org`, `.io`, `.app`, `.co`. That's the TLD.
- **DNS records**: the settings that tell the domain where to send visitors. You'll touch these once during setup and probably never again.

## How do I pick a good startup name?

Before you buy anything, you need a name. A good domain name is short, easy to say out loud, and easy to spell after hearing it once. The real test: could you tell a classmate your website at a noisy lunch table and have them type it correctly the first time? If not, it's too clever.

A few rules that will save you pain:

1. **Keep it under about 15 characters.** Shorter is easier to remember, type, and fit on a slide when you [prepare for demo day](/blog/demo-day-preparation-guide).
2. **Avoid hyphens and numbers.** `study-buddy-2.com` sounds fine in your head, but nobody remembers where the dash goes, and "two" versus "2" is a coin flip out loud.
3. **Say it out loud ten times.** If it's a tongue-twister or people keep mishearing it, drop it. Your marketing depends on people repeating your name.
4. **Check it's not already a big brand.** A quick search saves you from building on a name someone will make you change later.
5. **Don't overthink it.** Your name matters way less than your product. Plenty of huge companies have weird names. Pick something decent and move on. If you're still stuck on the name, that usually means you haven't nailed [the problem you're solving](/blog/how-to-find-a-startup-problem-worth-solving) yet.

If your idea is `StudyBuddy`, `studybuddy.com` is almost certainly taken. That's normal. Your options: try a different TLD (`studybuddy.app`), or add a small word (`getstudybuddy.com`, `trystudybuddy.com`, `usestudybuddy.com`). The `get-` and `try-` prefixes are extremely common startup moves and nobody thinks they're weird.

## Which TLD should I get: .com, .io, or something else?

Get the `.com` if you can. It's still the default people assume, and if you say your name out loud, everyone types `.com` automatically. If your `.com` is taken and too expensive, the next best options for a student startup are `.co`, `.app`, or `.org` depending on what you're building.

Here's a quick comparison of what you'll actually run into:

| TLD    | Rough yearly price | Best for                          | Watch out for                                  |
| ------ | ------------------ | --------------------------------- | ---------------------------------------------- |
| `.com` | $10–$15            | Almost everything                 | Good short ones are often taken                |
| `.org` | $10–$15            | Nonprofits, clubs, communities    | People may assume you're a nonprofit           |
| `.co`  | $10–$30            | A `.com` alternative              | Slightly pricier; people sometimes type `.com` |
| `.app` | $12–$20            | Apps and tools                    | Requires HTTPS (usually automatic anyway)      |
| `.io`  | $30–$60            | Tech products (popular startup vibe) | Expensive; renewals can jump higher         |

Avoid cheap-looking ones like `.xyz` or `.site` for a startup you want taken seriously, and be careful with a $1 first-year deal, because the renewal next year can be $30 or more. Always look at the **renewal** price, not just the intro price.

## Step-by-step: how to buy a domain

Once you've got a name, buying it takes about five minutes. Here's the exact flow.

1. **Go to a registrar.** Use [Namecheap](https://www.namecheap.com), [Cloudflare](https://www.cloudflare.com), or [Porkbun](https://porkbun.com). These three sell domains close to cost. Cloudflare in particular sells at wholesale price with no markup.
2. **Search your name.** Type it in and see what's available and for how much. Note the renewal price, not just year one.
3. **Add only the domain to your cart.** Ignore everything else it tries to upsell you (more on that below).
4. **Turn on free WHOIS privacy.** WHOIS is a public directory that would otherwise show your name, address, and email attached to the domain. Reputable registrars include privacy for free, so make sure it's on. As a minor, you especially do not want your home address public.
5. **Enable auto-renew.** Forgetting to renew is the single most common way founders lose a domain they love. Turn it on.
6. **Pay.** A single `.com` should come out to roughly $10–$15 for the year. If your total is way higher, you accidentally added extras. Remove them.

That's it. You now own the domain.

## What add-ons should I skip?

Registrars make most of their money on upsells, and almost none of them are worth it for you right now. Skip these:

- **Premium email hosting.** You can get a professional email address later, and free tools cover you at the start.
- **Paid SSL certificates.** SSL is what puts the padlock and `https://` in the browser. You need it, but your site host (like Vercel, Netlify, or Carrd) gives it to you free and automatically. Never pay for it.
- **Website builders bundled in.** You'll pick your own builder. Don't get locked into theirs.
- **"Site protection" and SEO packages.** Marketing fluff. Ignore.

The only thing you should pay for is the domain itself. Keeping your costs near zero is the whole game early on, and there's a full playbook on [building a startup for basically $0](/blog/free-tiers-to-build-a-startup-for-free) worth reading before you spend anything.

## How do I connect the domain to my website?

Buying the domain doesn't automatically make your site appear there. You have to connect the two, and this is the part that scares people for no reason. It's two settings and it's usually done for you.

Modern hosts make this genuinely easy. If you build your site on Vercel, Netlify, Framer, Carrd, or a [no-code tool](/blog/best-no-code-tools-for-students), the flow is basically the same:

1. In your host's dashboard, find the **"Add domain"** or **"Custom domain"** button and type in the domain you just bought.
2. The host shows you one or two **DNS records** to add, usually an "A record" and a "CNAME record." Think of these as forwarding instructions.
3. Copy those records into your registrar's DNS settings page.
4. Wait. Changes can take anywhere from a few minutes to a few hours to spread across the internet (this delay is called "propagation"). Grab a snack.
5. Visit your domain. When your site loads with a padlock in the address bar, you're done.

Some hosts do it even faster: you point your domain's **nameservers** at the host, and it manages everything for you. Either way, you're not writing code, you're copying and pasting a couple of values. If your host has a "connect domain" wizard, follow it and don't overthink it.

## Do it before you need it

A last piece of advice: buy your domain early, even before your site is finished. Good names get taken, and $12 is cheap insurance to lock in the one you want. Point it at a [landing page that collects emails](/blog/build-landing-page-that-converts) while you build the real thing, so the moment you're ready to tell people about your company, the address already works.

Picking and buying a domain is one of the smallest, cheapest steps in starting a company, and it's one of the first things that makes your startup feel real. At [batch0](/program), students go from an idea to a live company across four one-week sprints, and getting your own domain is usually the moment it clicks that this is actually happening. If you're ready to build something real with a team that pushes you, [apply here](/apply). Applying is free, and you only pay if you get in.
