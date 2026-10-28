# WebSyncTERM

A browser-based, faithful clone of **SyncTERM** — the BBS terminal from
[Synchronet](https://github.com/SynchronetBBS/sbbs) — plus a self-hostable,
ftelnet-style gateway that any BBS sysop can embed on their site.

```
┌──────────────┐   WebSocket    ┌────────────┐   Telnet/SSH/RLogin   ┌────────┐
│  web app     │ ─────────────► │  gateway   │ ────────────────────► │  BBS   │
│  embed page  │ ◄───────────── │  (Node.js) │ ◄──────────────────── │        │
└──────────────┘                └────────────┘                      └────────┘
```

* **Browser side** — a pure-TypeScript re-implementation of the CTerm terminal
  engine (ANSI-BBS/ECMA-48 plus the SyncTERM extensions), the SyncTERM font
  and palette sets, sixel graphics, RIPscrip 1.54, ANSI music, X/Y/ZMODEM
  transfers and the full key map.
* **Gateway side** — a small Fastify + `ws` service that proxies a browser
  session to a Telnet, Telnets, SSH, RLogin or raw-TCP BBS, with SSRF
  protection, an optional host allowlist, rate limiting and idle timeouts.

---

## Quick start

```bash
pnpm install
pnpm dev
```

* Web app: <http://localhost:5173>
* Embed app: <http://localhost:5174>
* Gateway: <http://localhost:8023>

The development gateway runs **wide open** — no host allowlist, and private
addresses are permitted — so that any BBS on the internet can be dialled while
testing:

```
GATEWAY_ALLOW_PRIVATE=1
GATEWAY_ALLOWLIST=            # empty = open directory
```

To restrict it again while developing, set the allowlist in the environment:

```bash
GATEWAY_ALLOWLIST=bbs.example.com pnpm dev
```

**Neither of these settings belongs in production.** A deployed gateway must
keep an allowlist and the SSRF protection on; see
[the gateway section](#running-the-gateway).

### Trying it without a real BBS

A mock BBS is included:

```bash
pnpm mock-bbs        # listens on 127.0.0.1:18099 and emits some ANSI
```

Then open <http://localhost:5173>, click **Add**, and enter:

| Field | Value |
|---|---|
| Name | Mock BBS |
| Address | `127.0.0.1` |
| Port | `18099` |

Click **Save**, then **Connect**. The screen should fill with
`Welcome to the mock BBS` in green and `Blue on yellow` on a blue background.

### Dialling a real BBS

The same flow works for any public BBS. For example, `telehack.com` on port
23:

| Field | Value |
|---|---|
| Name | Telehack |
| Address | `telehack.com` |
| Port | `23` |

If the connection fails, the reason is shown both in the red banner and in the
status bar at the bottom of the window.

The embed page does the same thing with a URL:
<http://localhost:5174/?bbs=127.0.0.1:18099&proto=telnet>.

Build and run everything in containers:

```bash
docker compose up --build
```

The gateway is then reachable at `ws://localhost:8023/ws`. See
[`deploy/nginx/websyncterm.conf`](deploy/nginx/websyncterm.conf) for a
reverse-proxy configuration.

---

## Repository layout

| Path | Contents |
|---|---|
| `packages/core` | The terminal engine: escape-sequence parser, screen buffer, palette, charset tables, sixel decoder, telnet negotiator, key map, ANSI music parser. No DOM. |
| `packages/render` | Canvas2D/WebGL2 renderer, bitmap font engine, screen-mode table, scaling and CRT effects. |
| `packages/audio` | The ANSI/BANSI music sequencer and the RIP sound effects, on Web Audio. |
| `packages/xfer` | XMODEM, XMODEM-CRC, XMODEM-1K, YMODEM, YMODEM-G and ZMODEM as streaming state machines. |
| `packages/rip` | The RIPscrip 1.54 interpreter. |
| `apps/web` | The full SyncTERM-style PWA. |
| `apps/embed` | The `<web-syncterm>` custom element and the ftelnet-style page. |
| `apps/gateway` | The Node.js WebSocket gateway. |
| `docs/` | [SPEC.md](docs/SPEC.md), [COMPAT.md](docs/COMPAT.md), [LICENSING.md](docs/LICENSING.md). |
| `tools/extract-fonts.mjs` | Extracts the upstream bitmap fonts into a JSON asset. |

---

## Embedding on your site

### The custom element

```html
<script src="https://your.host/web-syncterm.js"></script>
<web-syncterm host="bbs.example.com" port="23" proto="telnet" mode="80x25"></web-syncterm>
```

Attributes:

| Attribute | Default | Meaning |
|---|---|---|
| `host` | — | The BBS host name or address. |
| `port` | `23` | The port. |
| `proto` | `telnet` | `telnet`, `telnets`, `ssh`, `rlogin` or `raw`. |
| `mode` | `80x25` | The screen mode. |
| `user` / `pass` / `syspass` | — | Credentials (see the warning below). |
| `gateway` | the page's origin | The gateway WebSocket base URL. |
| `font` | — | The font name. |
| `speed` | `0` | The simulated line speed in bits per second (0 = unlimited). |

> **Never put a password in page source.** Use the gateway's token mechanism
> or a server-side proxy instead; anything in the HTML is visible to the
> reader.

### The iframe page

`https://your.host/embed/?bbs=bbs.example.com:23&proto=telnet` opens a
self-contained ftelnet-style page with connect/disconnect buttons, a font and
size picker, upload and download buttons, an on-screen keyboard for mobile,
clipboard access and a fullscreen toggle.

### URL parameters

The web app understands `?bbs=host:port&proto=telnet&mode=80x25&user=…`, so a
link can open a session directly.

---

## Running the gateway

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_PORT` | `8023` | The listening port. |
| `GATEWAY_ALLOWLIST` | *(empty)* | A comma-separated list of `host`, `host:port` or `*.example.com` entries. When set, only those hosts may be dialled. |
| `GATEWAY_ALLOWED_ORIGINS` | *(all)* | A comma-separated list of allowed WebSocket origins. |
| `GATEWAY_ALLOW_PRIVATE` | `0` | Set to `1` to permit connections to private/loopback addresses (only for a trusted LAN). |
| `GATEWAY_MAX_SESSIONS` | `64` | The maximum number of concurrent sessions. |
| `GATEWAY_IDLE_TIMEOUT_MS` | `1800000` | The idle timeout. |
| `GATEWAY_RATE_LIMIT` | `100` | HTTP requests per minute per IP. |
| `GATEWAY_SESSION_RATE_LIMIT` | `10` | New sessions per minute per IP. |
| `GATEWAY_TLS_CERT` / `GATEWAY_TLS_KEY` | — | Enable built-in HTTPS/WSS. |

See `deploy/nginx/websyncterm.conf` for a sample reverse-proxy configuration.

### Connecting to Synchronet's own WebSocket service

Synchronet can serve WebSocket connections itself. When it is enabled, point
the widget at the server directly and skip the gateway entirely — no proxy, no
SSRF surface, no credentials in the page.

---

## Feature matrix versus real SyncTERM

The full checklist is in [docs/COMPAT.md](docs/COMPAT.md). The headline
differences:

| Area | SyncTERM | WebSyncTERM |
|---|---|---|
| ANSI-BBS / CTerm extensions | full | full |
| Fonts | 46 built-in + user fonts | the same 46 + the same 74 user fonts |
| Screen modes | 40 modes | the same 40 modes |
| RIPscrip | 1.54 | 1.54 (pixel-compatible, minus the file-transfer level) |
| Sixel | yes | yes |
| PETSCII / ATASCII / Prestel / BEEB / Atari ST | yes | partial (key translation and the main modes) |
| ANSI music | yes | yes |
| X/Y/ZMODEM | yes | yes |
| Dialing directory | INI file, encrypted option | IndexedDB, encrypted option, `syncterm.lst` import/export |
| Modem and serial | yes | not possible in a browser |
| Wren scripting, theme editor, SFTP | yes (1.10) | not implemented |

---

## Testing

```bash
pnpm test             # the vitest suite (289 tests)
pnpm test:e2e         # the Playwright end-to-end suite (6 tests)
pnpm test:all         # both
pnpm typecheck        # tsc across the packages
pnpm typecheck:apps   # tsc across the apps
pnpm benchmark        # the parse-throughput benchmark
```

The end-to-end suite needs the Playwright browser the first time:

```bash
npx playwright install chromium
```

`pnpm test:e2e` starts everything it needs by itself: the mock BBS, the
gateway and the web app. It expects the gateway to have been built first
(`pnpm build:packages && pnpm --filter @websyncterm/gateway run build`).

The conformance harness replays `.ANS`/`.BIN`/`.XB` corpora and compares the
resulting screen buffers; the render package has golden-image tests against
captured SyncTERM output.

---

## Licence

GPL-3.0-or-later. See [docs/LICENSING.md](docs/LICENSING.md) for the full
attribution, including what was ported verbatim from upstream and what was
re-implemented from the published specification.
