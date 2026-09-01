# Blog SEO

135 posts, six categories. The writing and the structured data were already
solid — every post ships `BlogPosting` + `BreadcrumbList` JSON-LD, real
`datePublished`/`dateModified`, a per-post OG image, and an answer-first
opening paragraph. What was broken was everything around the writing.

## What was wrong

### 1. Titles were truncated on 58 of 135 posts

Every post rendered `` `${title} — batch0` ``. Google renders about 600px of
title, roughly 60 characters, then cuts. 58 posts were over.

The irony: the truncation ate the suffix. The posts that "needed" the branding
most were exactly the ones where it never appeared — and several lost words
from the headline too. `How to Convince Skeptical Parents to Let You Join a
Startup Program — batch0` is 76 characters; a searcher saw about two thirds
of it.

### 2. Descriptions were truncated on 49 of 135 posts

Between 156 and 177 characters against a ~155 budget. Every one of them was
cut mid-sentence in the search result. The blog index was worse at 186.

### 3. Only 18% of posts received any internal link

`getRelatedPosts` was "same category first, then most recent, take 3". With
20–24 posts per category that means every post in a category linked to the
same three recent siblings.

Measured across the real catalogue: **24 of 135 posts (18%) received at least
one "Keep reading" link.** The other 111 were internal-link orphans, reachable
only from the flat index. Nine separate pitch-deck guides sat in the same
category without a single link between them.

Internal links are the one ranking lever entirely inside our control. This
threw it away.

### 4. No topic clusters

135 posts in one flat list gives Google one blog URL and 135 leaves, with
nothing in between saying "these twenty-two pages are all about pitching".

## What changed

### Conditional brand suffix

`blogTitleTag` (`lib/seo-meta.ts`) appends `— batch0` only when it fits in 60
characters. Dropping it costs nothing: the site ships a `WebSite` node with
`name: "batch0"`, and Google derives the displayed site name from that, not
from the title tag.

That alone fixed 46 posts. The remaining 12, whose headline is over budget on
its own, got a `seoTitle` frontmatter override — the `<h1>` keeps the long,
specific headline, the title tag gets a short one. They serve different
readers and there's no reason to force them to match.

### 49 descriptions rewritten

The keyword head is intact in every case; the cut always came from the filler
tail ("Here's how…"). All 135 now fit.

### Related posts scored by actual topical overlap

`pickRelated` weights shared tags (×10), shared title terms (×3), and same
category (×1).

Title terms matter more than they look: 45 of 135 posts share no tag with any
other post, so tags alone would leave a third of the catalogue orphaned.

**Result: 18% → 83% of posts now receive at least one internal link.**

The links are also relevant now. For *How to Make a Pitch Deck in Canva*:

| | Related posts |
| --- | --- |
| Before | demo-day-preparation-guide, how-to-answer-investor-questions, storytelling-for-pitches |
| After | how-many-slides-in-a-pitch-deck, how-to-write-pitch-deck-high-school-competition, pitch-deck-slide-order-that-works |

Ties break on slug rather than date, so publishing a new post can't silently
rewire the internal link graph of fifty older ones.

### Six category hub pages

`/blog/category/{validate,build,market,pitch,founders,playbook}`, statically
generated, each with `CollectionPage` + `ItemList` + `BreadcrumbList` schema.

They create the missing middle layer of the site architecture:

- the blog index links **down** to all six hubs
- each hub links **across** to the other five and **down** to its posts
- every post's breadcrumb links **up** to its hub, in both the visible
  breadcrumb and the JSON-LD

Hubs sit at priority 0.7 in the sitemap, above individual posts (0.6): the hub
is the URL we want competing for the broad head term, with posts underneath
competing for the long tail. Each hub's `lastModified` tracks the newest post
inside it, so crawlers revisit when the cluster actually changes.

## Guardrails

```bash
npm test              # 31 assertions, node --test, no dependencies
npm run seo-doctor    # section 4 audits all 135 posts
```

The doctor fails on any post over the title or description budget, fails if
any category is missing hub copy or its copy is over budget, and reports the
internal-link reachability percentage — failing if it ever drops back below
50%.

## When you add a post

1. Keep `title` under ~50 characters, or add a `seoTitle` under 50.
2. Keep `description` under 155 characters.
3. Reuse existing tags where they genuinely apply. Tags are the strongest
   relatedness signal, and a wholly unique tag set means the post only
   connects through its title.
4. Run `npm run seo-doctor`.

## The honest ceiling

None of this beats a high-authority site on a competitive head term.
batch0.org is a young domain with few referring domains; for a query like
"business ideas for high school students" the first page is Forbes and
Shopify, and no amount of on-page work changes that this quarter.

What this work does: stops losing clicks on queries we already rank for
(truncated titles and descriptions are pure CTR loss), and gives Google a
coherent site structure to understand and distribute authority through as
that authority arrives. The remaining lever is off-page — links and mentions,
not code.
