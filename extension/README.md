# uisight — live mobile panel

Your editor shows you code. This shows you the app: a phone screen running your
site, next to a desktop one, both live, inside the window you are already in.

And then it measures what a screenshot cannot.

![The uisight panel: a desktop and a phone view of the same page running side by
side, with measured findings listed beside them — contrast ratios to two decimal
places, touch targets under 44px, counted per device](https://raw.githubusercontent.com/sololabstr/uisight/main/docs/assets/live-panel.png)

## Why measure instead of look

A model can see your screenshot. It cannot see that the label is 4.38:1 against
its background when the standard is 4.5, or that the "Continue" button is 38px
tall when a thumb needs 44, or that a floating chat bubble is covering 50% of
the last card in a list. Those are numbers, and guessing at them from an image
is how "looks fine to me" happens.

`Inspect` returns the numbers. It costs about the same as a screenshot and says
something a screenshot cannot.

## What it checks

**Can you read it** — invisible text, WCAG AA contrast failures (alpha-composited
backgrounds, gradient text, `oklab()`/`oklch()` all handled), text below 12px,
text cut off by its own container.

**Can you reach it** — touch targets below 44px, controls painted over by
something else (confirmed with `elementFromPoint`, not geometry), controls
trapped under a fixed bar or the on-screen keyboard, sideways scroll, bars
sitting under the notch or home indicator.

**Does it make sense** — a row of actions where nothing says which is primary,
light patches left in dark mode, two languages on one screen, US date formats,
an error message that names nothing, an irreversible action with no confirmation
step anywhere on the page, a permission asked for before anything explains it.

Every check has a false-alarm test next to its detection test. A tool that cries
wolf on every bottom navigation bar gets ignored, and then its real findings go
unread too.

The same engine runs without the editor, over every device and both themes at
once, and writes a gallery you can scroll through — one card per screen, its own
findings under it:

![A one-shot audit: four cards — iPhone 15 Pro and Pixel 7, each in light and
dark — with the findings for each screen listed underneath, naming the element
and the measurement](https://raw.githubusercontent.com/sololabstr/uisight/main/docs/assets/gallery.png)

```bash
npx uisight https://yourapp.com --theme both
```

## Using it

Click the uisight icon in the activity bar. The panel opens with a phone and a
desktop view of `http://localhost:3000` — change the address in the bar at the
top, or in settings.

- **Click a screen** to tap on that device. The wheel scrolls.
- **📌** turns on region select: drag the problem area and it goes to your AI
  with your note attached, cropped to what you dragged.
- **Inspect** runs the checks and writes the findings to the Output panel.

Commands are in the palette under `uisight:`.

## Working with an AI

The panel is one half. The other is the MCP server, which lets your assistant
drive the same session — navigate, tap, change device, and read measurements as
text instead of guessing from pixels.

```bash
claude mcp add --scope user uisight -- npx -y -p uisight@latest uisight-mcp
```

Tool schemas are sent with every request, so if a session only needs to measure
pages, `UISIGHT_TOOLS=core` cuts that fixed cost from ~1,065 tokens to ~419.

## Requirements

[Node.js](https://nodejs.org) 20 or newer. Nothing else — the extension runs the
published `uisight` package through `npx`, so the engine updates itself and you
never pin a version by accident.

Playwright ships its driver over npm but downloads browsers separately, so the
first run has nothing to drive yet. Started from a terminal, uisight offers to
fetch it (~150 MB, once) and shows the progress; started by the editor, where
there is nobody to answer, it names the command instead:

```bash
npx playwright install chromium        # add webkit for the real iOS Safari engine
```

Working on uisight itself? Point `uisight.toolPath` at your checkout and it runs
that instead.

## Settings

| | |
|---|---|
| `uisight.url` | Address the panel opens at |
| `uisight.device` | `iphone-15`, `iphone-se`, `pixel`, `galaxy`, `ipad` |
| `uisight.theme` | `light` or `dark` |
| `uisight.port` | Panel port (default 5055) |
| `uisight.toolPath` | A local checkout to run instead of the published package |
| `uisight.nodePath` | Full path to `node`, if it is not on PATH |

## Limits, stated plainly

Automated checks cannot see design mistakes. A collided header measures fine. A
layout that is ugly measures fine. That is why the panel exists next to the
numbers — look at it.

On Windows the iPhone profiles use WebKit, which is Safari's engine but not iOS
itself. There is no iOS Simulator outside macOS.

## Source

[github.com/sololabstr/uisight](https://github.com/sololabstr/uisight) · MIT ·
issues and findings welcome, especially a check that fired when it should have
stayed quiet.
