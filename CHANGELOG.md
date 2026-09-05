# Changelog

## 0.29.0 — 2026-09-05

The side bar shows both screens again.

Yesterday's narrow mode hid the desktop session, because ~300px cannot hold two
screens side by side and a 1440px view squeezed next to a phone was unreadable.
The reasoning was sound and the conclusion was wrong: "the phone and the desktop
together" is what this tool is for, and hiding one takes half of it away from
the one place people keep glancing at. Reported by someone who noticed it had
gone.

What does not fit side by side fits stacked. Desktop on top at 284px, phone
below, no horizontal overflow — measured in a 300px viewport, not assumed. The
text in the small view is not readable and does not need to be: what you are
looking for there is whether the layout broke, and reading is what Inspect is
for.

### Also in this release

The panel's action token no longer sits on `window`.

From an outside contribution (PR #1, an automated scanner). Its premise was
wrong: putting a token in the page it authorizes is not XSS, and the token's job
is to stop a site you happen to be visiting from driving your browser session —
it travels in a custom header a cross-origin caller cannot send, and cannot read
back either, because the panel sends no CORS headers. None of that needs the
token hidden from its own page.

The narrower point underneath was fair, though, and its patch did not go far
enough: moving the value to a top-level `const` leaves it readable by name from
any other script in the page. It lives in a closure now, so nothing else can
reach it under any name. Checked in a browser rather than by reading: the global
is `undefined`, the identifier is unreachable, the panel's buttons still work,
and a request without the header still gets 403.

## 0.28.0 — 2026-09-05

It fetches the browser itself now, if you say yes.

Playwright's npm package has no install hook, so a fresh `npx uisight` arrives
with a driver and nothing to drive. 0.27.0 made the message about that exact and
readable; this removes the wall for anyone who would rather not read it. In a
terminal the first run asks — naming the size and that it happens once — and
Playwright's own progress is shown rather than swallowed, because a download this
long with no output looks like a hang.

The interesting half is where it does **not** ask. The panel and the MCP server
are normally started by an editor or an agent host with no terminal attached, and
a question nobody can see is indistinguishable from a hang; CI is worse, since a
150 MB download nobody asked for is somebody's bill. So the offer requires a real
stdin and stdout, and stands down on `CI` or `UISIGHT_NO_INSTALL=1` — there it
falls back to naming the command, which is what it did before. The tests are
mostly about that negative: what must not happen, where.

The install command is resolved out of the Playwright that is actually installed
rather than assembled from a guessed path, so it works the same under `npx`,
where Playwright is hoisted beside uisight instead of nested under it.

## 0.27.0 — 2026-09-05

Installing the published package and using it as a stranger found four things.

**A fresh install has no browser, and the advice for fixing that was wrong.**
Playwright's npm package carries no install hook, so `npx -y uisight <url>`
downloads the driver and nothing to drive. The message that explains this named
`npx playwright install chromium` — unpinned. Playwright ties each release to
one browser build, and this machine, with three chromium builds already on it,
still reported none: the floating `^1.62.0` had moved to 1.63.0, which wants a
fourth. The command is pinned to the version actually in use now, and it prints
on its own instead of underneath a stack trace.

**A target the panel could not parse left it half-alive.** `about:blank` became
`http://about:blank`, and that string was carried all the way into `/state`,
where it threw. The panel still served its HTML — so it looked fine in a browser
— while the endpoint that discovery, `uisight-audit` and the MCP tools all read
was killing the socket. As far as anything else was concerned, no panel was
running. Targets are checked at the door now, in their own module so the rule
can be tested without launching a browser: the first version of it refused
`localhost:3000`, which is how most people start this, and a test caught that
before it shipped.

**A throw in any handler dropped the connection with no reply.** One endpoint
failing should not read to every caller as "nothing is running there". Handlers
answer 500 now.

**`--help` reached the four commands** (0.26.0) after this same exercise showed
three of them ignoring it.

## 0.26.0 — 2026-09-05

The command in the README did not work.

`uisight-mcp`, `uisight-panel` and `uisight-audit` are bin names inside the
`uisight` package, not packages. So the headline instruction for registering the
MCP server — `npx -y uisight-mcp` — failed with E404 for every new reader, and
so did the panel and audit lines, in both languages, and the Smithery start
command. Only the extension's own README had it right. Both forms were run
against the live registry to be sure: the documented one 404s, `npx -y -p
uisight uisight-mcp` starts the server.

That is also a supply-chain trap. The docs sent people to a name nobody owned,
so whoever published `uisight-mcp` would have run code on the machine of anyone
following them — and the instruction is in the git history and in every
published tarball's README, so fixing the text does not retire it. The three
names are now taken by four-line packages that depend on `uisight` and hand off
to it, which closes the hole and makes the short form work as it always read.

Along the way: `--help` did nothing on three of the four commands. It fell
through to the argument parser, so `uisight-audit --help` began a real sign-in
against whatever panel was on port 5055 and `uisight-panel --help` launched a
browser. And `uisight --help` exited 1 — asking for help is not a failure, but
any script checking the status saw one.

Tests read the commands out of the docs and refuse any that names a bin instead
of a package, and run every bin's `--help`.

## 0.25.0 — 2026-09-05

A switcher above the panel, so several projects can be watched from one side bar.

Discovery landed the panel on *a* running session; picking a different one meant
a trip to the command palette. Auditing four projects at once, that is the
difference between a side bar you use and one you glance at. The bar lists every
running panel by port and page, switches on selection, and rescans on demand. It
only appears when there is more than one — a single panel needs no chooser.

It belongs to the frame rather than the panel content: the extension already
discovers the sessions and owns the iframe. Port mapping now covers every
discovered panel, not just the selected one, or switching would land on a blank
frame.

Rendered outside VS Code and looked at, it had two faults of the kind this tool
exists to catch. The colours were nailed down, so in a light-themed editor the
bar would sit as a dark slab above the panel; it reads `--vscode-*` now, with
the old values as fallbacks. And `flex:1` stretched the chooser across the full
width of an editor tab for a twenty-character label, so it is sized to its
content instead. Three tests run the bar rather than grepping it.

## 0.24.0 — 2026-09-05

The side panel was watching a port nobody was using.

Per-project ports fixed four agents fighting over one panel, and quietly broke
the other half of the idea: the human watching what the agent does. The port is
derived from a folder, so it only lines up when the agent and the editor are in
the *same* folder. Working from one repo while measuring another — which is most
of the time — leaves the side bar staring at an empty port. Five panels were
running and the extension was watching a sixth.

It discovers them now instead of guessing: a scan of 5055-5174 takes 29ms and
found all five. One panel, it attaches. Several, it asks. None, it starts one.
`uisight: Attach to a running panel` switches at any time.

Two of the coverage tests had to be narrowed with it. They scanned the whole
extension file for `d.<field>` reads, so `d.sessions` in the discovery code
looked like a finding type the engine had failed to produce. The check belongs
to the inspect renderer, not the file.

## 0.23.0 — 2026-09-05

`see_screen` could hand the model a picture 25 seconds old.

The panel keeps the last screencast frame because reusing it is free. But
Chromium only sends frames when something repaints, so once a page settles the
cached frame just ages — measured at 25 seconds on an idle page. If the view had
changed without a frame arriving, the model got the old picture while `inspect`
read the live DOM. The two disagree, and the disagreement reads as "the layout
broke". Reported from a session auditing a different app.

It did not reproduce on demand here — the screencast kept up through navigation
and scrolling — but the mechanism is structural and the consequence is an agent
drawing a confident conclusion from a stale image. A fresh capture costs 35ms,
measured, so the frame's age now decides: cached while the screencast keeps up,
re-captured when it does not. `x-frame-age` says which happened.

## 0.22.0 — 2026-09-05

Running the audit behind a real login found three things, and two were mine.

**`demoButton` works in production.** The route added yesterday for apps that let
you in with one click was never tried on a real app. It signs in and the audit
walks six pages behind the wall, no credentials involved.

**"No button matching" meant "already signed in".** When a session is already
authenticated most apps redirect `/login` to the app, so the sign-in never
reaches the page it is looking for — and then blames the button. Every route now
notices it arrived somewhere else and says so, which is the correct outcome
rather than a failure.

**The scroll gate was in one check and not its sibling.** A field report named
both `coveredControls` and `coveredByFixed`; only the second one got the fix.
So a production app reported a "Modules" row as 100% covered by the bottom nav
while the page had 1,715px left to scroll. Fixed — and the first attempt failed
because the fixed element is the `<nav>`, not the link inside it that
`elementFromPoint` returns: checking the coverer's own position left the gate
silently inert, passing its synthetic test while the real page still reported.

**The report multiplied one finding into five.** Behaviour checks run once per
role but the report looped over page rows, so a single offline finding appeared
once per page. The same inflation bug fixed in the engine yesterday was sitting
in the report writer.

## 0.21.1 — 2026-09-05

Re-running the audit found that an earlier fix had exempted the wrong side.

Next.js puts its dev-tools button in a `<nextjs-portal>`, and it was covering a
real link on two pages. 0.19.0 was supposed to have handled that — but it skipped
targets that sit *inside* a dev overlay, not dev overlays doing the covering. The
finding survived, the changelog said it was fixed, and nothing would have caught
it except running the audit again.

Behind the login on the same app, the same pages: 45 findings down to 34 on the
home page, 23 to 15 on a profile, 14 to 9 on search. The two surviving COVERED
findings were both this false alarm; the findings section of the report is now
empty of them.

## 0.21.0 — 2026-09-04

**A flag that would have been a placebo, and the real cause underneath it.**

A field report asked for `--concurrency 1` after parallel contexts locked a local
server twice. Reading the code first: there is no parallelism in the CLI at all —
device, theme and path loops are all sequential, no `Promise.all` anywhere. The
flag would have changed nothing, and everyone would have believed it helped.

Measured instead: **a single page load fires 20 requests at once.** That is the
browser's own connection pool, not this tool. A backend with a small pool — Prisma
`connection_limit=1`, for instance — queues all twenty on one connection and
stalls. `--max-requests <n>` caps them: measured 20 down to 4 concurrent, at a
cost of 3.8s to 4.0s.

**A regression test that can actually fail.** The listener bug now has a
behavioural test: a real server whose three pages each log exactly one error,
expecting `[1, 1, 1]`. A structural test — does the loop call `page.off` — can
pass while the behaviour stays broken. Verified by putting the bug back: it fails
with `got [3,2,1] — listeners are accumulating`, and goes green when the fix
returns. A regression test that cannot fail is worth nothing.

Writing it taught its own lesson: `execFileSync` blocks the test process's event
loop, and the server being measured lives in that process, so the CLI waited
forever for a reply that could not be sent. Cost: one 180-second timeout.

## 0.20.1 — 2026-09-04

The new text-behind-a-control check produced a finding the first time it ran on a
real page: a cookie banner sitting over a pricing card. The screenshot settled it
— pressing "only essential" reveals everything. The text is one tap away, not
lost.

The distinction is deliberate. That same banner covering a *control* is a real
bug, because the user cannot reach the control; a banner covering the login
button was one of the four real defects found this week. So `coveredControls`
keeps no such exemption. This one is only about text.

## 0.20.0 — 2026-09-04

Three checks the field reports asked for, and one of them took two attempts.

**Content clipped with no way to scroll to it.** The leaf-text check skips
anything with children, so the real defect one level up was invisible: a
six-column table inside an `overflow-hidden` box showed three columns on a phone
and the rest did not exist. Three pages had the pattern and the engine found
none; a person spotted it in a screenshot. The discriminator is clean — the same
box with `overflow-x: auto` is fine, because the content is reachable.

The first version used `scrollWidth`, passed its tests, and then produced four
false alarms on the first real page: 2,193px "hidden" caused by absolutely
positioned animated background blobs, and a marquee whose child scrolls into view
by design. `scrollWidth` is the wrong measure. The question is whether an
in-flow, text-bearing child extends past the box — nothing else is lost
information. Zero false alarms across four real sites now, with the detection
test still passing.

**"Empty" shown while the data is still loading.** One page said TOTAL 0 with 45
documents in the database; another showed "0 items" and "0 / 0 shown" while a
spinner turned, over a library of 5,055 records. For a moment the user is told
the database is empty. Both on screen at once means what is displayed is an
intermediate state, not the truth.

**Text disappearing behind a control.** A gap between two existing checks: one
looks for covered controls, the other only at fixed bars. A `justify-between` row
that did not wrap put a description paragraph under an upload button — nothing
fixed, no control covered, nobody saw it. Narrow gates, because a false alarm is
cheap to create here: two of three sample points, and the thing on top has to be
a control. A decorative layer over text is usually deliberate; a button is not.

## 0.19.0 — 2026-09-04

A fourth field report, which independently confirmed the listener bug with a
cleaner signature — a page logging exactly one warning came back as `5, 4, 3, 2,
1` — and then found something worse.

**The keyboard check told a working fix that it had failed.** The right way to
stop a sticky bar disappearing behind the keyboard is
`interactive-widget=resizes-content` in the viewport meta: the layout viewport
shrinks and the bar rides above the keyboard. Applied, verified by hand at 100%
visible — and the tool returned the same finding with the same number, because it
measures against a band and never read the meta. The person nearly reverted a
correct fix. A tool that says "your fix did not work" is worse than one that
finds nothing.

**A stale dev server lies, and nothing catches it by name.** `next dev` served
old CSS after the file changed on disk, so an already-fixed contrast measured as
broken and half an hour went into fixing it twice. The chunk filename was
identical in both states. Inspections now carry a build identity, and when a
second inspection finds no change on a byte-identical page it says so: if you
changed something, the server is stale. That matters most for the diff mode from
0.15.0, where "nothing changed" is a plausible-looking wrong answer.

**A flow sibling cannot cover anything.** Four 26px buttons in a row: sampling
columns at 3% of the width landed 0.78px from the shared edge and sub-pixel
layout made `elementFromPoint` return the neighbour — 3 of 15 samples, reported
as "20% covered". All four were tapped by hand and worked. Solved by rule rather
than by tuning: a static, unstacked, untransformed sibling cannot be painted on
top. The sampling inset is also floored at 2 CSS pixels.

**A decorative mockup is not an interface.** A phone mockup on a landing page
contained a fake bottom nav built from real buttons, counted as sub-44px targets
on every device, every theme, every run — 4 to 8 findings per page, all of them
a picture. Targets under `aria-hidden`, `inert`, or a `pointer-events: none`
chain are now skipped, which is also the right advice for the mockup.

Smaller: dev overlays are excluded everywhere rather than in two checks;
`accounts.json` reports which entry matched, because `localhost:3000` is shared
by every project and a fixed code left there silently breaks another project's
sign-in; a rate-limited login now says when to try again.

## 0.18.0 — 2026-09-04

A third field report, and the worst bug of the three days: **this tool was
inflating its own numbers.**

Event listeners were attached inside the per-path loop and never removed. Each
one closed over its own record, so loading page N fired N listeners and wrote the
same event into every earlier record. Twelve pages with two real errors each came
back as `22, 20, 18 … 2` — a perfect descending staircase. The first page looked
eleven times worse than it was, and nothing about the output looked wrong, which
is why it survived. Fixed, removed in a `finally` so a page that throws cannot
leak one either, and pinned by tests that read the loop structure rather than the
output, because every number in that output was plausible.

**A path Git Bash rewrote was scanned as a URL.** MSYS turns a bare `/` inside
`--path "/,/gbf"` into `C:/Program Files/Git`; the tool made a screenshot called
`C-Program-Files-Git__pixel__dark.png` and **never scanned the home page**,
silently. It now says so and names `MSYS_NO_PATHCONV=1`.

**Development overlays are not part of the application.** Next.js's dev button
was reported as covering a control. It does not exist in production.

**Disabled buttons: the check only looked at opacity.** One app moved the
background from zinc-900 to zinc-200, set the text to zinc-600, added
`cursor: not-allowed` and an explanatory `title` — and the finding stayed. A
check that cannot see a fix discourages the fix. Cursor, title, and a real
background difference from an enabled sibling all count now.

**`--timeout`.** The fixed 30s budget wasted an entire run: a heavy Next.js app's
first compile exceeded it and all 72 screens came back empty with TimeoutError.

## 0.17.0 — 2026-09-04

Two field reports, from agents auditing two different applications. Six real
bugs in this tool, and the most useful one is a false alarm that made up an
entire audit's noise.

**A bottom bar is not covering content the user can scroll past.** All 17
findings of that kind in one run were the same case: a 96px bottom padding
against a 56px bar, so scrolling to the end put the content above it — the chips
were tapped by hand on a device and worked. The gate is now per element and
precise: flow content on a page with room left to scroll is skipped, while an
element that is itself fixed stays reported, because scrolling never saves that
one. The old test for this modelled the false alarm rather than the real case;
it does both now.

**`offline-audit` measured before the service worker took control.** A worker is
installed on first visit but does not control that page — `controller` is null
until a reload. So every PWA came back "blank offline" and a genuinely broken
worker looked identical to a healthy one. Someone fixed their worker and the
tool kept saying blank. It now reloads and waits for control first.

**`confirm()` is a confirmation.** Four inline delete buttons were reported as
having no confirmation step; all four sat behind `if (confirm('...'))`. Clicking
to find out really deletes, so the handler source is read instead.

**Emoji are not text.** A ⚖️ paints itself and ignores the CSS `color` the
contrast was computed from. Icon fonts were already exempt; emoji are the same
problem in different clothes.

**A tab is not a button that forgot its background.** The "no background and no
border" rule fired on every correctly built tab bar.

**A wrapped inline link's bounding box is a lie.** It spans both lines and the
gap between them — space neither line paints — so a "Terms of Use" link read as
13% covered by its neighbour. Line fragments are measured instead.

**Two silent failures in this tool's own API.** `deviceSettings()` returned an
empty object for an unknown name, and Playwright reads that as "no device": a
caller who wrote `prof.playwright` instead of `prof.pw` measured twelve pages at
1280x720 believing they were mobile, with no warning at all. It throws now, and
`profileSettings('iphone-15')` takes a profile key so nobody has to know the
field name. Separately, `uisight --version` was treated as a URL and started
scanning `https://--version`; unknown flags are refused rather than guessed at.

## 0.16.0 — 2026-09-04

Colours are reported as hex, which is shorter and also more honest.

A contrast finding used to carry the raw computed value:
`oklab(0.999994 0.0000455677 0.0000200868 / 0.8)`. Forty-six characters that no
one can read, re-sent on every later turn of the conversation. It now says
`#ffffff 80%`.

The honesty half matters more. The contrast ratio was always computed from the
sRGB value the browser resolves that colour to — so printing the raw `oklab()`
showed a number that was not the one measured. Hex is what the maths used.

And it names the thing you actually change: `#cf4709 on #fbf1ee` is recognisably
a brand token failing on a light surface. `rgb(207, 71, 9)` made you translate;
`oklab(...)` made you give up.

### A negative result worth recording

Filtering `inspect` by severity was measured across four real pages and dropped.
Of 83 findings: 10% blocking, **87% standard** (AA contrast, 44px targets, tiny
text, clipping), 4% advisory. Returning "blocking only" would hide nine tenths of
what the tool is for, and dropping "advisory" saves 4%. The bulk is the middle
tier and the middle tier is the point, so there is nothing to filter.

## 0.15.0 — 2026-09-04

The second measurement of a page now reports only what changed.

The fix-measure loop is the main way this tool gets used, and the second
inspection was re-sending everything that had not moved — text that is then
re-sent again on every later turn of the conversation. Measured on a real page:
422 tokens down to 44 when nothing changed. Over six rounds of fixing, 8,673
tokens becomes 3,378.

The saving is the smaller half of it. After a fix the question is not "what is
on this page" but "did my fix work", and a diff answers that one directly:
CLOSED, NEW, and a count of what is still open. `full: true` brings back the
whole list whenever it is wanted.

`fingerprint`/`fingerprints` live in their own module because `mcp.mjs` is an
entry point — importing it starts the server and blocks, so a helper left in
there cannot be tested, and an untested helper is one that breaks quietly. The
risk here is a fingerprint that is too specific: include something that wiggles
between runs and every finding looks new every time, so the diff becomes a full
report that also claims things were fixed and re-broken. Seven tests hold it.

## 0.14.0 — 2026-09-04

Both of these came from an agent auditing a different application, which is
exactly where a tool's blind spots are supposed to surface.

**A consent banner defeated sign-in, and lied about why.** The overlay ate the
submit click; Playwright reported nothing useful; the failure surfaced three
steps later as "no code field found" — a wrong diagnosis pointing at a field
that was fine. Banners are now dismissed before the form is touched, and a
swallowed click says so instead of failing silently downstream.

The dangerous half is the fix itself: clicking things that say "Kabul" can
navigate away and lose the login page entirely, which is far worse than leaving
a banner up. So a navigation is walked back, and the helper only touches
short labels inside a fixed or sticky container.

**Route 0: a door with no lock.** Some apps let you in with one click — "browse
the demo without signing up" — and all three credential routes assume
credentials exist, so auditing an app built that way had to be scripted by hand.
`demoButton` in the recipe covers it. Recipe-driven on purpose: a tool that
picks its own button will one day pick "Delete everything" because it happened
to say "Devam".

Six tests for a file that had none.

## 0.13.0 — 2026-09-04

Four agents auditing four applications were all talking to one panel.

Everything defaulted to port 5055, and `ensureEngine` attached to whatever
answered there without asking which application it was serving. So an agent
auditing one app could measure another one's page, and a `goto` from any of them
yanked everyone else's panel to its own address. Nothing failed. It just answered
about the wrong app — found by someone noticing the side panel was empty for all
four, not by anything going red.

Two fixes, because one is not enough. The port is now derived from the working
directory: every project gets its own, the same project always gets the same one,
and no configuration is involved. And if a panel on that port is serving a
different host, the tool says so instead of measuring it. The extension derives
the port the same way from the workspace folder — the constants are written out
in both files so a test can compare them, since two implementations that drift
put the side panel on a different application than the agent is measuring.

**Findings are grouped by cause, not listed by symptom.** Measured: 12 contrast
findings on one page came from 7 colour pairs, six of them the same pair — one
CSS variable, reported six times. Grouping is both shorter and truer, because the
fix was always one token, never six elements.

**The button check no longer repeats the touch-target check.** It reported
`size 23x36 (<44px)` for elements `smallTargets` had already counted, so a page
with 12 real problems read as 20. Same elements, two lists, one of them removed.

Together these take a real page's `inspect` from ~573 tokens to ~413 — and every
tool result is re-sent on every later turn, so that discount compounds.

## 0.12.0 — 2026-09-04

Frames are 44% cheaper, and the reason is measurement rather than a hunch.

The same mobile screen, captured four ways and then actually looked at: 461
tokens at full size, 259 at 0.75, 166 at 0.6, 115 at 0.5. At 0.75 it is
indistinguishable — small print included. At 0.5 the layout and every meaningful
label still read; only the smallest legal text goes soft. Cost falls with the
*square* of the scale, so half the size is a quarter the price.

0.75 is now the default. `scale` is a parameter on `see_screen` (and
`UISIGHT_FRAME_SCALE` on the server): pass `1` when small print is the thing you
are looking at, `0.5` for a cheap sweep.

Scaling happens in CDP's own capture, so there is no image library to install and
no JavaScript run inside the page being inspected. Without CDP it falls back to
full size rather than failing.

This also corrects a comment in the code that claimed downscaling "would make the
text unreadable, which defeats the point of looking." That was never measured. It
is wrong.

## 0.11.1 — 2026-09-04

Documentation, and one claim in it that was not true.

The pitch said a mobile screenshot costs "roughly 1,500 tokens" against "a few
hundred" for a measurement. Measured: 460 and 570. `inspect` is not the cheap
option — it is the option that says `4.38:1 (threshold 4.5)` where a picture only
lets the model guess, and the real saving is running the CLI once instead of
driving the tools screen by screen. A tool whose whole argument is "measure it
instead of guessing" cannot leave an unmeasured number in its own README.

Screenshots regenerated. The old ones were from 20 August and showed a Turkish
`Git` button, a session labelled `mobil`, and an inspection panel with two badges
in it — an advertisement for a thinner tool than the one that exists.

The Turkish summary had not been touched since 30 August and described none of
it: sign-in and roles, the keyboard, the notch, offline and back, the extension.
It does now.

## 0.11.0 — 2026-09-04

The update notice was written for the wrong reader.

stderr is right for a terminal, where a person is watching. Under MCP it is
exactly wrong: the client files server stderr into a log, so the model never
sees it — and the model is the one who could actually fix it. An assistant that
does not know an update exists cannot offer to install it.

`status` now carries the news where the model reads it, and carries the fix with
it, including the step that fails silently when skipped: updating the package
does not restart the server already running, so the old one keeps answering
while everyone believes it was updated.

The stderr line stays for CLI runs. Neither one ever touches stdout, which
belongs to JSON-RPC — a test starts the real server, asks for `status`, and
proves every stdout line is still a JSON-RPC message.

## 0.10.0 — 2026-09-04

Everything shipped since 0.1.4 is invisible to the person still running 0.1.4.
npm installs a version and then never mentions it again, so the people most
likely to hit a bug that is already fixed are exactly the ones who cannot find
out.

**A version check that says one line and gets out of the way.** Once a day,
cached on disk, 2s timeout, silent on any failure, off with `NO_UPDATE_NOTIFIER=1`
and off in CI. Nothing is sent anywhere — it is the same public GET `npm view`
makes.

It writes to **stderr**, and that is the whole risk: the MCP server speaks
JSON-RPC over stdout, where one stray line corrupts the stream and the tool dies
looking like nothing at all. So a test starts the real server with a notice
guaranteed to fire and proves stdout stayed pure JSON — the notice must actually
appear on stderr, or the test proves nothing.

Version comparison is numeric, because as strings `"0.9.0" > "0.10.0"` and every
user on 0.10 would be told to downgrade.

## 0.9.0 — 2026-09-04

Someone ran this and watched their plan drain with no way to see where it went.
So the cost was measured rather than guessed, and the three places it actually
hides were closed.

**A full-page capture had no ceiling.** A 10,500px page is ~5,800 tokens and a
20,000px one is ~11,000 — and an image is not paid once, it stays in the
conversation and is re-sent on every later turn. The height is now capped
(`UISIGHT_MAX_IMAGE_TOKENS`, default 2000) rather than downscaled, because
shrinking a page until the text is unreadable defeats the point of looking. The
response says what it cost and what was left out: `~2000 tokens (412x3640) ·
showing the top 3640/10508px`.

**Tool definitions are a fixed tax on every request, not a one-off.** Nine tools
cost ~1,065 tokens whether or not you call them. `UISIGHT_TOOLS=core` keeps the
four a measuring session needs (~419); an explicit list goes lower (~211). Names
stay English even under `UISIGHT_LANG=tr`, so a config file does not change
meaning with the language.

**The cheap path is the CLI, and the README now says so with numbers.** `uisight`
and `uisight-audit` write a report the model reads once (~150-800 tokens);
driving the MCP tools screen by screen re-sends the whole conversation at every
step. The MCP tools are for acting on a page, not for surveying an app.

Nothing here changes what is measured — `inspect` was already returning text and
excluding the theme baseline, which is where 80% of that response would otherwise
have gone.

## 0.8.0 — 2026-09-04

The five checks that were still on the list, three of them measurable from the
page and two that are not.

**Errors that say nothing.** "An error occurred." leaves one option: try again
and hope. Quiet when the message names the problem, and quiet when a retry sits
next to it.

**Irreversible actions with nothing in the way.** The delete button is never
clicked — clicking it really deletes. What is measured is whether the page owns
any confirmation machinery at all: a dialog, a modal, or the button saying it
opens one. None of it means the loss is one tap away.

**Permissions asked for before there is a reason to say yes.** Hooks installed
before page code, calling the real API through, recording whether anything the
person did preceded the request. A load-time request has no context by
definition.

**Offline** (`offline-audit`) and **back** (`back-audit`) are panel actions,
because neither can be measured by looking at a page — the network has to drop
and the button has to be pressed. Offline distinguishes an app that cannot
answer (no service worker: marked `expected`, filtered out of the audit) from
one that registers a worker and still shows the browser's error page. Verified
in both directions on a real app: a finding on the dev server, silence on
production, where the worker serves a cached page.

**The Turkish text this tool exists to read does not look like its patterns.**
The error check was written as `olustu` and the screen says `oluştu`, so it
matched nothing. Text is folded to ASCII before matching now. A check that
cannot read its own audience's alphabet is worse than no check.

**`setContent` does not run init scripts**, so the permission hook was never
installed under test and every permission test passed by measuring nothing. The
tests that need a hook in place now navigate for real.

> Note: `uisight@0.7.0` on npm was published from a working tree mid-edit and
> carries three of these checks in an untested state. Everything in it passes its
> tests as of 0.8.0; prefer 0.8.0.

## 0.7.0 — 2026-09-04

A check nobody displays is a check that does not exist.

**Four checks were measured on every page and printed on none of them.** The CLI
report enumerated ten finding types; the engine produced fifteen. Nothing failed
— REPORT.md was simply shorter than the truth, which is the hardest kind of bug
to notice, because a short report is exactly what you hope to see. All of them
now appear, and three tests read the engine's own result initialiser and fail if
any consumer — report, editor extension, audit summary — leaves a type out. That
gate found a fifth gap on its first run: the extension had never shown `tinyText`.

**Notch / home indicator** (`unsafeArea`). The gate is what keeps it quiet:
without `viewport-fit=cover` iOS letterboxes the page and every inset is 0, so
nothing can be hidden. The finding only exists when a page asked for the full
screen and then never used the padding it got back — the PWA/TWA mistake exactly.

**"Two languages on one screen" was firing on 1% noise.** A real page had 591
Turkish markers against 7 English ones, all of them a carousel's "next" label.
The minority language now has to hold a meaningful share and appear as more than
one distinct word. The half-translated screen the check exists for still fires.

## 0.6.0 — 2026-09-04

One copy of the code, and three failures that were silent rather than loud.

**`uisight-audit`** walks every configured role and writes a report per page.
Pages not yet measured under any role go first, so a second role spends its
budget on new ground — that one change took a run from "6 pages, 4 of them
already measured" to four guide pages nobody had looked at, which is where two
covered controls and a keyboard finding turned up.

**The extension was talking to a server that no longer existed.** It called
`/act` with `{tip}` and read `d.dusukKontrast`; the panel had moved to `/action`
with `{type}` and English keys, and later started requiring a CSRF token. None
of that threw. The commands did nothing and Inspect said "no findings" on pages
full of them. Fixed, and `test/extension.test.mjs` now compares the two sides so
the next rename fails in CI instead of in front of a person.

**"No primary action" was firing on bottom navigation.** Tabs, menus and filter
chips are *supposed* to look alike. The check now skips navigation containers
and links that lead to different pages, and only fires when the group contains
an action that costs something to get wrong — save, delete, send, pay. Three
false alarms on one real app went to zero without losing the real case.

**Blocked ports are named.** `fetch()` refuses the ports the URL spec marks
unsafe, and the only clue is "bad port", which reads like a bug in this tool.
5060/5061 sit next to the default 5055 and are an easy accident — worse, a panel
bound to one is unreachable from a browser too. Now it says which port and
suggests another.

**Narrow mode for the side bar** (`?narrow=1`). The extension had been asking for
`?dar=1`, a flag the server stopped reading during the English migration, so the
side panel quietly opened the two-column desktop layout in a 300px strip — the
one thing narrow mode exists to prevent.

The `mobil-qa` fork is retired; nothing was lost (its 10 checks and 16 panel
actions all have an equivalent here) and the reason it had to go is the
extension bug above: two copies drift, and drift between a tool and its caller
is silent.

## 0.5.0 — 2026-09-04

The audit can now get past the sign-in wall, and it can see the keyboard.

**Sign-in** (`login.mjs`, `login` / `role` / `links` actions). Of four real bugs a
person found by hand, three were behind a login the crawler never passed. Three
routes are tried: a `code` in the recipe, a `devCode` returned by the app's own
OTP response, or a password field. The second is the good one — an app in demo
mode is audited with no stored secret at all.

Success means LEAVING the login page. "HTTP 200" would call a wrong code a win.

**Roles without extra accounts.** Some apps let an admin view the system as
another role; `switchRole` uses that mechanism instead of asking you to keep one
login per role. What a guide sees is not what an agency sees, and crawling with
one identity leaves half the app unaudited.

**Keyboard** (`keyboard`, `keyboard-audit`). Chromium's device emulation has no
soft keyboard: focusing a field changes nothing, so "the field ended up behind
the keyboard" was structurally invisible. Both behaviours were checked against a
real device (Pixel 7 / API 35), and they need different models:

- a focused field — Chrome scrolls it above the keyboard, so it is **not** a bug.
- a fixed bottom bar — stays pinned to the layout bottom and disappears. Shrinking
  the viewport moves it up and hides the bug, so it is measured against a band.

A floating chat button behind the keyboard is not reported: nearly every app has
one and it blocks nothing. A wide action bar or a submit is.

## 0.3.3 — 2026-09-04

**A round button is not covered by what shows through its corners.** A circle
inside a 56x56 box leaves about 21% of the box unpainted, and sampling those
corners returns whatever is behind. A floating chat button sitting *over* body
text was reported as 27% *covered by* that text — on four pages, in two roles.
Sampling now stays inside the inscribed ellipse for pill and circle shapes.

This one is worth naming because the finding was real and the direction was
backwards: the button did overlap the text. A check that describes a real
problem incorrectly still costs trust.

## 0.3.2 — 2026-09-04

**Truncated lists no longer hide the count.** Detail lists are capped so a bad
page does not flood the report — but printing the capped length as if it were the
total made the tool lie about how bad a page is. A site with 33 contrast failures
reported "12"; you fixed twelve, re-ran, saw "12" again, and nothing looked like it
had changed. That happened to the author, on a real page, while verifying a fix.

Every capped list now reports `shown / total` (`12 / 33`). The cap stays; the count
is honest.

## 0.3.1 — 2026-09-04

The three checks from 0.3.0, run against 14 live sites, produced 36 findings.
Verifying them one by one left **3**. The other 33 were four distinct kinds of
false alarm, and each one is now a test:

- **A modal covering the page beneath it** is what a modal is for. Exempting only
  the scrim was not enough — the dialog's own content box then took its place as
  the reported cover, so the rule walks ancestors and exempts anything inside a
  near-full-viewport overlay or an explicit `role="dialog"`.
- **`line-clamp` is deliberate truncation**, the same as `text-overflow: ellipsis`.
  17 of 18 "clipped text" findings were line-clamped recipe, quote and product
  cards.
- **Geometry alone lies.** A fixed element can overlap a box and still sit *behind*
  it. One site's floating button geometrically covered a cookie banner's buttons
  while rendering behind it, perfectly readable. `coveredByFixed` now asks
  `elementFromPoint` what is actually on top, the way `coveredControls` already did.

What survived is worth having: a cookie banner covering a hero headline, so every
first-time visitor sees the product's main promise hidden.

A check that fires on correct behaviour is a check people learn to ignore, so the
false-alarm tests matter more here than the detection ones.

## 0.3.0 — 2026-09-04

Three new checks, all of them things a person spots in a screenshot in one second
and no amount of contrast or size measurement can see.

- **`coveredControls`** — a control with something sitting on top of it: a floating
  action button parked on the corner of the primary CTA, a toast over "Save". The
  first version of this check sampled only the element's centre and was blind to
  exactly that case; it now samples a grid edge to edge, and the test that proves
  it is the real bug, not a hypothetical.
- **`coveredByFixed`** — text and buttons hidden behind a fixed or sticky bar. A
  header that scrolls over its own content reads as "half the sentence is missing".
- **`clippedText`** — text cut off by its own box. A deliberate `text-overflow:
  ellipsis` is not reported; a scroll container is not reported.

Six tests cover them, three for the defect and three for the false alarm — the
false-alarm half matters more, because a check people stop trusting is worse than
no check.

The "automated checks clean" line in both the report and the MCP summary now
accounts for these three. It is the same trap as before: a new check that the
clean-claim does not know about makes the tool print "clean" under its own findings.

## 0.2.1 — 2026-08-31

Three cold-start defects, all of them things a first-time user would hit and none of
them things an existing user would report:

- **A missing browser now tells you what to run.** npm installs Playwright's driver but
  not the browsers it drives, so the first `npx uisight` on a clean machine died on a raw
  Playwright stack trace. It now says `npx playwright install chromium` and explains why.
  The README says it too, as step one.
- **No locale is forced any more.** `locale: 'tr-TR'` was hard-coded in both the CLI and
  the panel, so every user in the world audited their app in Turkish — language switchers,
  date formats and all. The page now renders the way your machine would render it, and
  `--locale en-US` (or `UISIGHT_LOCALE`) pins one when you want a fixed baseline.
- **Report timestamps are locale-neutral** (ISO + UTC) instead of Turkish-formatted.

Two leftover Turkish strings in CLI output are gone, and the missing-browser path is
covered by a test.

## 0.2.0 — 2026-08-30

**Breaking.** The internals were written in Turkish (this started as a personal tool). Everything
is English now: identifiers, comments, HTTP endpoints and JSON field names. If you only use the
CLI, the MCP tools, or the panel, nothing changes — the CLI flags, the nine MCP tool names, and
the report format are all the same. If you called the panel's HTTP API directly, read on.

### Panel HTTP API (breaking)

| Before | Now |
| --- | --- |
| `POST /eylem` | `POST /action` |
| `GET /akis` (SSE) | `GET /stream` |
| `GET /kare` | `GET /frame` |
| `GET /durum` | `GET /state` |
| `GET /isaretler` | `GET /marks` |
| `{ tip: 'git' \| 'tikla' \| 'kaydir' \| 'tus' \| 'geri' \| 'ileri' \| 'yenile' \| 'denetle' \| 'kaydet' }` | `{ type: 'goto' \| 'click' \| 'scroll' \| 'press' \| 'back' \| 'forward' \| 'reload' \| 'inspect' \| 'save' }` |
| `?tam=1`, `?temizle=1` | `?full=1`, `?clear=1` |

### Inspection result fields (breaking)

`sel` replaces `secici` in every finding; `border` replaces `kenar` in theme-signature entries;
records carry `console` / `network` instead of `konsol` / `ag`, and a failed request reports
`status` instead of `kod`. The wire format is otherwise unchanged, and the measurements are
byte-identical — verified against a captured baseline before and after the migration.

### Also in this release

- `UISIGHT_FALLBACK=1` is the documented name for forcing the fallback frame stream
  (`MOBILQA_YEDEK=1` still works).
- The report no longer prints `Rapor :` in Turkish; it says `Gallery:` and `Report :`.

## 0.1.4 — 2026-08-20

- 13 regression tests that drive the real inspection engine in a real Chromium, plus GitHub
  Actions CI (syntax gate, tests, pack dry-run, version-sync gate, CLI smoke).
- README repositioned around the one thing that is hard to copy: your agent can already see a
  screenshot, but it cannot measure contrast, touch targets, or theme drift from one.

## 0.1.3 — 2026-08-19

Security hardening for the panel server, all four found by audit and each verified with a live
request before and after the fix:

- The server binds `127.0.0.1` only (it used to bind every interface, so anyone on the same
  network could drive the browser session).
- A per-run token, written to `~/.uisight/live/token-<port>` and required as a header on
  mutating endpoints (CSRF).
- A Host allowlist on every endpoint (DNS rebinding).
- A 1 MB request-body cap, and panel findings are HTML-escaped before they reach the page.

## 0.1.0 — 2026-08-18

First public release: CLI audits across device profiles and themes, the live panel with shared
human+AI sessions and the 📌 mark channel, and the MCP server with nine tools.
