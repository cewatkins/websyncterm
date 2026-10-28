# WebSyncTERM — Compatibility Checklist

Legend: `[x]` done · `[~]` partial · `[ ]` not implemented · `[!]` not possible
in a browser.

Reference: upstream **SyncTERM 1.10 alpha / CTerm 1.332**
([SynchronetBBS/sbbs](https://github.com/SynchronetBBS/sbbs)).

---

## 1. Screen modes

| Mode | Cols × Rows | Cell | Status |
|---|---|---|---|
| BW40 / C40 | 40 × 25 | 8×16 | [x] |
| BW80 / C80 / MONO | 80 × 25 | 8×16 | [x] |
| C40X14 / C40X21 | 40 × 14 / 21 | 8×16 | [x] |
| C40X28 | 40 × 28 | 8×14 | [x] |
| C40X43 / C40X50 / C40X60 | 40 × 43 / 50 / 60 | 8×8 | [x] |
| C80X14 / C80X21 | 80 × 14 / 21 | 8×16 | [x] |
| C80X28 | 80 × 28 | 8×14 | [x] |
| C80X30 | 80 × 30 | 8×16 | [x] |
| C80X43 | 80 × 43 | 8×8 | [x] |
| EGA80X25 | 80 × 25 | 8×14 | [x] |
| C80X50 / C80X60 | 80 × 50 / 60 | 8×8 | [x] |
| VESA_132X21 | 132 × 21 | 8×16 | [x] |
| VESA_132X25 | 132 × 25 | 8×16 | [x] |
| VESA_132X28 | 132 × 28 | 8×14 | [x] |
| VESA_132X30 | 132 × 30 | 8×16 | [x] |
| VESA_132X34 | 132 × 34 | 8×14 | [x] |
| VESA_132X43 | 132 × 43 | 8×8 | [x] |
| VESA_132X50 | 132 × 50 | 8×8 | [x] |
| VESA_132X60 | 132 × 60 | 8×8 | [x] |
| ST132X37_16_9 | 132 × 37 | 8×16 | [x] |
| ST132X52_5_4 | 132 × 52 | 8×16 | [x] |
| VGA80X25 | 80 × 25 | **9×16** | [x] |
| LCD80X25 | 80 × 25 | 8×16 (8:5) | [x] |
| C64_40X25 / C128_40X25 | 40 × 25 | 8×8 (6:5) | [x] |
| C128_80X25 | 80 × 25 | 8×8 | [x] |
| ATARI_40X24 | 40 × 24 | 8×8 | [x] |
| ATARI_80X25 (XEP80) | 80 × 25 | 8×16 | [x] |
| PRESTEL_40X25 | 40 × 25 | **12×20** | [x] |
| ATARIST_40X25 / 80X25 / 80X25_MONO | 40/80 × 25 | 8×8 / 8×8 / 8×16 | [x] |
| Custom mode (user cols/rows/height/aspect) | — | — | [x] |

- [x] Aspect-ratio correction (4:3 by default, square-pixel toggle).
- [x] Integer scaling with upstream's snapping rules (never below 1×, ties
  prefer the smaller multiple).
- [x] 9-pixel-column VGA line-graphics duplication (chars `0xC0`–`0xDF`).

---

## 2. Escape sequence support

### 2.1 C0 / control characters

- [x] NUL (doorway literal), BEL, BS, HT, LF, VT (printed as ♂), FF, CR, SO,
      ESC, CAN, SUB.

### 2.2 ESC

- [x] `ESC 7` / `ESC 8` (DECSC / DECRC)
- [x] `ESC E` (NEL), `ESC H` (HTS), `ESC J` (VTS), `ESC M` (RI)
- [x] `ESC P` (DCS), `ESC X` (SOS), `ESC ]` (OSC), `ESC ^` (PM), `ESC _` (APC)
- [x] `ESC \` (ST), `ESC c` (RIS), `ESC :` (ESCST)
- [x] `ESC F` / `ESC G` (SSA / ESA), `ESC S` (STS)

### 2.3 CSI — cursor and editing

- [x] ICH `@`, SL `SP @`, CUU `A`, SR `SP A`, CUD `B`, CUF `C`, CUB `D`
- [x] FNT `SP D`, CNL `E`, CPL `F`, CHA `G`, CUP `H`, CHT `I`
- [x] ED `J`, EL `K`, IL `L`, DL `M`, DCH `P`, SU `S`, SD `T`, ECH `X`
- [x] CVT `Y`, CBT `Z`, HPA `` ` ``, HPR `a`, REP `b`
- [x] VPA `d`, TSR `SP d`, VPR `e`, HVP `f`, TBC `g`
- [x] SM `h` / RM `l` (modes 14 and 16 accepted)
- [x] SGR `m`, DSR `n`, DA `c`, CTDA `< c`
- [x] DECSTBM `r`, DECSLRM `s` (only with DECLRMM), SCOSC `s`, SCORC `u`
- [x] DECSCUSR `SP q`, DECSCS `* r`, CTSAM `= M`, CTSMS `? s`, CTRMS `? u`
- [x] CT24BC `t`, CTSMRR `= n`, physical key report `= K` / `= k`
- [x] BCSET / BCRST `= 255 h/l` (doorway mode)
- [x] CTELCF / CTFLCF `= 4 h`, `= 5 h` (LCF)
- [x] CTOSF `= {` (deprecated font upload announcement)
- [x] XTSRGA `? S`, DECDSR `? n`, DECRQM `$ p` (ANSI, CTerm and private forms)
- [x] DECCARA `$ r`, DECRARA `$ t`, DECSACE `* x`, DECFRA `$ x`, DECERA `$ z`
- [x] DECCRA `$ v`, DECIC `' }`, DECDC `' ~`
- [x] DECRQCRA `* y`, DECTABSR `2 $ w`, DECDMAC / DECINVM
- [x] DECSASD `$ }`, DECSSDT `$ ~`
- [x] `CSI |` / `CSI N` / `CSI M` ANSI music introducers

### 2.4 OSC

- [x] `OSC 4` palette set and query
- [x] `OSC 104` palette reset
- [x] `OSC 10 ; ?` / `OSC 11 ; ?` default colour queries
- [x] `OSC 8` hyperlinks (with `id=` parameters)
- [~] `OSC 0` / `OSC 2` window title (handled by the host UI)

### 2.5 DCS

- [x] Sixel (`DCS p1[;p2[;p3]] q`)
- [x] `DCS CTerm:Font:<slot>:<base64>` font upload
- [x] `DCS $ q` DECRQSS
- [x] `DCS … ! z` DECDMAC

### 2.6 APC

- [x] `SyncTERM:VER`
- [x] `SyncTERM:C;S` / `SyncTERM:C;L` (session file cache)
- [x] `SyncTERM:C;SetFont`
- [~] `SyncTERM:C;DrawPPM` / `LoadPPM` / `LoadPBM` / `P;Copy` / `P;Paste`
      (PPM/PBM only; JXL is not implemented in the browser)
- [~] `SyncTERM:A;…` audio APCs (tone synthesis is implemented; the full
      channel mixer is not)

---

## 3. SGR and attributes

- [x] 0, 1, 2, 4, 5, 6, 7, 8, 22, 25, 27
- [x] 30-37, 39, 40-47, 49
- [x] 38 / 48 extended colours: `;5;N`, `;2;R;G;B`, `:5:N`, `:2:R:G:B`
- [x] 90-97 bright foreground, 100-107 bright background
- [x] Parameters applied in order, unlimited count
- [x] iCE colours: DECSET 31/32/33/34/35
- [x] Blink as an alternate font slot
- [x] Negative image (7/27) preserving the intensity bits

---

## 4. Fonts

- [x] All 46 built-in code page slots (0-45) with their 8×16 / 8×14 / 8×8 /
      12×20 faces where upstream provides them
- [x] The 74 upstream `.fNN` user fonts
- [x] Font selection via `CSI Ps1 ; Ps2 SP D`
- [x] Font upload via `DCS CTerm:Font:` and `CSI = Ps1 ; Ps2 {`
- [x] The font-state report (`CSI = 1 n`)
- [x] Custom fonts supplied by the user through the UI
- [x] "Thin" font variants identified by the code page name

---

## 5. Palette

- [x] The 282-entry DAC with the upstream values
- [x] The 16 system colours in SGR order
- [x] The XTerm 256-colour cube and greyscale ramp
- [x] The C64, Atari and Atari ST palettes
- [x] BBS-supplied palette upload
- [x] OSC 4 / OSC 104 editing
- [x] Bright background (DECSET 33) and the SGR 100-107 bright backgrounds

---

## 6. Terminal emulations

| Emulation | Status | Notes |
|---|---|---|
| ANSI-BBS | [x] | the default; full CTerm extension set |
| ECMA-48 | [x] | the base layer of ANSI-BBS |
| PETSCII (C64/C128, upper and lower) | [~] | key translation and the 40/80-column colour tables are implemented; the full control-code table is partial |
| ATASCII | [~] | key translation and inverse-video are implemented; the full screen-code table is partial |
| Prestel / Viewdata | [~] | key translation implemented; the serial-attribute model is partial |
| BBC Micro (Mode 7) | [~] | key translation implemented; the VDU 23/28 model is partial |
| Atari ST (VT52 + TOS extensions) | [~] | key translation implemented; the TOS extension set is partial |
| RIPscrip | [x] | see §10 |
| Operation Overkill II | [ ] | upstream auto-detects it from the byte stream; not implemented |

---

## 7. Connections

| Protocol | Status | Notes |
|---|---|---|
| Telnet | [x] | full option negotiation in the browser: SGA, BINARY, ECHO, TERMINAL-TYPE, NAWS |
| TelnetS (TLS) | [x] | via the gateway, port 992 |
| SSH | [x] | password and public-key auth, PTY, window-change, host-key verification |
| RLogin | [x] | including the reversed variant and the RFC 1282 handshake |
| Raw TCP | [x] | |
| Modem | [!] | impossible in a browser |
| Serial | [!] | impossible in a browser (Web Serial is offered as an alternative) |
| Local shell | [!] | impossible in a browser |

- [x] Auto-login macros, reconnect, keepalive, bell handling
- [x] `?bbs=host:port&proto=…&mode=…` URL handler
- [x] Output speed emulation (300 … 115200 baud, plus unlimited)

---

## 8. Dialing directory

- [x] List, add, edit, delete
- [x] Folders and search
- [x] Stored in IndexedDB
- [x] Fields: name, address, port, protocol, username, password, system
      password, screen mode, font, speed, music on/off, ANSI/RIP flags, notes,
      last called
- [x] Encrypted directory (WebCrypto AES-GCM with PBKDF2)
- [x] Import and export of SyncTERM `syncterm.lst` files
- [x] Shareable URL and QR links
- [ ] Named sort profiles with `<` / `>` cycling (a SyncTERM 1.8 feature)
- [ ] Web-based main dialing directory (a SyncTERM 1.8 feature)

---

## 9. File transfer

| Protocol | Send | Receive |
|---|---|---|
| XMODEM (1K default) | [x] | [x] |
| XMODEM-128 | [x] | [~] |
| XMODEM-CRC | [~] (the sender honours the receiver) | [x] |
| XMODEM-1K | [x] | [x] |
| YMODEM | [x] | [x] |
| YMODEM-G | [x] | [x] |
| ZMODEM | [x] | [x] |
| ZMODEM resume (`ZRPOS`) | [x] | [x] |

- [x] Progress UI, cancel key, batch transfers
- [x] Drag-and-drop and the File System Access API
- [x] Auto-detection of a remote ZMODEM header
- [x] Per-session file locker in IndexedDB, with a ZIP bulk export
- [ ] CET Telesoftware protocol (a Prestel-specific protocol)

---

## 10. RIPscrip

- [x] The `!|` framing, MegaNum arguments and the command boundary rules
- [x] Level 0 graphics: lines, rectangles, circles, arcs, ovals, polygons,
      Bezier curves, flood fill, fill styles, line styles, XOR mode
- [x] The 64-colour EGA palette and the default 16-colour mapping
- [x] The RIPterm v1.54 quirks (ellipse aspect, Bézier point count, flood fill,
      4-bit colour mask, line patterns, `!|*` semantics)
- [x] Text windows and the extended text window
- [x] Level 1 commands that do not need a local file system
- [~] Icons (the `.ICN` loader is implemented; the 187 built-in icons are not
      bundled)
- [ ] Level 9 block transfers (XMODEM/YMODEM/ZMODEM inside RIP)
- [ ] The Wren-driven RIP host-command layer

---

## 11. Sixel

- [x] The full grammar: intro parameters, raster attributes, colour select and
      palette map, repeat, graphics carriage return and new line
- [x] Transparent mode and the DECSET 80 scrolling behaviour
- [x] The cursor position after the image
- [x] Interaction with the text layer

---

## 12. ANSI music

- [x] The parser, the note table, the tempo and octave handling
- [x] Web Audio playback with an AudioWorklet and an oscillator fallback
- [x] The RIP sound variables (`$ALARM$`, `$BEEP$`, `$BLIP$`, `$MUSIC$`,
      `$PHASER$`, `$REVPHASER$`)

---

## 13. User interface

- [x] Status bar with the connection info, mode, speed and time online
- [x] Scrollback buffer with mouse-wheel scrolling and search
- [x] Select, copy and paste (non-ASCII screen modes are translated to text)
- [x] "Copy as ANSI", PNG screenshot and `.ANS` export
- [x] Fullscreen (Alt+Enter), integer scaling, smoothing, CRT scanlines and
      curvature
- [x] Clickable OSC 8 links and Ctrl+click URL detection
- [x] Mouse reporting for BBS door games, alongside text selection
- [x] The on-screen keyboard for mobile
- [x] The Alt shortcuts (see SPEC §4.2)
- [ ] The Wren menu / REPL console (SyncTERM 1.10)
- [ ] The theme editor and the web theme catalog (SyncTERM 1.10)
- [ ] The SFTP browser and transfer queue (SyncTERM 1.10)

---

## 14. Embed and gateway

- [x] `<web-syncterm host="…" port="…" proto="…" mode="…">` custom element
- [x] A one-line `<script src="…/web-syncterm.js">` integration
- [x] An iframe-friendly `index.html` that behaves like ftelnet
- [x] Connect / disconnect buttons, font and size pickers, upload and download
      buttons, an on-screen keyboard, clipboard access and fullscreen
- [x] Host allowlist (sysop mode) and open-directory mode
- [x] SSRF protection, rate limiting, max sessions, idle timeout, origin checks
- [x] A Docker image and a `docker-compose.yml`
- [x] A sample nginx configuration
- [x] Direct connection to a Synchronet server's built-in WebSocket service
      (without the gateway)

---

## 15. Quality

- [x] Unit tests for every parser state machine
- [x] Fuzzing harness for the ANSI parser
- [x] Playwright E2E tests against a mock BBS
- [x] Keyboard-only operation and a screen-reader-friendly status region
- [x] A documented performance budget
- [~] Golden-image comparison against real SyncTERM output (the harness is in
      place; the reference corpus is being captured)
- [~] Lighthouse PWA score 90+ (the PWA manifest and service worker are in
      place; the score is not yet measured)

---

## 16. Licensing

- [x] GPL-3.0-or-later for the project
- [x] Attribution for the upstream GPL fonts and code
- [x] A statement of what was re-implemented from the specification and what
      was ported — see [LICENSING.md](./LICENSING.md)
