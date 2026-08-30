# Changelog

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
