---
title: Our product screenshots were 3× too small, and we could prove it
description: One of our six product images was rendering the app's own 13px interface text at 4.7 effective pixels. Here is the ratio that catches it, what the sites that get this right actually do instead, and the check that now fails the build.
pubDate: 2026-08-04
pillar: performance
format: field-notes
seoTarget: product screenshot resolution website
wiki:
  - git-worktree-per-agent
---

We had six product screenshots on the front page. They were captured from the
real application, at 2× density, converted to WebP, and every one of them was
sharp. Five of the six were also unreadable, and the number that shows it is not
a resolution.

## Two ratios, and only one of them was being watched

**Oversample** is asset pixels ÷ rendered CSS pixels. It is the one everybody
knows: capture at 2×, serve at 1×, get a crisp image on a retina display.

**Content scale** is rendered CSS pixels ÷ *logical* CSS pixels: the width the
application actually laid itself out at before the capture doubled it. It is the
one nobody watches, and it is the one that decides whether the picture can be
read.

They come apart the moment you photograph something wide and put it in a narrow
column. A screenshot can be perfectly sharp and completely illegible at the same
time: sharpness is about the pixels, legibility is about how big the *type* ends
up.

<div class="callout callout--measured">
<span class="callout-label">Measured on our own site</span>
Our dashboard image was captured from an app laid out at 1582 logical pixels and
served into a 569-pixel slot. Content scale 0.36. The application's own 13px
interface text was arriving at <strong>4.7 effective pixels</strong>.
</div>

Running the same calculation across all six:

| Image | Logical width | Rendered | Content scale |
|---|---|---|---|
| Dashboard | 1582 | 569 | **0.36** |
| Window, three projects | 1240 | 569 | 0.57 |
| Board | 792 | 505 | 0.64 |
| Phone | 390 | 272 | 0.70 |
| Terminal | 594 | 505 | 0.85 |
| Model picker | 348 | 341 | 0.98 |

Only the last one was fine. And it was fine by accident. It is a popover, so it
was small to begin with.

## What the sites that get this right do

We measured a set of references the same way, in a headless browser at 1440×900,
reading computed styles rather than eyeballing.

Val.town uses real screenshots and serves them at 2560 → 1280: exactly 2.00×
oversample, content scale 1.00. Never below one.

Cursor, Anthropic and Devin do something else entirely: **they do not
photograph the product at all.** The interface in their hero is live DOM. Cursor's
is 1080×620 with 250 elements and 89 text nodes, 55 of them at 13.5px or below,
and zero images. Anthropic's is 1372×772 with 112 text nodes at 12.5px. Devin's
has 73 text nodes and all 73 are ≤13px. Real text, at real sizes, in the page.

That is not a stylistic preference. It is the only way to show a dense interface
at an arbitrary width without either shrinking it or cropping it.

## The rule that falls out

You cannot photograph a 1240px-wide window and show it 570px wide. There are
exactly two ways out, and picking one is unavoidable:

1. **The page renders it bigger**: a full-bleed slab instead of a column.
2. **The subject is smaller**: one pane, one card, one popover.

Which is the interesting part, because option 2 is also the answer to a
completely different complaint: *the pictures show too much and I do not know
where to look*. The geometry problem and the "one feature per picture" problem
have the same solution. Once we stopped photographing the dashboard pane and
started photographing only the row of numbers the sentence was about, the image
got both smaller and clearer, and it dropped from 60 KB to 20 KB on the way.

## The check

A rule that lives in someone's head lasts until the next redesign. Ours is now a
band, enforced in the capture script:

```
content scale (rendered ÷ logical), band 0.90–1.10
  organize   0.91  2.19×  1240 logical → 1132 rendered   ok
  own        0.98  2.05×   348 logical →  340 rendered   ok
  ship       0.99  2.03×   650 logical →  640 rendered   ok
  see        0.99  2.01×   644 logical →  640 rendered   ok
  run        1.00  2.00×   641 logical →  640 rendered   ok
  reach      1.00  2.00×   390 logical →  390 rendered   ok
```

A band rather than a floor, because the failure is symmetric. We first shipped a
floor of 0.90 and immediately produced the opposite defect: a card captured at
326 logical pixels and served at 640 has a content scale of 1.97 and an
oversample of **1.02×**: the asset is being stretched, and it looks soft no
matter how sharp the capture was. Both edges of the band say the same thing.
Capture the subject at the width the page will serve it at.

## Method

Content scale is `rendered CSS width ÷ (asset width ÷ capture device pixel
ratio)`. Our own figures come from the capture script, which knows both numbers
directly. Reference sites were measured on 4 August 2026 in headless Chromium at
a 1440×900 viewport, reading `getBoundingClientRect()` and `naturalWidth` from
the live pages, and element and text-node counts from the DOM.

## Limits

Single measurement per site, one viewport, one day, and a responsive layout can put
the same image at a different width on a different screen, and we did not sweep
breakpoints. Reference sites change without notice, so the specific numbers above
are a snapshot rather than a standing fact. And the rule is about legibility
only: it says nothing about whether the picture was worth taking.
