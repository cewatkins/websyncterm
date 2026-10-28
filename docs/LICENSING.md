# Licensing and Attribution

WebSyncTERM is a re-implementation of SyncTERM, which is part of Synchronet
(© Rob Swindell). This document records exactly what was taken from upstream,
what was re-implemented from the published specification, and what the
resulting licensing obligations are.

## 1. This project

WebSyncTERM is licensed under the **GNU General Public License, version 3 or
later** (GPL-3.0-or-later). This is compatible with the GPL-2.0-or-later and
LGPL-2.0-or-later terms under which the upstream sources are published, so the
project may incorporate, modify and redistribute upstream-derived material
provided the same terms apply.

## 2. Upstream licensing

| Component | Upstream path | Licence |
|---|---|---|
| Synchronet BBS | `src/sbbs3/` | GPL-2.0-or-later |
| SyncTERM (the application) | `src/syncterm/` | GPL-2.0-or-later |
| CIOLIB (the console library) | `src/conio/` | **LGPL-2.0-or-later** |
| XPDEV, SMBLIB, UIFC, XSDK | `src/xpdev/`, `src/smblib/`, `src/uifc/` | LGPL-2.0-or-later |
| XMODEM / ZMODEM | `src/sbbs3/xmodem.c`, `src/sbbs3/zmodem.c` | BSD-2-Clause |
| evdev key codes | `src/conio/evdev_codes.h` | BSD-2-Clause |
| `src/syncterm/wren/` | Wren scripting runtime | MIT |
| `src/ssh/` | DeuceSSH | BSD-2-Clause |

Upstream's own statement (`src/syncterm/LICENCE`):

> This program is free software; you can redistribute it and/or modify it
> under the terms of the GNU General Public License as published by the Free
> Software Foundation; either version 2 of the License, or (at your option) any
> later version.
>
> The files in the comio, conio, smblib, uifc, and xpdev are covered under the
> LGPL.

`src/syncterm/gpl.txt` is the GPL version 2; `docs/lgpl.txt` is the LGPL
version 2.1.

## 3. What was ported verbatim (data, not code)

| Item | Upstream path | Notes |
|---|---|---|
| 46 built-in code page bitmap fonts | `src/conio/allfonts.c` | The glyph **data** was mechanically extracted into `packages/render/assets/fonts/builtin-fonts.json` by `tools/extract-fonts.mjs`. No C code was copied. |
| 74 user-selectable bitmap fonts | `src/syncterm/fonts/*.fNN` | Copied byte-for-byte as binary assets. |
| The 282-entry DAC palette | `src/conio/vidmodes.c` | The colour values are facts, not creative expression; they are reproduced as data. |
| The CP437 → Unicode table | the IBM PC character set | A standard character mapping. |
| The RIP 64-colour EGA palette | `src/syncterm/ripper.c` | The classic EGA palette values. |

The extracted font data is a mechanical re-packaging of GPL'd upstream data and
is therefore covered by the GPL.

## 4. What was re-implemented from the specification

Everything else in this project was written from scratch in TypeScript, using
the **published behaviour** as the specification rather than the upstream
source as the source code. In particular:

| Area | Specification consulted |
|---|---|
| The CTerm escape-sequence set | `src/conio/cterm.adoc` (the normative CTerm manual) and `src/conio/cterm.txt` |
| Terminal emulation modes | `src/conio/cterm.h`'s `cterm_emulation_t` and the SyncTERM wiki |
| Screen modes and geometry | the `vparams[]` table in `src/conio/vidmodes.c` |
| Scaling and aspect correction | the documented behaviour of `src/conio/bitmap_con.c` |
| Telnet negotiation | RFC 854 / RFC 1073 / RFC 1091 and the documented SyncTERM behaviour |
| RLogin | RFC 1282 |
| XMODEM / YMODEM | the XMODEM/YMODEM protocol documentation and the published SyncTERM behaviour |
| ZMODEM | the ZMODEM protocol documentation (the ZDLE framing, the hex/binary headers, the subpacket types) |
| RIPscrip | the RIPscrip 1.54 specification and the documented RIPterm behaviour |
| ANSI music | the BANSI/TeleMate music format description in `src/conio/cterm.txt` |

Where upstream behaviour could only be determined by reading its source (for
example the exact RIPterm v1.54 pixel quirks), the behaviour was re-derived
and re-expressed in independent TypeScript rather than translated line by line.

## 5. Font provenance

The upstream source ships no separate licence or attribution for the bitmap
fonts. They are distributed as part of the GPL-licensed SyncTERM. The
provenance of the individual typefaces is therefore **unstated upstream** and
this project makes no stronger claim than upstream does.

Known provenance, stated conservatively:

* The CP437 / VGA / EGA sets derive from the IBM PC ROM fonts.
* The Commodore 64 set uses the "colorvic" values published by pepto.de.
* Topaz, Topaz Plus, MicroKnight, MicroKnight Plus, P0T NOoDLE and mO'sOul are
  Amiga-scene fonts that originate in the Amiga BBS community. Their authors
  are **not named anywhere in the upstream tree**, so no attribution is claimed
  here beyond their names.
* The Prestel font is an SAA5050 teletext font emulation.
* The `.fNN` user fonts are the classic PC/FE/FG collection (antique, big,
  block, broadway, computer, courier, deco, digital, future, gothic, ibmstd,
  lcd, lore, medieval, modern, prestel, reverse, roman, sans-serif, script,
  small caps, swiss, tekton, thick, thin, tiny, …), whose individual licences
  are likewise unstated upstream.

Because the fonts are redistributed under the GPL as part of this project,
they remain under the GPL with this project's terms.

## 6. Suggested attribution

> WebSyncTERM is a browser-based re-implementation of SyncTERM, the BBS
> terminal from Synchronet (© Rob Swindell), which is distributed under the
> GNU General Public License. The bitmap fonts are derived from the font data
> shipped with SyncTERM (© 2007 Stephen Hurd; Synchronet © Rob Swindell) and
> are used under the same terms.
>
> The Amiga fonts (Topaz, Topaz Plus, MicroKnight, MicroKnight Plus, P0T
> NOoDLE, mO'sOul) originated in the Amiga BBS scene; the copyright holders are
> not stated in the upstream source.

## 7. Third-party runtime dependencies

| Dependency | Licence |
|---|---|
| React / React DOM | MIT |
| Vite | MIT |
| TypeScript | Apache-2.0 |
| Vitest | MIT |
| Fastify | MIT |
| `ws` | MIT |
| `ssh2` | MIT |

All are permissively licensed and compatible with GPL-3.0-or-later.

## 8. Contributions

Contributions to WebSyncTERM are accepted under the GPL-3.0-or-later. By
contributing you confirm that you have the right to license the contribution
under those terms.
