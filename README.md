# uisight

[![CI](https://github.com/sololabstr/uisight/actions/workflows/ci.yml/badge.svg)](https://github.com/sololabstr/uisight/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/uisight)](https://www.npmjs.com/package/uisight)

**Your AI can already see the screen. It just can't measure it.**

Screenshots make an agent *guess*: "that heading looks a bit faint." uisight makes it **know**:

```diff
- from a screenshot:  "the heading looks a little washed out, maybe adjust the color?"
+ from uisight:       INVISIBLE TEXT 1.04:1 — span.bg-gradient-to-r "your headline"
+                     (text rgba(255,255,255,.5) / bg rgb(247,247,248))
```

One is an impression. The other is a measurement with a selector attached — the agent fixes *that* element instead of hunting for it.

uisight is an [MCP](https://modelcontextprotocol.io) server for **web and responsive UIs** (Claude Code, Cursor, Antigravity, anything that speaks MCP). It runs live mobile + desktop sessions side by side, measures what it finds, and puts you and the agent in front of the exact same screen.

Built by a solo founder who got tired of taking phone screenshots, pasting them into chat, and typing "the button looks broken, can you see it?"

![uisight live panel — desktop and mobile side by side, with per-device inspection findings](docs/assets/live-panel.png)
*The live panel: desktop + mobile sessions of the same site, URL-synced. Inspect runs on every screen; findings come back per device. Your AI sees this exact view through MCP.*

## What makes it different

| | Multi-viewport browsers<br>(Polypane etc.) | Browser tools / computer use<br>(Playwright MCP, agent harnesses) | Native app toolkits<br>(Argent etc.) | **uisight** |
|---|---|---|---|---|
| Measures the UI (`1.14:1`, not "looks low") | ✅ for humans | — | — | ✅ **as text, for the agent** |
| Human + agent share one live session | — | — | — | ✅ |
| Device × theme matrix in one run | ✅ | — | — | ✅ |
| Human pins a bug → agent reads note + frame | — | — | — | ✅ |
| Native iOS/Android apps | — | — | ✅ | — (web only) |

The measurement engine is the heart: instead of your AI burning tokens squinting at screenshots, `inspect` returns findings like

```
[mobile · Pixel 7 · light] https://yourapp.com/
  INVISIBLE TEXT 1.04:1 — span.bg-gradient-to-r "your headline" (text rgba(255,255,255,.5) / bg rgb(247,247,248))
  BUTTON a.text-white "Get Started" → text/background contrast 3.35:1
  touch target below 44px 180x23 — "read the guide"
```

Text findings are cheap, precise, and directly actionable — your AI fixes the exact selector instead of guessing.

## "My agent already does this"

Fair — and partly true. Computer use, browser tools and most agent harnesses can already open a page and take a screenshot. That's the part uisight doesn't try to replace. Three things are still missing:

**1. Looking isn't measuring.** A vision model reading a screenshot cannot tell you a contrast ratio. It can't tell 4.6:1 (fine) from 4.3:1 (fails WCAG AA) — they look identical. It won't notice that a tap target is 41px instead of 44px, or that an element renders identically in light and dark mode because its color is hard-coded. uisight computes these from the live DOM: alpha-composited backgrounds, gradient text, `oklch()` colors and all.

**2. The same price buys far more.** This used to claim a screenshot costs several times what a measurement does. Measured, that is not true: a mobile frame is ~460 tokens and the matching `inspect` result is ~570. `inspect` is not the cheap option — it is the option that says `4.38:1 (threshold 4.5)` where a picture only lets the model guess.

The real saving is a different choice: `uisight <url>` writes a report the model reads once (~800 tokens), while driving the MCP tools screen by screen re-sends the whole conversation at every step. Someone put the problem perfectly under the launch thread: *"it burns some tokens but it manages."* [What it costs](#what-it-costs) has the whole table, because a claim like this one is worth checking.

**3. Nobody's watching with you.** In the usual setup the agent looks at the page alone and reports back. Here you both watch the same live session — you see what it does as it does it, and when *you* spot something, you pin it (📌) with a note and the agent reads your note plus that exact frame. No more describing a bug in words.

Scope note: uisight is for **web and responsive UIs**. For native iOS/Android app control, [Argent](https://github.com/software-mansion/argent) is excellent and does far more than we do there.

## Quickstart

```bash
# one-shot audit: PNGs + gallery + report for iPhone/Pixel/desktop, light+dark
npx uisight https://yourapp.com --theme both

# live panel: mobile + desktop side by side, you browse, AI watches (and vice versa)
npx -y -p uisight uisight-panel http://localhost:3000
```

**First run.** Playwright ships its driver over npm but downloads browsers
separately, so the first run has nothing to drive. In a terminal, uisight offers
to fetch what it needs (Chromium is about 700 MB on disk, once) and shows the download. Where there is
nobody to answer — CI, or a panel an editor or agent host started — it never
asks and never downloads; it names the exact command instead. `UISIGHT_NO_INSTALL=1`
turns the offer off everywhere, and you can always do it yourself:

```bash
npx playwright install chromium        # add webkit for the real iOS Safari engine
```

The one-shot audit produces a device × theme gallery with findings per card:

![uisight gallery — 4 devices × light/dark with findings per card](docs/assets/gallery.png)

### Hook it into your AI (MCP)

```bash
# Claude Code
claude mcp add --scope user uisight -- npx -y -p uisight@latest uisight-mcp
```

For Cursor / Antigravity / other MCP hosts, add to your MCP config:

```json
{ "mcpServers": { "uisight": { "command": "npx", "args": ["-y", "-p", "uisight@latest", "uisight-mcp"] } } }
```

Then just tell your agent: *"look at my app with uisight"*. The panel server starts automatically when needed.

### Claude Desktop (one click)

Download `uisight-<version>.mcpb` from the [latest release](https://github.com/sololabstr/uisight/releases/latest)
and open it. Claude Desktop installs it and asks three things: the page to open,
the tool set (`all` or `core`), and whether to download the browser on first use.
There is no JSON to edit.

The bundle carries the server and its dependencies (about 7 MB). Browsers are not
in it, which is what that third question is about: leave it on and a missing
Chromium is fetched once, on the first tool call, by the Playwright version the
bundle was built with. Build the bundle yourself with `node scripts/build-mcpb.mjs`.

## MCP tools

| Tool | What it does |
|---|---|
| `see_screen` | Returns the current screen as an image — the exact frame the human sees in the panel |
| `inspect` | Runs contrast / touch-target / overflow / theme checks; returns **measured findings as text** |
| `goto` | Navigates all sessions to a URL (localhost included) |
| `tap` / `type_text` / `scroll` | Drives the page — the human watches it happen live |
| `set_device` | Switches device profile (iphone-15, iphone-se, pixel, galaxy, ipad, desktop, laptop) or light/dark theme |
| `status` | Open URL, sessions, recent console/network errors — first stop when hunting a bug |
| `marks` | Reads the notes the human pinned in the panel (📌 note + screenshot at that moment) |

Turkish tool names available with `UISIGHT_LANG=tr` (`ekrani_gor`, `denetle`, ...).

## The panel (human side)

`npx -y -p uisight uisight-panel <url>` opens a browser page at `localhost:5055`:

- **Mobile + desktop side by side**, both live, URL-synced
- Click = tap on that device · wheel = scroll · type after clicking
- Per-pane device switcher, shared light/dark toggle
- **Inspect** button runs the measurement engine on every screen
- **📌 Pin**: type a note, pin it — your AI reads note + screenshot via `marks`. No more "let me describe what I'm seeing."

Works inside VS Code / Antigravity via *Simple Browser: Show* → `http://localhost:5055`.

## What it checks

**Can you read it**

- Invisible text (contrast < 1.6:1) and WCAG AA contrast failures — alpha-composited backgrounds, gradient text, `oklab()`/`oklch()` colors all handled
- Text below 12px, images without alt
- Text cut off by its own container (`line-clamp` and friends are not "clipped" — they are a decision)

**Can you reach it**

- Touch targets below 44px (mobile profiles only; inline text links exempt by width, per WCAG)
- Controls painted over by something else — confirmed with `elementFromPoint`, not geometry, and sampled edge to edge so a floating button covering one end of a wide button is caught
- Controls trapped under a fixed bar, or under the on-screen keyboard (`keyboard-audit` opens the keyboard the way a phone does and re-measures)
- Content clipped by a container with no way to scroll to it — the same box with `overflow-x: auto` is fine, because the content is reachable
- Text sliding behind a control when a row does not wrap
- Horizontal overflow with the offending elements
- Fixed bars sitting under the notch or home indicator — only when the page asked for the full screen (`viewport-fit=cover`) and then never used the inset it got back; without that flag iOS letterboxes the page and nothing can be hidden

**Does it make sense**

- A row of actions where every one looks identical, so nothing says which is primary — quiet on tabs, menus and filter chips, and only fires when mis-clicking costs something (save, delete, send, pay)
- Light patches left behind in dark mode
- Two languages in one screen, and US date formats in a non-US locale
- "0 results" shown while a spinner is still turning — an intermediate state presented as the truth
- An error message that names nothing ("An error occurred.") with no way out beside it
- An irreversible action — delete, remove, delete account — on a page that owns no confirmation step at all; the button is never clicked, because clicking it really deletes
- A permission asked for during load, before the person has done anything that would explain it
- **Theme drift**: elements identical in light *and* dark = likely hard-coded colors
- Console/JS errors and failed network requests per device

Every check has a false-alarm test next to its detection test. That is not politeness: a tool that cries wolf on every bottom navigation bar gets ignored, and then its real findings go unread too.

And the honest limit: automated checks cannot see *design* mistakes — a collided header measures fine. That's why `see_screen` exists and why the report says "eyeball the PNGs."

## Behaviour you cannot see by looking (offline, back)

Two of these cannot be measured from a rendered page: the network has to
actually drop, and the back button has to actually be pressed. Both run as panel
actions, so the audit and the MCP tools share them.

```bash
# through the panel
curl -X POST localhost:5055/action -H 'x-uisight-token: ...' \
     -d '{"type":"offline-audit","session":"mobile"}'
```

**Offline** drops the connection, reloads, and asks what the person is looking
at: an explanation, a retry, a spinner that will never finish, or nothing. The
distinction that keeps it honest is the service worker — a page without one
*cannot* answer offline, so that result is marked `expected` and the audit
filters it out. A page that registers a worker and still shows the browser's
error page is a real finding. The connection is restored in a `finally`, so a
failure never leaves the session stuck offline.

**Back** follows an internal link and presses back, then checks that the address
returned to where it started and that the screen is not empty. Coming back to a
blank page is how "back" turns into "leave the app".

## Behind the login (`uisight-audit`)

Public pages are the half of an app nobody lives in. Of four real bugs a person
found by hand and sent in, three were behind a login and one showed up for a
single role only.

```bash
uisight-audit                        # every configured role, 10 pages each
uisight-audit --roles guide,agency   # only these
uisight-audit --pages 20 --port 5062
```

Accounts live in `~/.uisight/accounts.json`. Sign-in tries three routes: a fixed
`code` (the store-review-account pattern), a `devCode` read straight out of the
app's own OTP response (dev/demo mode — no stored secret at all), or a password
field. Success means *leaving* the login page, not HTTP 200, so a wrong code is
never reported as a win. When the app refuses, its own words are passed through:
"HTTP 429 · too many codes requested" instead of a guess about demo mode.

Roles are switched through the app's own view-as endpoint where it has one, so
one admin account can audit every role. Pages not yet measured under any role go
first, so a second role spends its budget on new ground instead of re-measuring
the same public pages.

## Editor extension

`extension/` is a VS Code / Antigravity extension: the live panel in the side
bar, plus commands for device, theme, address, inspect and "send the screen to
your AI".

Search for `uisight` in the extensions panel of Antigravity, Cursor or
VSCodium — [open-vsx.org/extension/sololabstr/uisight](https://open-vsx.org/extension/sololabstr/uisight).
Node.js is the only requirement: the extension runs the published package
through `npx uisight@latest`, so the engine updates itself and installing once
keeps getting new checks.

To build it from this repo instead:

```bash
cd extension && npx @vscode/vsce package
code --install-extension uisight-*.vsix
```

The extension talks to the panel over HTTP and nothing type-checks that
conversation, so `test/extension.test.mjs` compares the two sides: every action
it sends must be one the server handles, every route must exist, every result
field it renders must be one the engine produces, and every command in the
manifest must be registered. That test exists because the pair drifted once and
failed *silently* — Inspect reported "no findings" on pages full of them.

## What it costs

Someone burned through a plan running this and had no way to see where it went.
So here are measured numbers, not estimates — a Pixel 7 session on a real site,
with an image priced the way Claude prices one (width x height / 750):

| | tokens |
|---|---|
| `uisight <url>` then read `REPORT.md` | **~800, once** |
| `uisight-audit` then read `REPORT.md` | **~150-800, once** |
| MCP `inspect` | ~570 per call |
| MCP `see_screen` | ~260 per call (0.75 scale, the default) |
| MCP `see_screen` with `full` | ~2,000 per call (capped; was ~5,800 uncapped) |
| tool definitions | ~1,065 **per request** |

Three things follow from that table.

**The CLI is the cheap path and it is not close.** `uisight` and `uisight-audit`
write a file; the model reads it once. Driving the MCP tools screen by screen
re-sends the whole conversation on every step, so thirty round trips cost far
more than one report. Reach for the MCP tools when you need to *act* on a page —
tap something, change device, look at a specific state — not to survey an app.

**An image is not paid once.** It stays in the conversation and is re-sent on
every later turn. That is why `inspect` exists and why its output is text: the
same page costs ~570 tokens measured versus ~460 seen, and the measurement says
`4.38:1 (threshold 4.5)` where the picture only lets the model guess. A full-page
capture is now capped (`UISIGHT_MAX_IMAGE_TOKENS`, default 2000) and the response
tells you what it cost and what was left out, instead of quietly spending.

**A screenshot does not need to be full size.** Measured on a real page: the
same mobile screen is 461 tokens at 1.0, 259 at 0.75 and 115 at 0.5 — and cost
falls with the *square* of the scale. At 0.75 it is indistinguishable, small
print included; at 0.5 the layout and every meaningful label still read and only
the smallest legal text goes soft. So 0.75 is the default and `scale` is a
parameter on `see_screen`; pass `1` when small print is the thing you are
looking at, `0.5` for a cheap sweep.

**Tool definitions are a fixed tax on every request.** Nine tools cost ~1,065
tokens whether you call them or not:

```jsonc
// only what a measuring session needs: goto, inspect, see_screen, status
{ "env": { "UISIGHT_TOOLS": "core" } }        // ~419 tokens
{ "env": { "UISIGHT_TOOLS": "goto,inspect" } } // ~211 tokens
```

## Something didn't work?

Please open an issue — even a one-liner. This is a young project and the fastest way it improves is someone saying "I ran it on X and got Y". Screenshots of the panel or the contents of `REPORT.md` help a lot.

Known rough edges, so you can tell a bug from a limitation:

- **Design mistakes are invisible to the engine.** A header that collides with the logo measures perfectly fine. Use `see_screen` and look.
- **Photo backgrounds are skipped.** Contrast over a background image can't be computed from CSS, so those elements are left alone rather than guessed at.
- **Theme drift samples structural elements** (body, header, nav, main, footer, button, a, input, cards/panels/modals/menus) — drift that lives only in body copy won't show up in the light↔dark comparison.
- **iPhone profiles are WebKit, not an iOS Simulator** — very close to Safari, not identical to a device.
- **Internals are still Turkish.** Public surfaces (tools, CLI flags, reports) are English; variable names inside `src/` aren't yet. PRs welcome either way.

## Development

```bash
npm install
npx playwright install chromium
npm test          # runs the inspection engine against fixture pages in a real browser
```

The tests are regression locks: every case in `test/inspect.test.mjs` is something the engine got wrong at least once — a false "clean" verdict, a false alarm, or a measurement that silently skipped a color format.

See [CONTRIBUTING.md](CONTRIBUTING.md) before touching the measurement engine — it explains why the color math cannot be extracted into a module, and what a good bug report looks like.

## Notes & limitations

- iPhone profiles run on real WebKit (Safari's engine) — close to iOS, but not an iOS Simulator.
- Browsers are downloaded once by Playwright on first run (`npx playwright install chromium webkit` if you want to pre-warm).
- Everything runs **locally** — no cloud, no account, your screens never leave your machine.
- As of v0.2 the codebase is English throughout — identifiers, comments, and the panel's HTTP field names. If you were calling the panel API directly, [CHANGELOG.md](CHANGELOG.md) has the rename table.

## License

MIT © [SoloLabs](https://sololabs.com.tr)
