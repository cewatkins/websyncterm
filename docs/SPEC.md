# WebSyncTERM — Feature Specification

This document is the implementation contract for WebSyncTERM: a browser-based,
faithful clone of **SyncTERM** (the BBS terminal from
[SynchronetBBS/sbbs](https://github.com/SynchronetBBS/sbbs)) plus a
self-hostable ftelnet-style gateway.

Every feature below lists the upstream source file it was derived from. The
reference tree used for this specification is the upstream `master` branch at
**SyncTERM 1.10 alpha / CTerm revision 1.332** (upstream tags
`syncterm-1.9rc4`, `syncterm-1.9rc5`, `syncterm-1.9` exist; the working tree is
newer than all of them — see [§12](#12-what-changed-after-19rc4)).

> **Status legend** — `[x]` implemented, `[~]` partial, `[ ]` not implemented,
> `[!]` not possible in a browser. The same legend is used in
> [COMPAT.md](./COMPAT.md), which is the tick-list form of this document.

---

## 1. Terminal engine (`packages/core`)

### 1.1 Attribute model

Derived from `src/conio/cterm.c` (`cterm->attr`) and `src/conio/bitmap_con.c`
(`bitmap_attr2palette_locked`).

The attribute is a single byte:

| Bits | Meaning |
|---|---|
| `0x0F` | foreground palette index |
| `0xF0` | background palette index |
| `0x08` | high intensity ("bold") |
| `0x80` | blink (or bright background when `DECSET 33` is set) |

Alongside it the engine tracks:

* `fgColor` / `bgColor` — an extended palette index (`SGR 38;5;N` → `N + 16`)
  or a direct 24-bit RGB value (`SGR 38;2;R;G;B`), matching upstream's
  `map_rgb()` which sets bit 31.
* `negative` — SGR 7, so that SGR 27 can undo it (upstream `cterm_set_negative`).
* `fgTc` / `bgTc` — the verbatim SGR parameter text, used by DECRQSS `m`
  (`src/conio/cterm_dec.c:2304-2343`).

**iCE colour rules** (`src/conio/cterm_cterm.c`, `src/conio/cterm_dec.c`):

| DECSET | Effect |
|---|---|
| 31 | the high-intensity bit selects an alternate font (`CIOLIB_VIDEO_ALTCHARS`) |
| 32 | the high-intensity bit stops acting as *bright* (`NOBRIGHT`) |
| 33 | the blink bit becomes a bright background (`BGBRIGHT`); enables SGR 100-107 |
| 34 | the blink bit selects an alternate font (`BLINKALTCHARS`) |
| 35 | the blink bit stops blinking (`NOBLINK`) |

### 1.2 Palette

The DAC table (`src/conio/vidmodes.c:dac_default[282]`):

| Range | Contents |
|---|---|
| 0-15 | system colours, in SGR order |
| 16-231 | XTerm 6×6×6 colour cube (levels 0, 95, 135, 175, 215, 255) |
| 232-255 | 24-step greyscale ramp (8 … 238) |
| 256-271 | Commodore 64 colours (pepto.de "colorvic" values) |
| 272-273 | Atari 8-bit colours |
| 274-281 | Atari ST colours (RGB333 expanded) |

The 16 system colours are `(0,0,0) (168,0,0) (0,168,0) (168,84,0) (0,0,168)
(168,0,168) (0,168,168) (168,168,168) (84,84,84) (255,84,84) (84,255,84)
(255,255,84) (84,84,255) (255,84,255) (84,255,255) (255,255,255)`.

Upstream addresses the DAC through a **shadow palette**: when the extended
palette is enabled, shadow entry `16 + n` holds DAC entry `n`
(`src/conio/cterm.c:1949-1961`). Consequently:

* `SGR 38;5;N` selects shadow index `N + 16` — i.e. **DAC order, not XTerm
  order** (`src/conio/cterm_cterm.c:1381`).
* The colon forms (`38:5:N`) do *not* add the offset (an upstream quirk,
  `cterm_cterm.c:1344`).
* `OSC 4 ; N ; rgb:…` writes shadow index `N + 16` (`cterm_cterm.c:766`).
* `OSC 104` resets the shadow entries; a bare `104` resets everything.

### 1.3 Control characters

From `src/conio/cterm.txt` and `src/conio/cterm_ecma48.c`.

| Byte | Behaviour |
|---|---|
| `0x00` NUL | in doorway mode (`CSI = 255 h`) the **next** byte is literal |
| `0x07` BEL | bell (handled by the host application) |
| `0x08` BS | non-destructive backspace; no-op in column 0 |
| `0x09` HT | next tab stop; if none remain, go to column 0 of the next line; on the last line, scroll |
| `0x0A` LF | same column, next row; scrolls at the bottom of the scroll region |
| `0x0B` VT | **printed** as CP437 `0x16` (♂), not a line tab |
| `0x0C` FF | clear the screen with the current attribute |
| `0x0D` CR | column 1 |
| `0x0E` SO | terminates an ANSI music string |
| `0x1B` ESC | introduces a control code |
| `0x18` CAN / `0x1A` SUB | abort the current escape sequence |

### 1.4 Line wrapping and the Last Column Flag (LCF)

From `src/conio/cterm.txt` (the "End of line behaviour" section) and
`src/conio/cterm.c`.

* **Default**: writing a character to the last column moves the cursor to
  column 1 of the next line immediately (scrolling if needed).
* `CSI ? 7 l` (DECAWM reset): wrapping is disabled entirely; characters written
  to the last column overwrite it and the cursor does not move.
* `CSI = 4 h` enables LCF mode: the cursor parks at the right margin and the
  next printable character wraps.
* `CSI = 5 h` forces LCF mode and makes it survive `ESC c` (RIS).
* LCF is cleared by: `CSI ? 6 h/l`, `CSI ? 7 l`, and any sequence whose final
  byte is `@ A B a j H f I Y J K P X r`, plus `ESC E`, `ESC M`, CR, LF, BS, HT.

### 1.5 Escape sequences

#### ESC (single byte)

| Sequence | Name | Behaviour |
|---|---|---|
| `ESC 7` | DECSC | save the cursor position (same slot as `CSI s`) |
| `ESC 8` | DECRC | restore the cursor position |
| `ESC E` | NEL | CR + LF |
| `ESC H` | HTS | set a character tab stop at the cursor |
| `ESC J` | VTS | set a line tab stop at the cursor |
| `ESC M` | RI | reverse index (scroll down at the top of the region) |
| `ESC P` | DCS | begin a device control string |
| `ESC X` | SOS | begin a start-of-string (ignored) |
| `ESC ]` | OSC | begin an operating system command |
| `ESC ^` | PM | begin a privacy message (ignored) |
| `ESC _` | APC | begin an application program command |
| `ESC \` | ST | terminate a control string |
| `ESC c` | RIS | reset to the initial state |
| `ESC F` / `ESC G` | SSA / ESA | mark the screen-content selection area |
| `ESC S` | STS | transmit the selection area |
| `ESC :` | ESCST | escaped ST inside an STS response |

#### CSI

The full table is in [COMPAT.md §2](./COMPAT.md#2-escape-sequence-support) and
in `src/conio/cterm.adoc`. The implementation covers every sequence listed
there, including:

* Cursor movement: CUU, CUD, CUF, CUB, CNL, CPL, CHA, CUP, HVP, HPA, HPR, VPA,
  VPR, HPB, VPB.
* Editing: ICH, DCH, ECH, IL, DL, SU, SD, ED, EL, SL, SR, REP, CHT, CBT, CVT.
* Scroll regions: DECSTBM (`CSI t;b r`) and DECSLRM (`CSI l;r s`, only when
  DECLRMM (69) is set).
* Cursor save/restore: `CSI s` (SCOSC) / `CSI u` (SCORC), `ESC 7` / `ESC 8`.
* Font selection: `CSI Ps1 ; Ps2 SP D` (FNT) — Ps1 selects the attribute slot
  (0 default, 1 high-intensity, 2 blink, 3 both), Ps2 the font slot 0-255.
* Device reports: DA (`CSI c` → `CSI = 67;84;101;114;109;1;332 c`), CTDA
  (`CSI < c` → capability bits 1-8), DSR (`CSI 5 n`, `CSI 6 n`, `CSI 255 n`),
  CTSMRR (`CSI = 1…7 n`), DECRQM in its ANSI, CTerm and private forms.
* DECRQSS: `DCS $ q pt ST` answering `m`, `r`, `s`, `t`, `$|`, `*|`, ` q`,
  `*r`, `*x`, `$~`, `$}`.
* DEC rectangular operations: DECCARA (`$r`), DECRARA (`$t`), DECSACE (`*x`),
  DECFRA (`$x`), DECERA (`$z`), DECCRA (`$v`), DECIC (`'}`), DECDC (`'~`).
* Macros: DECDMAC (`DCS p1;p2;p3 ! z … ST`) and DECINVM (`CSI Pn * z`).
* Checksums: DECRQCRA (`CSI … * y`), DECMSR/DECCKSR (`CSI ? 62 n`, `CSI ? 63 n`).
* Output speed emulation: DECSCS (`CSI Ps1 ; Ps2 * r`), where Ps2 maps
  0 = unlimited and 1…11 = 300 … 115200 baud.
* Status line: DECSSDT (`CSI Ps $ ~`), DECSASD (`CSI Ps $ }`).

#### OSC

| Sequence | Behaviour |
|---|---|
| `OSC 4 ; idx ; spec` | set a palette entry; `spec` is `rgb:R/G/B` (1-4 hex digits per channel) or `?` to query |
| `OSC 104 [; idx…]` | reset palette entries; a bare `104` resets all |
| `OSC 10 ; ?` | reply with the default foreground colour |
| `OSC 11 ; ?` | reply with the default background colour |
| `OSC 8 ; params ; uri` | set a hyperlink (only `id=` is honoured); an empty URI closes it |
| `OSC 0` / `OSC 2` | window title |

A BEL byte **aborts** an OSC string rather than terminating it.

#### DCS

| Sequence | Behaviour |
|---|---|
| `DCS p1[;p2[;p3]] q … ST` | sixel graphics |
| `DCS CTerm:Font:slot:<base64> ST` | load a font into a slot |
| `DCS $ q pt ST` | DECRQSS |
| `DCS p1[;p2[;p3]] ! z … ST` | DECDMAC |

#### APC

SyncTERM implements a large APC surface (`src/conio/cterm_cterm.c`). The
browser implements the subset that is meaningful without a local file system:
`SyncTERM:VER`, `SyncTERM:C;S` (store a file in the session cache),
`SyncTERM:C;L` (list the cache), `SyncTERM:C;SetFont`, `SyncTERM:C;DrawPPM`,
`SyncTERM:C;LoadPPM`, `SyncTERM:C;LoadPBM`, `SyncTERM:P;Copy`,
`SyncTERM:P;Paste`, and the audio APCs `SyncTERM:A;…` / `SyncTERM:Q;…`.

### 1.6 SGR

From `src/conio/cterm_ecma48.c:1626-1700` and `src/conio/cterm_cterm.c:1312`.

| Parameter | Effect |
|---|---|
| 0 | reset the attribute (negative off, attr `0x07`) |
| 1 | set the high-intensity bit (suppressed by DECSET 32) |
| 2 / 22 | clear the high-intensity bit |
| 4 | accepted, no effect |
| 5 / 6 | set the blink bit (both are the same speed) |
| 7 | negative image: swap the 3-bit colour nibbles, keep `0x88` |
| 8 | concealed: the foreground becomes the background |
| 25 | clear the blink bit |
| 27 | positive image (undoes SGR 7) |
| 30-37 | foreground 0-7; **37 and 39 both mean 7** |
| 38 | extended foreground (`38;5;N`, `38;2;R;G;B`, `38:5:N`, `38:2:R:G:B`) |
| 39 | default foreground (same as 37) |
| 40-47 | background 0-7; **40 and 49 both mean 0** |
| 48 | extended background |
| 49 | default background (same as 40) |
| 90-97 | bright foreground; no effect when DECSET 32 is set |
| 100-107 | bright background; only when DECSET 33 is set |

Parameters are applied **in received order** and an unlimited number of
parameters is supported.

### 1.7 iCE colours

With iCE colours the blink attribute selects the **bright variant of the
background colour** instead of making the character blink. This is the "high
intensity BG" convention that ANSI art uses, that SAUCE's `nonblink` ANSI flag
describes (`sauce_ansiflag_nonblink`, *"High intensity BG, aka iCE colors"*),
and that Synchronet's per-user `ICE_COLOR` terminal flag enables server-side.

Upstream implements it with two video-mode flags:

* `CIOLIB_VIDEO_BGBRIGHT` (DECSET 33) — the background nibble keeps the blink
  bit, so `attr2palette()` resolves the background to index 8-15 (the bright
  half of the palette) instead of masking it back to 0-7.
* `CIOLIB_VIDEO_NOBLINK` (DECSET 35) — the glyph is never hidden.

WebSyncTERM exposes this as a **Colours** setting in the toolbar, defaulting to
**iCE** rather than blinking, because that is what the overwhelming majority of
BBS content expects. Switching it re-resolves the whole screen from the stored
attribute bytes, exactly as upstream's draw-time resolution does. A host that
sends `CSI ? 33 h` or `CSI ? 35 h` still overrides the preference.

### 1.8 DECSET / DECRST modes

| Mode | Default | Effect |
|---|---|---|
| 6 | reset | origin mode (position parameters are relative to the scroll region) |
| 7 | **set** | auto-wrap |
| 9 | reset | X10 mouse reporting |
| 25 | **set** | cursor visible |
| 31 | reset | high-intensity bit selects an alternate font |
| 32 | reset | the high-intensity bit stops acting as bright |
| 33 | reset | the blink bit becomes a bright background |
| 34 | reset | the blink bit selects an alternate font |
| 35 | reset | the blink bit stops blinking |
| 67 | **set** | DECBKM: backspace sends `0x08`, delete sends `0x7F` |
| 69 | reset | DECLRMM: `CSI s` sets the left/right margins instead of saving the cursor |
| 80 | reset | sixel scrolling enabled (`CSI ? 80 l` clears it) |
| 1000/1002/1003 | reset | mouse tracking modes |
| 1006 | reset | SGR-encoded mouse coordinates |
| 1016 | reset | SGR pixel mouse coordinates |
| 2004 | reset | bracketed paste |

The CTerm private modes (`CSI = Ps h/l`) are: 1 physical key reports, 2 suppress
translated key input, 4 LCF, 5 forced LCF, 255 doorway mode.

### 1.9 Sixel graphics

Derived from `src/conio/cterm_dec.c:1418-2165`.

* The intro is `DCS P1 [;P2 [;P3]] q`. P1 is a **vertical replication factor**
  (0/1/5/6 → 2, 2 → 5, 3/4 → 3, 7/8/9 → 1, otherwise 2). P2 selects the
  background behaviour (0 = opaque, non-zero = transparent).
* Raster attributes (`"`) are honoured only **before** the first data byte; P1
  overrides the vertical multiplier, P2 is a horizontal replication factor.
* `#Pc` selects a colour, `#Pc;2;Pr;Pg;Pb` defines one with percentage
  components.
* `!Pn` repeats the next data character, `$` returns to the left border and
  `-` starts a new sixel row.
* Data characters are `?`..`~`; each carries six vertical pixels with the
  least significant bit at the top.
* The sixel colour palette lives in the DAC; entries at and above 282 are
  uninitialised (transparent black) until the stream defines them.
* The sixel origin is the current text cursor when scrolling is enabled
  (DECSET 80 clear); otherwise it is the top-left of the page and the cursor is
  restored afterwards.

### 1.10 ANSI music

Derived from `src/conio/cterm.txt` ("ANSI MUSIC" section).

* The introducer is `CSI |` (always), `CSI N` (when `CSI = 1 M`) or `CSI M`
  (when `CSI = 2 M`). The string is terminated by SO (`0x0E`).
* Only `aAbBcCdDeEfFgGlLmMnNoOpPsStT0123456789.-+#<> ` are allowed; any other
  character aborts the string.
* `MF`/`MB`/`MN`/`ML`/`MS` set the mode, `MT###` the tempo (clamped to 32-255
  quarter notes per minute, default 120), `MO###` the octave (0-6, default 4).
* `N###` plays a note by number (0-71; invalid values are silence).
* `A`-`G` and `P` play a named note or a pause. Modifiers: `+`/`#` sharp,
  `-` flat, `.` dotted (×1.5, not cumulative), and a digit sequence giving the
  note length as the reciprocal of a whole note (default 4).
* `L###` sets the default note length (1-64).
* `<` and `>` move down and up one octave, clamped to 0-6.
* The seven octave base frequencies are 65.406, 130.810, 261.620, 523.250,
  1046.500, 2093.000 and 4186.000 Hz.

---

## 2. Screen modes, fonts and geometry

### 2.1 Video modes

The complete `vparams[]` table from `src/conio/vidmodes.c` — 40 modes
including 40-column, 80-column and 132-column geometries, the C64/C128 modes,
the Atari modes, the Atari ST modes, VGA80X25 (9-pixel cells), LCD80X25,
PRESTEL_40X25 (12×20 cells) and the 16:9 / 5:4 ST modes. See
[COMPAT.md §1](./COMPAT.md#1-screen-modes).

### 2.2 Terminal emulations

`enum cterm_emulation_t` (`src/conio/cterm.h:60-67`):

| Emulation | Enum | Source | Default for |
|---|---|---|---|
| ANSI-BBS | 0 | `cterm_ecma48.c` + `cterm_dec.c` + `cterm_cterm.c` | every other screen mode |
| PETSCII | 1 | `cterm_petscii.c` | C64, C128-40, C128-80 |
| ATASCII | 2 | `cterm_atascii.c` | Atari 40×24, Atari XEP80 |
| Prestel | 3 | `cterm_prestel.c` | Prestel 40×25 |
| BEEB (Mode 7) | 4 | `cterm_prestel.c` | BBC Micro Mode 7 |
| Atari ST (VT52) | 5 | `cterm_vt52.c` | Atari ST 40/80/25 |

RIP and Operation Overkill II are **overlays** on ANSI-BBS, not separate
emulations (`src/syncterm/term.c:4596-4608` disables RIP for non-ANSI modes).

### 2.3 Fonts

* **Format** — raw glyph data, no header. `size = 256 × height × ceil(width/8)`.
  Glyphs are in code page order (0-255), row-major, one byte per row for
  8-wide faces, MSB = leftmost pixel. The 12×20 face uses two bytes per row,
  big-endian, with the 12 pixels in bits 15..4.
  Source: `src/syncterm/fonts.c:177-250`, `src/conio/bitmap_con.c:146-171`.
* **Built-in slots 0-45** — `conio_fontdata[]` in `src/conio/allfonts.c`:
  CP437, CP850, CP865, CP866 (two variants), CP866U, CP1131, CP1251,
  ISO-8859-1/2/4/5/7/8/9/15, KOI8-R, ARMSCII-8, HAIK8, Commodore 64 upper and
  lower, Commodore 128 upper and lower, Atari, P0T NOoDLE (Amiga), mO'sOul
  (Amiga), MicroKnight and MicroKnight Plus (Amiga), Topaz and Topaz Plus
  (Amiga), Prestel, Atari ST and RIPterm. Slots 46+ are loadable
  (`CONIO_FIRST_FREE_FONT`, `src/conio/ciolib.h:361`).
* **User fonts** — the 74 `.fNN` files from `src/syncterm/fonts/`.
* **9-pixel column** — enabled for VGA80X25 only. The 9th pixel column is
  synthesised per scanline: for characters `0xC0`..`0xDF` it duplicates the 8th
  pixel column, for everything else it is blank
  (`src/conio/bitmap_con.c:860-885`).
* **Custom fonts** — a BBS may upload a font with
  `DCS CTerm:Font:<slot>:<base64> ST`; the slot must be ≥ 46 and the decoded
  size must be 2048, 3584, 4096 or 10240 bytes.

### 2.4 Scaling and aspect ratio

From `src/conio/bitmap_con.c:2791-3153` and `src/conio/scale.c`.

* If `round(nativeHeight × aspectW / aspectH) <= nativeWidth` the **width** is
  authoritative and the height is derived; otherwise the height is
  authoritative. The scale factor never drops below 1.0.
* Integer snapping is used when the current scale is within a tolerance of
  0.0125 of an integer; ties prefer the **smaller** multiple.
* An explicit snap down only happens when the current window is an exact
  integer multiple ("do not snap to a smaller integer scale").

---

## 3. Connections (`apps/gateway`)

### 3.1 Telnet

Derived from `src/syncterm/conn_telnet.c` and `src/syncterm/telnet_io.c`.

The negotiation is performed **in the browser** by `TelnetNegotiator`; the
gateway is a transparent byte pipe.

* On connect the client sends `IAC WILL SGA`, `IAC DO SGA`, `IAC WILL BINARY`,
  `IAC DO BINARY` and `IAC DO ECHO` (the BINARY pair is omitted when the entry
  disables binary).
* `IAC DO TERMINAL-TYPE` is answered with `IAC WILL TERMINAL-TYPE`; the
  server's `IAC SB TERMINAL-TYPE SEND` is answered with
  `IAC SB TERMINAL-TYPE IS <name> IAC SE`, immediately followed by
  `IAC WILL NAWS`.
* NAWS is `IAC SB NAWS <cols hi> <cols lo> <rows hi> <rows lo> IAC SE`, sent on
  `DO NAWS` and on every resize.
* Every other option is refused with `WONT`/`DONT`. SyncTERM does **not**
  implement TERMINAL-SPEED, LINEMODE, NEW-ENVIRON or CHARSET.
* The terminal type reported is `syncterm` for ANSI-BBS, `PETSCII`, `ATASCII`,
  `Prestel`, `Beeb7` or `AtariST+VT52` for the other emulations.

### 3.2 RLogin

From `src/syncterm/rlogin.c:407-448`. Four NUL-terminated strings are written
back-to-back:

1. the client user name (empty),
2. the server user name (the `password` field),
3. the terminal type/speed (the `user` field),
4. `"<emulation>/<speed>"` (default speed 115200).

"Reversed" mode swaps fields 2 and 3.

### 3.3 SSH

From `src/syncterm/ssh.c`. Password and public-key authentication, a PTY
request with `TERM` set to the emulation string, `window-change` on resize,
and host-key verification surfaced to the user (TOFU with a SHA-256
fingerprint).

### 3.4 Telnets (TLS)

From `src/syncterm/telnets.c`. TLS on port 992 with the same telnet engine on
top.

---

## 4. Input

### 4.1 Key map

From `src/conio/cterm.c:331-393`.

| Key | Bytes |
|---|---|
| Up / Down / Right / Left | `ESC[A` `ESC[B` `ESC[C` `ESC[D` |
| Home | `ESC[H` |
| End | `ESC[K` |
| Page Up / Page Down | `ESC[V` / `ESC[U` |
| Insert | `ESC[@` |
| Shift+Tab | `ESC[Z` |
| F1-F5 | `ESC[11~` … `ESC[15~` |
| F6-F10 | `ESC[17~` … `ESC[21~` |
| F11 / F12 | `ESC[23~` / `ESC[24~` |
| Shift+F* | `ESC[<code>;2~` |
| Alt+F* | `ESC[<code>;3~` |
| Ctrl+F* | `ESC[<code>;5~` |
| Backspace | `0x08` when DECBKM is set, else `0x7F` |
| Delete | `0x7F` when DECBKM is set, else `ESC[3~` |

Per-emulation overrides are implemented for PETSCII (`cterm.c:158-178`),
ATASCII (`cterm.c:148-156`), VT52 (`cterm.c:321-329`), Prestel and BEEB
(`cterm.c:180-319`).

### 4.2 Application shortcuts

SyncTERM 1.10 moved its shortcut handling into Wren scripts
(`src/syncterm/scripts/auto/connected/keys_default.wren`); the binding table is
reproduced in `packages/core/src/keymap.ts`:

| Shortcut | Action |
|---|---|
| Alt+X | hang up and exit |
| Alt+H / Ctrl+Q | hang up |
| Alt+O | toggle mouse reporting |
| Alt+Up / Alt+Down | throttle the output speed up/down |
| Shift+Insert | paste |
| Alt+B | scrollback viewer |
| Alt+C | capture |
| Alt+M | ANSI music |
| Alt+D / Alt+U | download / upload |
| Alt+F | font picker |
| Alt+Z / Ctrl+S | online menu |
| Alt+L | send the stored credentials |
| Alt+E | open the menu |

---

## 5. File transfer (`packages/xfer`)

See [§7](#7-file-transfer-protocols) for the protocol details.

---

## 6. RIPscrip (`packages/rip`)

See [§8](#8-ripscrip-154).

---

## 7. File transfer protocols

Derived from `src/sbbs3/xmodem.c`, `src/sbbs3/zmodem.c` and
`src/syncterm/term.c`.

| Protocol | Send | Receive | Block | Checksum |
|---|---|---|---|---|
| XMODEM | yes | yes (prompts for a name) | 1024 by default, 128 on fallback | 8-bit sum |
| XMODEM-128 | yes (`XMODEM_128B`) | — | 128 | sum or CRC |
| XMODEM-CRC | sender honours the receiver | yes | 128/1024 | CRC-16/XMODEM |
| XMODEM-1K | yes (the default "XMODEM") | yes | 1024 | sum or CRC |
| YMODEM | yes | yes | 128/1024 | CRC-16 |
| YMODEM-G | yes | yes | 1024 | CRC-16, streamed |
| ZMODEM | yes | yes (auto-detected) | 1024 | CRC-16/32 |

Upstream quirks that are reproduced:

* Detection is a **4-byte prefix match** on `18 42 30 30` (ZRQINIT) and
  `18 42 30 31` (ZRINIT) — not a full header match.
* Plain "XMODEM" sends **1 KiB** blocks; 128-byte blocks require
  `XMODEM_128B`.
* The XMODEM header timeout is 3 s for blocks 0 and 1 and 10 s afterwards.
* The local XMODEM cancel sequence is 8 × CAN followed by 10 × BS.
* A ZMODEM transfer is aborted by **five** consecutive CAN bytes.
* `ZCRCW` gets a trailing XON; `ZCRCQ` does not.
* Hex headers omit the trailing XON for ZACK and ZFIN.
* Partial ZMODEM downloads are deliberately retained for resume; only 0-byte
  failures are deleted.
* There is no ZMODEM-8K/32K, no LZW/RLE and no ESC8.

---

## 8. RIPscrip 1.54

Derived from `src/syncterm/ripper.c`.

* The introducer is `!|`, optionally preceded by `SOH`/`STX`; the level and
  sublevel follow as 1-2 digits.
* Arguments are fixed-width base-36 "MegaNum" fields.
* The command boundary is `|` (which also opens the next command) or CR; a
  trailing `\` continues the line; LF is swallowed.
* The 64-colour EGA master palette and the default 16-colour mapping
  (`{0,1,2,3,4,5,20,7,56,57,58,59,60,61,62,63}`) are reproduced.
* The RIPterm v1.54 quirks — the 0.775 ellipse aspect, the 0x3FC Bézier point
  count, flood fill stopping on the fill colour, the 4-bit colour mask, the
  `0xFFFF/0xCCCC/0xFC78/0xF8F8` line patterns and `!|*` not resetting the
  colour or line style — are reproduced deliberately.

---

## 9. Security

| Requirement | Implementation |
|---|---|
| SSRF protection | the gateway resolves the host and rejects any private, loopback, link-local, multicast or reserved address, and re-checks the address after connecting (DNS rebinding) |
| Host allowlist | `GATEWAY_ALLOWLIST` restricts the connectable hosts, with `host:port` and `*.example.com` support |
| Rate limiting | per-IP HTTP rate limiting plus a per-IP session-creation limit |
| Max sessions | `GATEWAY_MAX_SESSIONS` (default 64) |
| Idle timeout | `GATEWAY_IDLE_TIMEOUT_MS` (default 30 minutes) |
| TLS only | the gateway speaks plain HTTP/WS and must sit behind a TLS terminator; an optional built-in HTTPS mode is provided |
| Origin checks | `GATEWAY_ALLOWED_ORIGINS` validates the WebSocket `Origin` header |
| Credential hygiene | passwords, system passwords and private keys are never logged and are redacted from URLs |
| Signed session tokens | the embed widget may pass a short-lived HMAC token so a sysop can pin the host/port |
| No code evaluation | remote bytes are opaque data; the terminal never evaluates BBS-supplied content |
| Link sanitisation | OSC 8 hyperlinks are restricted to `http`, `https` and `telnet` and require confirmation before navigating |
| Sandbox | the embed page is served with a restrictive CSP and a sandboxed iframe |

---

## 10. Performance budget

| Metric | Target |
|---|---|
| Terminal throughput | > 1 Mbit/s of ANSI, 60 fps rendering |
| Parse cost | < 8 ms per 64 KiB chunk of ANSI |
| Render cost | < 4 ms per frame at 132×60 |
| Main-thread work | parsing and RIP run in a Web Worker; rendering uses OffscreenCanvas where available |
| Initial load | < 400 kB gzipped for the embed widget |

---

## 11. Accessibility

* The terminal is fully operable from the keyboard; every dialog has a focus
  trap and an Escape handler.
* A live region announces connection state, transfer progress and errors.
* A high-contrast theme is available and respects `prefers-contrast`.
* The screen reader can read the visible text via the "copy as text" action.

---

## 12. What changed after 1.9rc4

The upstream tree is at **1.10 alpha**, newer than the `1.9rc4` mentioned in the
original brief. Everything added since 1.9 is in scope:

| Change | Source | Status |
|---|---|---|
| ANSI parser overhaul | `src/conio/cterm.c` | `[x]` |
| Keystroke handling overhaul | `src/conio/cterm.c` | `[x]` |
| DECRQSS support to show/hide/customise the status line | `src/conio/cterm_dec.c` | `[x]` |
| New APC commands for audio and audio mixing | `src/conio/cterm_cterm.c` | `[~]` |
| 16-bit 44.1 kHz stereo audio | `src/syncterm/audio_apc.c` | `[~]` |
| Full OOB data support in RLogin modes | `src/syncterm/rlogin.c` | `[x]` |
| Alt + drag-select copies a rectangular region | `src/syncterm/term.c` | `[x]` |
| Prototype SFTP client | `src/syncterm/wren_bind_sftp.c` | `[ ]` |
| Wren scripting engine and REPL console | `src/syncterm/wren_*` | `[ ]` |
| Persistent Wren menu replacing the dialing directory UI | `src/syncterm/wren_menu_host.c` | `[ ]` |
| Process-wide INI themes with a theme editor | `src/syncterm/theme.c` | `[ ]` |
| Web theme catalog | `src/syncterm/theme_cloud.c` | `[ ]` |
| Ordered per-connection Wren script loading | `src/syncterm/scripts/` | `[ ]` |
| RGB/HSV colour picker for palette entries | `src/syncterm/wren_bind_menu.c` | `[x]` |
| PipeWire / PortAudio audio backends | `src/syncterm/audio_apc.c` | `[!]` (not applicable — the browser uses Web Audio) |
| Scaling, mirroring and clipping for graphics APC draws | `src/conio/cterm_cterm.c` | `[x]` |
| Wren pixel buffers, masks, image decoding and integer blitting | `src/syncterm/wren_bind_pixels.c` | `[~]` |

Items marked `[ ]` are **not** implemented in WebSyncTERM; they are scripting
or desktop-integration features with no browser equivalent. They are listed
here so the gap is explicit rather than silently omitted.

---

## 13. Source index

| Area | Upstream files |
|---|---|
| Terminal core | `src/conio/cterm.c`, `cterm_ecma48.c`, `cterm_cterm.c`, `cterm_dec.c`, `cterm_internal.h` |
| Terminal docs | `src/conio/cterm.adoc`, `src/conio/cterm.txt` |
| Other emulations | `src/conio/cterm_petscii.c`, `cterm_atascii.c`, `cterm_prestel.c`, `cterm_vt52.c` |
| Fonts | `src/conio/allfonts.c`, `src/conio/bitmap_con.c`, `src/syncterm/fonts.c`, `src/syncterm/fonts/` |
| Video modes | `src/conio/vidmodes.c`, `src/conio/ciolib.h` |
| Scaling | `src/conio/scale.c`, `src/conio/bitmap_con.c` |
| Connections | `src/syncterm/conn_telnet.c`, `telnet_io.c`, `ssh.c`, `rlogin.c`, `telnets.c` |
| Transfers | `src/sbbs3/xmodem.c`, `src/sbbs3/zmodem.c`, `src/syncterm/term.c` |
| RIP | `src/syncterm/ripper.c`, `src/syncterm/rip_icons.c` |
| Music | `src/conio/cterm.txt`, `src/syncterm/ooii_sounds.c` |
| Keys | `src/conio/cterm.c`, `src/conio/evdev_codes.h`, `src/syncterm/scripts/auto/connected/keys_default.wren` |
| Status line | `src/syncterm/scripts/auto/connected/status_default.wren`, `src/syncterm/term.c` |
