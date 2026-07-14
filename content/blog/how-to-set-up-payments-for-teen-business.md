---
title: "How to Accept Payments When You're Under 18"
description: "Stripe, PayPal, and most processors require 18+. Here's how a teen founder can actually collect money for a product using a parent, an LLC, or a workaround."
date: "2026-02-08"
updated: "2026-02-08"
category: "Build"
author: "taran"
tags: ["accept payments", "stripe under 18", "collect money", "teen business", "payment processor"]
---

**If you're under 18, the fastest legal way to accept payments is to have a parent or guardian open the payment account (Stripe, PayPal, or Shopify) in their name with their tax info, and route the money to a bank account they control or a joint account with your name on it.** Almost every major payment processor requires account holders to be 18+, so the account is technically theirs, the product and the work are yours, and you get paid. That's the whole trick. The rest of this post is how to do it cleanly so nobody gets a nasty surprise from a bank or the IRS.

## Why can't you just sign up for Stripe yourself?

Payment processors need the account holder to be able to sign a legally binding contract. In the U.S., minors generally can't be held to contracts the same way adults can, so Stripe, PayPal, and Square set their terms of service to 18+. It's not that they think you can't run a business. It's that their lawyers don't want to enforce an agreement against a 16-year-old.

If you lie about your age and sign up anyway, the account works fine right up until you hit a payout threshold or a fraud check. Then they ask for ID, the birth date doesn't match, and they freeze the balance. Don't build your revenue on an account that can vanish. Do it the boring, durable way.

## The four real ways to accept payments under 18

Here are your actual options, ranked roughly by how fast you can start.

| Method | How fast | Cost | Best for |
|---|---|---|---|
| Parent's payment account | Same day | Free (2.9% + 30¢ per charge) | Your first sales, testing demand |
| Joint bank account + parent-held processor | A few days | Free to open | Recurring income you both watch |
| Family LLC with you as a member | 1–2 weeks | $50–$500 to form | Real ongoing business, taxes, credibility |
| Marketplace platform (Gumroad, Etsy, Ko-fi) | Same day | 5–10% per sale | Selling a digital product or template |

Most founders start with option one and only move up when the money justifies the paperwork. You do not need an LLC to sell your first $500 of anything. If you're weighing that decision, [we wrote a whole piece on whether you actually need an LLC as a teen](/blog/do-you-need-an-llc-as-a-teen), and the short version is: usually not yet.

## The step-by-step setup with a parent

This is the path 90% of Sparkline founders take, and it takes about 20 minutes.

1. **Have the conversation first.** Your parent is going to be the legal owner of this account, and their name and Social Security number go on it. That means any income technically flows through them until you formalize things. If money and your startup are a touchy subject at home, [read our guide on talking to your parents about your startup](/blog/talking-to-parents-about-your-startup) before you spring a tax form on them.
2. **Pick one processor.** For selling directly from your own website, use Stripe. For sending someone a quick payment link or invoice, use PayPal. For a physical product with a storefront, use Shopify (which uses Stripe under the hood). Don't sign up for all three. One.
3. **Open the account in your parent's name.** Use their legal name, birth date, and SSN or ITIN. This is the account holder. You can be added as a team member or "employee" in Stripe's dashboard so you can see transactions and issue refunds without needing their login every time.
4. **Connect a bank account they control.** Ideally a joint account with both your names, so you can actually see the deposits and move money. A parent-only account works too, but a joint account keeps things honest and visible.
5. **Add your product and a payment link.** In Stripe you can create a Payment Link in two clicks with no code. Paste it on your landing page, in a DM, wherever. If you don't have a landing page yet, [here's how to build one that actually converts](/blog/build-landing-page-that-converts).
6. **Do a $1 test.** Buy your own product with a real card, confirm the money lands in the connected bank account, then refund yourself. Never launch a payment flow you haven't tested end to end.

That's it. You're accepting money.

## What about a joint bank account or a debit card?

A joint bank account is a checking account with two owners, and most banks will open one for a minor as young as 13 or 14 as long as a parent is the co-owner. This is the piece that turns "my mom's PayPal" into "money I can actually access." When a payout hits the account, you can see it and spend it with your own debit card.

Getting the banking side right matters more than people think, because a frozen or mismatched account is where teen founders lose money. We go deep on the accounts, cards, and paperwork in [our guide to handling money when you're under 18](/blog/how-to-open-a-business-bank-account-as-a-minor). Read that alongside this one.

One thing to sort out early: whose income is this? If your parent's name is on the processor, the IRS sees the income as theirs unless you formalize a business structure that names you. For small amounts this usually doesn't matter, but once you're clearing real money you'll want to understand [how taxes work on teen business income](/blog/do-you-pay-taxes-on-teen-business-income) so nobody's surprised in April.

## When should you form an LLC instead?

Skip the LLC until the money and the risk are real. Forming one costs money, adds a tax filing, and takes a week or two. But at some point a parent's personal PayPal stops being enough. Here's the honest threshold:

- You're making a few hundred dollars a month, consistently, and it's not stopping.
- Customers are asking for invoices to a business name, not a person.
- You're taking on any liability (you're handling other people's data, money, or physical products that could hurt someone).
- You want a business bank account and a clean paper trail separate from your parent's finances.

An LLC can have a minor as a member with a parent as the manager, which gives you a legitimate business entity that names you. That's the version that looks real on a college application and lets you open a business account. Before you spend a dollar forming one, sanity-check the actual numbers in [how much money you need to start a business in high school](/blog/how-much-money-to-start-a-business-in-high-school) — most of the time the answer is "less than you think, and not this yet."

## The fastest zero-setup option: sell on a platform

If all you want is to sell a digital product — a Notion template, a study guide, a design pack, a small app — you can skip payment processors entirely. Platforms like Gumroad, Ko-fi, Lemon Squeezy, and Etsy handle the payments for you and pay out to your (or your parent's) bank account. They take a bigger cut, usually 5–10%, but you're live in an afternoon with zero contracts to sign yourself.

This is genuinely the smart move for a first product because it removes the payment problem entirely and lets you focus on whether anyone will buy. If you're not even sure people will pay yet, don't build the storefront — [get people to pay before you build anything](/blog/presell-before-you-build) and validate demand first. A pre-order collected through a simple Gumroad link is worth more than a perfect Stripe setup with no customers.

## A quick reality check before you charge anyone

Accepting payments is a solved problem. The hard part was never the checkout button — it's having something people actually want to buy. If you're spending your energy on payment processors before you've confirmed demand, you're optimizing the wrong thing. Nail the product and the customer first, then wire up the money in an afternoon.

At [Sparkline](/program), that's exactly the order we run it: over four one-week sprints — Validate, Build, Market, Pitch — you figure out what to build and who wants it before you ever worry about a checkout page. Applying is free, and we only charge tuition if you're accepted, so you can [apply here](/apply) without spending a cent to find out. Get the demand right, and setting up payments becomes the easy part.
