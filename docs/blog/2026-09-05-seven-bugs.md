---
title: "I pointed my UI-auditing tool at three sites it had never seen. All seven bugs it found were its own."
published: false
tags: testing, webdev, mcp, showdev
---

The line at the bottom of the report said:

```
Records with automated findings: 8/4
```

Eight out of four. More screens with findings than screens.

I wrote this tool. It measures web UIs — contrast ratios against the real composited background, touch targets under 44px, controls that something else is painting over, text clipped by its own container. It has 142 tests. Every one of them passed while it printed that number.

Here is what was underneath it, and what the exercise taught me about the kind of bug tests are structurally bad at catching.

## The counter was counting the wrong noun

The fix took two minutes: the counter incremented once per finding *type* while its label said *records*. Two problems on one screen counted twice.

The interesting part was one line below. The report also prints `automated checks clean` when a screen has nothing wrong — and that decision was made by a **completely separate list**:

```js
const anyFinding = d.horizontalOverflow || d.smallTargets?.length || d.tinyText?.length
  || d.invisibleText?.length || d.lowContrast?.length || d.buttonIssues?.length
  || k.console.length || k.network.length
  || d.coveredControls?.length || d.clippedText?.length || d.coveredByFixed?.length;
```

A hand-maintained list of what counts as a finding. The engine had grown past it. So a screen whose only problem was one of the newer checks would print the finding — and then, directly underneath, say it was clean.

Both come from one flag now, set by every branch that actually prints something. It cannot drift, because there is nothing left to drift from.

## Then the same shape, three more times

Once you have seen it, you start finding it.

**The touch-target check built its own label.** There is a `shortLabel(el)` function whose whole job is "what text does a person read here". The touch-target check did not call it; it carried its own copy of the same idea, written earlier. That is why a `select` element came back with newlines inside its label while every other finding had them collapsed.

**The contrast rule had its own icon-font list.** So did the label code. The contrast one knew about `lucide` and `feather`; the label one knew about class names like `material-symbols-outlined`. Each missed exactly what the other caught.

That last one produced my favourite finding of the round. Two of the three apps reported button labels like this:

```
button 71x34 — "add Şarkı"
button 36x34 — "light_mode"
```

Icon fonts put the icon's *name* in the text node and draw a glyph over it. So `innerText` reads what nobody sees, and half the label's 45 characters go to something invisible. Labels skip icon elements now and keep the words around them — and for an icon-only button, where there is nothing left to read, they fall back to the accessible name. The theme toggle went from `light_mode` to `Tema değiştir`. The report ended up more useful than it was before the bug existed.

## Why 142 tests caught none of it

Every one of these is a bug in the *relationship between two pieces of code that agree with themselves*. The counter agreed with itself. The `anyFinding` list agreed with itself. Both label builders were individually correct.

A unit test asks "does this function do what it says". None of these functions lied. What was wrong was that there were two of them.

What caught them was running the tool on something it had not seen. Not more tests — *use*. Three sites, an hour, seven defects, all mine.

The tests I added afterwards have a different shape from the ones I had. They do not test functions; they compare two sides of the program against each other. One reads the finding types the engine produces and fails if any consumer does not print them. One reads the `npx` commands out of every doc and refuses any that names a bin instead of a package — because the README's headline command, `npx -y uisight-mcp`, had never worked. `uisight-mcp` is a bin *inside* the `uisight` package, not a package of its own. Every new user hit a 404 on step one.

That one had a second edge, worth saying out loud. The docs pointed at a name nobody owned on npm, so whoever published it would have got code execution on the machine of anyone following our own instructions. Fixing the text does not retire that, because the instruction lives in the git history and in every published tarball's README. The three names are taken now.

## The half a person found

I could not have found the rest by running anything. Someone opened the panel and said the mobile screen looked wrong.

It did. Frames are captured below 1:1 to keep their token cost down, and the card filled whatever width the side bar had. A 412px capture was being drawn at 792px. The blur is the lesser problem: **a 44px touch target looks like 110px there**. The one view whose entire purpose is judging a phone layout was quietly lying about it.

Then: "the refresh button reopens the old site." I had put a refresh glyph on the panel switcher, a few pixels above the panel's own refresh button, which reloads the page. Two identical controls, different actions — the exact thing this tool flags on other people's interfaces.

Then: "there is nowhere to choose." I had hidden the switcher when only one panel was running — *a single panel needs no chooser* — and the only way to notice a second panel was the rescan button, which lived on the bar that appeared only once a rescan had already found something. Someone who started a second panel could not reach it at all.

That is twice in one day that I hid a control to keep things tidy and removed the only way back along with it. It is a written rule now rather than something I trust myself to remember: **before hiding a control, ask how you return to that state without it.**

## The other thing worth measuring

This tool exists so an AI agent can measure a page instead of guessing from a screenshot, which makes its own token cost part of the product.

An image costs roughly `width × height / 750` tokens, and it is not paid once — it stays in the conversation and is re-sent on every later turn. So the cost falls with the *square* of the scale. Cutting a frame to 0.75 costs about 44% of the tokens, and I compared four scales by eye before picking one, because "still readable" is not a thing you can assert from a number.

Tool schemas are the other fixed cost: they go out with every request whether the tools get called or not. Measured while writing this: the full set is 9 tools at about 1,050 tokens; `UISIGHT_TOOLS=core` is 4 tools at about 470. For a session that only needs to measure pages, that is more than half of a cost you pay on every single turn.

## Three things I would tell myself in the morning

**A passing test is not evidence the product is right.** It is evidence that one function matches one expectation. The bugs that survive live between things.

**Use it on something you did not write.** An hour on three unfamiliar sites found more than the previous day of writing tests. The unfamiliar part is load-bearing: on my own pages I unconsciously avoid the paths that break.

**When you write the same idea twice, one copy will rot.** Every duplication I found had been correct on the day it was written. That is what makes it hard — you are not looking for a mistake, you are looking for an agreement that has since become a disagreement.

---

The tool is [uisight](https://github.com/sololabstr/uisight) — MIT, runs entirely locally, no account, nothing leaves your machine. It is a CLI, a live panel you and your agent watch together, and an MCP server so the agent can read measurements as text instead of guessing from pixels.

If you try it and a check fires when it should have stayed quiet, that is the report I want most. A tool that cries wolf on every bottom navigation bar gets ignored — and then its real findings go unread too.
