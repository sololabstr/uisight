# Contributing

Issues are the most useful thing you can send. A page where uisight reported nothing but you can
see something wrong is worth more than a feature request — a wrong "clean" verdict is the failure
mode this tool has to avoid, and every one of them so far came from a real page.

## Reporting a bad result

Open an issue with the URL (or a minimal HTML file), what you expected, and what uisight said. If
the page is private, a reduced snippet that still reproduces it is enough. The three blind spots
found this way so far, all now covered by tests:

- text inside a `<div>` was skipped because the selector was a fixed tag list;
- gradient backgrounds were ignored, which made contrast look *better* than it really was;
- Tailwind v4 emits `oklab()`, and an `rgb`-only parser silently missed every one of them.

## Running it locally

```bash
git clone https://github.com/sololabstr/uisight
cd uisight
npm install
npx playwright install chromium        # add `webkit` for the real iOS Safari engine
npm test                               # 13 tests, ~2s
node src/cli.mjs https://example.com --device iphone-se,desktop --theme both
```

`npm test` runs `node --check` on all three entry points first, then drives the real inspection
engine in a real browser.

## Working on the measurement engine

The engine lives in `INSPECTION_SCRIPT` in [src/cli.mjs](src/cli.mjs). Playwright serializes that
function and ships it into the page, so it **cannot close over anything outside itself** — the
color math cannot be pulled into a module without duplicating it, and a duplicate would drift
from the code that actually runs. That is why the tests exercise the real function in a real
browser instead of unit-testing an extracted copy.

If you change a threshold, an exclusion, or the selector scope, add a test that fails without your
change. Both directions matter: a missed finding and a false alarm are equally bugs, and the
false-alarm side is what makes people stop trusting the tool.

Everything in `src/` and `test/` is written in English — identifiers, comments, and wire-format
field names (see [CHANGELOG.md](CHANGELOG.md) for the 0.2.0 migration).

## Pull requests

Small and self-contained, with a short note on how you verified it. CI runs the syntax gate, the
tests, a pack dry-run, the version-sync gate (`package.json` and `server.json` must agree, and
`mcpName` must match `server.json`'s name), and a CLI smoke run. If you bump the version, bump it
in both files.
