/**
 * The CTerm-compatible terminal engine.
 *
 * This is a faithful re-implementation of the behaviour in
 * `src/conio/cterm.c`, `cterm_ecma48.c`, `cterm_cterm.c` and `cterm_dec.c`
 * from SynchronetBBS/sbbs (SyncTERM 1.10 / CTerm revision 1.332).
 *
 * The attribute model deliberately mirrors upstream:
 *   - `attr` is a byte: low nibble = foreground palette index,
 *     high nibble = background palette index,
 *     bit 3 (0x08) = "bold"/high intensity,
 *     bit 7 (0x80) = "blink".
 *   - `fgColor`/`bgColor` hold extended (256 colour) palette indices.
 *   - `negative` tracks SGR 7 separately so that SGR 27 can undo it.
 */

import { ScreenBuffer, Scrollback } from './buffer.js';
import { Palette, SHADOW_PALETTE_OFFSET } from './palette.js';
import { SixelDecoder } from './sixel.js';
import { byteToUnicode, Codepage, type CodepageName } from './charset.js';
import { TermEmulation, type TermEmulationName } from './types.js';
import type { CursorStyleName } from './types.js';

/** Maximum number of CSI parameters accepted, matching MAX_SEQ_PARAMS. */
export const MAX_SEQ_PARAMS = 64;

/**
 * Flag set on a colour value that carries a direct 24-bit RGB value rather
 * than a palette index (upstream `map_rgb()` sets bit 31).
 */
export const TRUECOLOR_FLAG = 0x80000000;

/** Parser states. */
const enum State {
	Ground = 0,
	Escape = 1,
	EscapeIntermediate = 2,
	CsiEntry = 3,
	CsiParam = 4,
	CsiIntermediate = 5,
	CsiIgnore = 6,
	OscString = 7,
	DcsEntry = 8,
	DcsParam = 9,
	DcsIntermediate = 10,
	DcsPassthrough = 11,
	DcsIgnore = 12,
	ApcString = 13,
	IgnoreString = 14,
}

/** Extended attribute flags (CTERM_EXTATTR_* in upstream). */
export const ExtAttr = {
	OriginMode: 1 << 0,
	AutoWrap: 1 << 1,
	CursorVisible: 1 << 2,
	AltChars: 1 << 3,
	NoBright: 1 << 4,
	BgBright: 1 << 5,
	BlinkAltChars: 1 << 6,
	NoBlink: 1 << 7,
	DecBkm: 1 << 8,
	DecLrmm: 1 << 9,
	SixelScroll: 1 << 10,
	X10Mouse: 1 << 11,
	NormalMouse: 1 << 12,
	ButtonMouse: 1 << 13,
	AnyMouse: 1 << 14,
	SgrMouse: 1 << 15,
	SgrPixelMouse: 1 << 16,
	BracketedPaste: 1 << 17,
	DoorwayMode: 1 << 18,
	PhysicalKeys: 1 << 19,
	SuppressKeys: 1 << 20,
	LcfEnabled: 1 << 21,
	LcfForced: 1 << 22,
	ExtendedPalette: 1 << 23,
} as const;

/** DECSET/DECRST private mode numbers handled by the engine. */
export const DecMode = {
	DecOm: 6,
	DecAwm: 7,
	X10Mouse: 9,
	DecCem: 25,
	AltChars: 31,
	NoBright: 32,
	BgBright: 33,
	BlinkAltChars: 34,
	NoBlink: 35,
	DecBkm: 67,
	DecLrmm: 69,
	SixelScroll: 80,
	NormalMouse: 1000,
	ButtonMouse: 1002,
	AnyMouse: 1003,
	SgrMouse: 1006,
	SgrPixelMouse: 1016,
	BracketedPaste: 2004,
} as const;

/** CTerm private mode numbers (the `CSI = Ps h` family). */
export const CtMode = {
	PhysicalKeys: 1,
	SuppressKeys: 2,
	LcfEnabled: 4,
	LcfForced: 5,
	Doorway: 255,
} as const;

/** Music introducer configuration (`CSI = Ps M`). */
export const MusicMode = {
	/** Only `CSI |` introduces music. */
	Cterm: 0,
	/** `CSI |` and `CSI N`. */
	Bansi: 1,
	/** `CSI |`, `CSI N` and `CSI M`. */
	Full: 2,
} as const;

export type MusicModeName = (typeof MusicMode)[keyof typeof MusicMode];

/** A parsed CSI/DCS parameter list. */
interface SeqParams {
	/** Numeric values; -1 means "omitted". */
	ints: number[];
	/** Raw text of each parameter (for DECRQSS SGR echo). */
	strs: string[];
	/** Sub-parameters (`:` separated) per parameter. */
	subs: number[][];
	/** Number of parameters actually present. */
	count: number;
}

/** Options accepted by the terminal. */
export interface CTermOptions {
	cols?: number;
	rows?: number;
	codepage?: CodepageName;
	/** Base palette (a BBS-supplied palette). */
	palette?: readonly number[];
	/** Scrollback rows retained. */
	scrollback?: number;
	/** Enable the 256-colour extended palette. */
	extendedPalette?: boolean;
	/** Called with bytes the terminal wants to send to the host. */
	onResponse?: (data: Uint8Array) => void;
	/** Called for APC strings. */
	onApc?: (payload: string) => void;
	/** Called when the screen size changes. */
	onResize?: (cols: number, rows: number) => void;
	/** Called when the title changes (OSC 0/2, currently ignored upstream). */
	onTitle?: (title: string) => void;
	/** Called when an OSC 8 hyperlink is opened by the user. */
	onHyperlink?: (uri: string) => void;
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

/**
 * The terminal engine.
 */
export class CTerm {
	readonly palette: Palette;

	cols: number;
	rows: number;
	screen!: ScreenBuffer;
	scrollback: Scrollback;

	/** Cursor position, 0-based. */
	xpos = 0;
	ypos = 0;
	/** Saved cursor position (DECSC/DECRC). */
	private savedX = 0;
	private savedY = 0;
	private savedValid = false;

	/** Current attribute byte (see the file header). */
	attr = 0x07;
	/** Extended foreground palette index (0..255) or -1. */
	fgColor = -1;
	/** Extended background palette index (0..255) or -1. */
	bgColor = -1;
	/** SGR 7 negative image. */
	negative = false;
	/** Raw SGR text for the foreground (DECRQSS). */
	fgTc: string | null = null;
	/** Raw SGR text for the background (DECRQSS). */
	bgTc: string | null = null;

	/** Extended attribute flags. */
	extattr = ExtAttr.AutoWrap | ExtAttr.CursorVisible | ExtAttr.DecBkm | ExtAttr.SixelScroll;

	/** Scroll region, 0-based inclusive. */
	scrollTop = 0;
	scrollBottom: number;

	/** Character and line tab stops. */
	charTabs = new Set<number>();
	lineTabs = new Set<number>();

	/** DECSDM-style status row state. */
	statusRowType = 1;

	/** Last column flag (LCF). */
	lcf = false;

	/** Cursor style (DECSCUSR). */
	cursorStyle: CursorStyleName = 'blinking-block';

	/** Music introducer mode. */
	musicMode: MusicModeName = MusicMode.Bansi;

	/** Output speed emulation (DECSCS): 0 = unlimited. */
	throttleSpeed = 0;

	/** DECSACE: 0/2 = rectangle, 1 = stream. */
	decsace = 0;

	/** Current hyperlink URI (OSC 8) and id. */
	hyperlinkUri = '';
	hyperlinkId = '';

	/** Macro storage (DECDMAC). */
	readonly macros = new Map<number, string>();

	/** The last graphic character, for REP. */
	private lastGraphic = -1;

	/** Doorway mode: the next byte is literal. */
	private doorwayNext = false;

	/** Music capture state. */
	private musicCapture: { buffer: string; active: boolean } | null = null;

	private state: State = State.Ground;
	private params: SeqParams = newSeqParams();
	private paramBuf = '';
	private paramOverflow = false;
	private intermediate = '';
	private oscBuf = '';
	private dcsBuf = '';
	private dcsKind: 'unknown' | 'sixel' | 'font' | 'mac' | 'decrqss' = 'unknown';
	private dcsStarted = false;
	private readonly sixel = new SixelDecoder();

	private codepage: CodepageName;
	private readonly opts: CTermOptions;

	/** The terminal emulation in use. */
	emulation: TermEmulationName = TermEmulation.AnsiBbs;

	/** Set of DEC modes currently enabled (for DECRQM and mode reports). */
	private readonly decModes = new Set<number>();
	/** Saved DEC mode set (CTSMS). */
	private savedDecModes: number[] | null = null;

	constructor(opts: CTermOptions = {}) {
		this.opts = opts;
		this.cols = opts.cols ?? 80;
		this.rows = opts.rows ?? 25;
		this.codepage = opts.codepage ?? Codepage.CP437;
		this.palette = new Palette();
		if (opts.palette) this.palette.setBase(opts.palette);
		this.scrollback = new Scrollback(opts.scrollback ?? 5000);
		this.screen = new ScreenBuffer(this.cols, this.rows);
		this.scrollBottom = this.rows - 1;
		this.extattr |= ExtAttr.ExtendedPalette;
		this.resetTabs();
	}

	// ---------------------------------------------------------------------
	// Configuration
	// ---------------------------------------------------------------------

	/** Change the screen size, preserving content where possible. */
	resize(cols: number, rows: number): void {
		if (cols === this.cols && rows === this.rows) return;
		const old = this.screen;
		const next = new ScreenBuffer(cols, rows);
		const copyRows = Math.min(rows, old.rows);
		const copyCols = Math.min(cols, old.cols);
		for (let y = 0; y < copyRows; y++) {
			for (let x = 0; x < copyCols; x++) {
				const i = y * cols + x;
				const j = y * old.cols + x;
				next.chars[i] = old.chars[j];
				next.fg[i] = old.fg[j];
				next.bg[i] = old.bg[j];
				next.flags[i] = old.flags[j];
				next.fgRgb[i] = old.fgRgb[j];
				next.bgRgb[i] = old.bgRgb[j];
			}
		}
		next.links = old.links;
		this.screen = next;
		this.cols = cols;
		this.rows = rows;
		this.scrollTop = 0;
		this.scrollBottom = rows - 1;
		this.xpos = Math.min(this.xpos, cols - 1);
		this.ypos = Math.min(this.ypos, rows - 1);
		this.resetTabs();
		this.opts.onResize?.(cols, rows);
	}

	/** Set the active code page. */
	setCodepage(cp: CodepageName): void {
		this.codepage = cp;
	}

	/** Set the terminal emulation. */
	setEmulation(emulation: TermEmulationName): void {
		this.emulation = emulation;
	}

	/** Whether DECBKM is set (backspace sends 0x08 rather than 0x7f). */
	get decBkm(): boolean {
		return (this.extattr & ExtAttr.DecBkm) !== 0;
	}

	/** Whether the cursor is visible. */
	get cursorVisible(): boolean {
		return (this.extattr & ExtAttr.CursorVisible) !== 0;
	}

	/** Get the active code page. */
	getCodepage(): CodepageName {
		return this.codepage;
	}

	/** Replace the first 16 palette entries (a BBS-supplied palette). */
	setBasePalette(colors: readonly number[]): void {
		this.palette.setBase(colors);
	}

	// ---------------------------------------------------------------------
	// Reset
	// ---------------------------------------------------------------------

	/** Reset the terminal to its initial state (RIS). */
	reset(): void {
		const forcedLcf = (this.extattr & ExtAttr.LcfForced) !== 0;
		this.screen.clear();
		this.xpos = 0;
		this.ypos = 0;
		this.attr = 0x07;
		this.fgColor = -1;
		this.bgColor = -1;
		this.negative = false;
		this.fgTc = null;
		this.bgTc = null;
		this.extattr = ExtAttr.AutoWrap | ExtAttr.CursorVisible | ExtAttr.DecBkm | ExtAttr.SixelScroll | ExtAttr.ExtendedPalette;
		if (forcedLcf) this.extattr |= ExtAttr.LcfForced | ExtAttr.LcfEnabled;
		this.decModes.clear();
		this.scrollTop = 0;
		this.scrollBottom = this.rows - 1;
		this.resetTabs();
		this.macros.clear();
		this.savedValid = false;
		this.hyperlinkUri = '';
		this.hyperlinkId = '';
		this.lastGraphic = -1;
		this.state = State.Ground;
		this.musicCapture = null;
		this.decsace = 0;
	}

	/** Reset the tab stops to the default every-8-columns arrangement. */
	resetTabs(): void {
		this.charTabs.clear();
		this.lineTabs.clear();
		for (let i = 8; i < this.cols; i += 8) this.charTabs.add(i);
	}

	// ---------------------------------------------------------------------
	// Output helpers
	// ---------------------------------------------------------------------

	private respond(text: string): void {
		this.opts.onResponse?.(new TextEncoder().encode(text));
	}

	private respondBytes(bytes: number[]): void {
		this.opts.onResponse?.(Uint8Array.from(bytes));
	}

	// ---------------------------------------------------------------------
	// Byte-level entry point
	// ---------------------------------------------------------------------

	/** Feed bytes from the host into the terminal. */
	write(data: Uint8Array): void {
		for (let i = 0; i < data.length; i++) {
			this.processByte(data[i]);
		}
	}

	/** Feed a string into the terminal (encoded as UTF-8). */
	writeString(text: string): void {
		this.write(new TextEncoder().encode(text));
	}

	private processByte(b: number): void {
		// Doorway mode: the byte after a NUL is literal.
		if (this.doorwayNext) {
			this.doorwayNext = false;
			this.putChar(b);
			return;
		}
		switch (this.state) {
			case State.Ground:
				this.ground(b);
				break;
			case State.Escape:
				this.escape(b);
				break;
			case State.EscapeIntermediate:
				this.escapeIntermediate(b);
				break;
			case State.CsiEntry:
			case State.CsiParam:
			case State.CsiIntermediate:
			case State.CsiIgnore:
				this.csi(b);
				break;
			case State.OscString:
				this.osc(b);
				break;
			case State.DcsEntry:
			case State.DcsParam:
			case State.DcsIntermediate:
				this.dcs(b);
				break;
			case State.DcsPassthrough:
				this.dcsPassthrough(b);
				break;
			case State.DcsIgnore:
				this.dcsIgnore(b);
				break;
			case State.ApcString:
				this.apc(b);
				break;
			case State.IgnoreString:
				this.ignoreString(b);
				break;
		}
	}

	// ---------------------------------------------------------------------
	// Ground state
	// ---------------------------------------------------------------------

	private ground(b: number): void {
		// An ANSI music string captures everything until SO (0x0e).
		if (this.musicCapture) {
			if (b === 0x0e) {
				this.endMusic();
			} else {
				this.pushMusic(b);
			}
			return;
		}
		switch (b) {
			case 0x00:
				if (this.extattr & ExtAttr.DoorwayMode) this.doorwayNext = true;
				return;
			case 0x07:
				// BEL - the host handles the bell.
				return;
			case 0x08:
				this.backspace();
				return;
			case 0x09:
				this.tab(1);
				return;
			case 0x0a:
				this.lineFeed();
				return;
			case 0x0b:
				// VT is printed as CP437 0x16 (a heart) in CTerm.
				this.putChar(0x16);
				return;
			case 0x0c:
				// FF - treated as a clear screen with the current attribute.
				this.clearScreenWithAttr();
				return;
			case 0x0d:
				this.xpos = 0;
				this.lcf = false;
				return;
			case 0x0e:
				// SO terminates an ANSI music string.
				this.endMusic();
				return;
			case 0x1b:
				this.state = State.Escape;
				this.intermediate = '';
				this.paramBuf = '';
				this.params = newSeqParams();
				this.paramOverflow = false;
				return;
			case 0x18:
				// CAN - aborts an escape sequence.
				this.state = State.Ground;
				return;
			case 0x1a:
				// SUB - aborts an escape sequence.
				this.state = State.Ground;
				return;
			default:
				if (b < 0x20) return;
				this.putChar(b);
		}
	}

	/**
	 * Write a printable character at the cursor, honouring wrapping.
	 *
	 * Upstream CTerm moves the cursor to the first column of the next line as
	 * soon as a character is written to the last column (unless LCF mode is
	 * enabled, in which case the cursor stays at the right margin until the
	 * next character arrives).
	 */
	private putChar(byte: number): void {
		this.lastGraphic = byte;
		if (this.lcf) {
			// The cursor is parked at the right margin; this character wraps.
			this.lcf = false;
			this.xpos = 0;
			this.lineFeed();
		} else if (this.xpos >= this.cols) {
			if (this.extattr & ExtAttr.AutoWrap) {
				this.xpos = 0;
				this.lineFeed();
			} else {
				this.xpos = this.cols - 1;
			}
		}
		this.writeCell(this.xpos, this.ypos, byte);
		if (this.xpos === this.cols - 1) {
			if (!(this.extattr & ExtAttr.AutoWrap)) {
				// No wrapping: the cursor stays and the cell is overwritten.
				this.xpos = this.cols - 1;
			} else if (this.extattr & ExtAttr.LcfEnabled) {
				// Last column flag: stay put until the next character.
				this.xpos = this.cols - 1;
				this.lcf = true;
			} else {
				this.xpos = 0;
				this.lineFeed();
			}
		} else {
			this.xpos++;
		}
	}

	/** Write the current attribute into a cell. */
	private writeCell(x: number, y: number, byte: number): void {
		const flags = this.attrFlags();
		const fg = this.fgIndex();
		const bg = this.bgIndex();
		const fgRgb = this.resolveColor(this.fgColor);
		const bgRgb = this.resolveColor(this.bgColor);
		const link = this.hyperlinkUri ? this.screen.internLink(this.hyperlinkUri, this.hyperlinkId) : -1;
		const i = y * this.cols + x;
		this.screen.chars[i] = byteToUnicode(byte, this.codepage);
		this.screen.fg[i] = fg;
		this.screen.bg[i] = bg;
		this.screen.flags[i] = flags;
		this.screen.fgRgb[i] = fgRgb;
		this.screen.bgRgb[i] = bgRgb;
		this.screen.linkId[i] = link;
		this.screen.dirty[i] = 1;
	}

	/** Resolve a colour value (palette index or truecolor) to 0xRRGGBB. */
	private resolveColor(value: number): number {
		if (value < 0) return 0;
		if (value & TRUECOLOR_FLAG) return value & 0xffffff;
		return this.palette.get(value);
	}

	/** Attribute flags for the current attribute byte. */
	private attrFlags(): number {
		let f = 0;
		if (this.attr & 0x08) f |= 1; // bold / high intensity
		if (this.attr & 0x80) f |= 2; // blink
		if (this.negative) f |= 4;
		return f;
	}

	/** Foreground palette index after applying the NOBRIGHT rule. */
	private fgIndex(): number {
		if (this.fgColor >= 0) return this.fgColor;
		let fg = this.attr & 0x0f;
		if (this.extattr & ExtAttr.NoBright) fg &= 0x07;
		return fg;
	}

	/** Background palette index after applying the BGBRIGHT rule. */
	private bgIndex(): number {
		if (this.bgColor >= 0) return this.bgColor;
		let bg = (this.attr >> 4) & 0x0f;
		if (!(this.extattr & ExtAttr.BgBright)) bg &= 0x07;
		return bg;
	}

	// ---------------------------------------------------------------------
	// Cursor movement primitives
	// ---------------------------------------------------------------------

	private backspace(): void {
		if (this.xpos > 0) this.xpos--;
		this.lcf = false;
	}

	private tab(count: number): void {
		for (let i = 0; i < count; i++) {
			const next = this.nextCharTab(this.xpos + 1);
			if (next === -1) {
				// No tab stops left: move to the first position of the next line.
				this.xpos = 0;
				this.lineFeed();
			} else {
				this.xpos = next;
			}
		}
		this.lcf = false;
	}

	/** Find the next character tab stop strictly after `from`, or -1. */
	private nextCharTab(from: number): number {
		let best = -1;
		for (const t of this.charTabs) {
			if (t > from && (best === -1 || t < best)) best = t;
		}
		return best;
	}

	/** Find the previous character tab stop strictly before `from`, or -1. */
	private prevCharTab(from: number): number {
		let best = -1;
		for (const t of this.charTabs) {
			if (t < from && t > best) best = t;
		}
		return best;
	}

	private lineFeed(): void {
		this.lcf = false;
		if (this.ypos === this.scrollBottom) {
			this.scrollUp(1);
		} else if (this.ypos < this.rows - 1) {
			this.ypos++;
		}
	}

	private reverseIndex(): void {
		this.lcf = false;
		if (this.ypos === this.scrollTop) {
			this.scrollDown(1);
		} else if (this.ypos > 0) {
			this.ypos--;
		}
	}

	/** Scroll the scroll region up by `n` lines. */
	private scrollUp(n: number): void {
		if (n <= 0) return;
		const top = this.scrollTop;
		const bottom = this.scrollBottom;
		const height = bottom - top + 1;
		if (height <= 0) return;
		n = Math.min(n, height);
		for (let i = 0; i < n; i++) this.scrollback.push(this.screen, top);
		const saved = new ScreenBuffer(this.cols, n);
		for (let i = 0; i < n; i++) saved.copyRowFrom(this.screen, top + i, i);
		for (let y = top; y <= bottom - n; y++) {
			this.screen.copyRowFrom(this.screen, y + n, y);
		}
		for (let y = bottom - n + 1; y <= bottom; y++) {
			this.eraseRow(y);
		}
	}

	/** Scroll the scroll region down by `n` lines. */
	private scrollDown(n: number): void {
		if (n <= 0) return;
		const top = this.scrollTop;
		const bottom = this.scrollBottom;
		const height = bottom - top + 1;
		if (height <= 0) return;
		n = Math.min(n, height);
		for (let y = bottom; y >= top + n; y--) {
			this.screen.copyRowFrom(this.screen, y - n, y);
		}
		for (let y = top; y < top + n; y++) this.eraseRow(y);
	}

	/** Erase a whole row using the current attribute. */
	private eraseRow(y: number): void {
		const fg = this.fgIndex();
		const bg = this.bgIndex();
		const flags = this.attrFlags();
		const fgRgb = this.resolveColor(this.fgColor);
		const bgRgb = this.resolveColor(this.bgColor);
		const base = y * this.cols;
		for (let x = 0; x < this.cols; x++) {
			this.screen.chars[base + x] = 0x20;
			this.screen.fg[base + x] = fg;
			this.screen.bg[base + x] = bg;
			this.screen.flags[base + x] = flags;
			this.screen.fgRgb[base + x] = fgRgb;
			this.screen.bgRgb[base + x] = bgRgb;
			this.screen.linkId[base + x] = -1;
			this.screen.dirty[base + x] = 1;
		}
	}

	/** Erase a range of cells using the current attribute. */
	private eraseCells(x0: number, y0: number, x1: number, y1: number): void {
		const fg = this.fgIndex();
		const bg = this.bgIndex();
		const flags = this.attrFlags();
		const fgRgb = this.resolveColor(this.fgColor);
		const bgRgb = this.resolveColor(this.bgColor);
		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) continue;
				const i = y * this.cols + x;
				this.screen.chars[i] = 0x20;
				this.screen.fg[i] = fg;
				this.screen.bg[i] = bg;
				this.screen.flags[i] = flags;
				this.screen.fgRgb[i] = fgRgb;
				this.screen.bgRgb[i] = bgRgb;
				this.screen.linkId[i] = -1;
				this.screen.dirty[i] = 1;
			}
		}
	}

	private clearScreenWithAttr(): void {
		for (let y = 0; y < this.rows; y++) this.eraseRow(y);
		this.xpos = 0;
		this.ypos = 0;
		this.lcf = false;
	}

	// ---------------------------------------------------------------------
	// ESC state
	// ---------------------------------------------------------------------

	private escape(b: number): void {
		// A non-ST escape inside a control string abandons the string and the
		// escape is processed normally.
		if (this.stringKind !== 'none' && b !== 0x5c) {
			this.stringKind = 'none';
			this.oscBuf = '';
			this.dcsBuf = '';
			this.state = State.Escape;
		}
		if (b >= 0x20 && b <= 0x2f) {
			this.intermediate += String.fromCharCode(b);
			this.state = State.EscapeIntermediate;
			return;
		}
		switch (b) {
			case 0x5b: // '['
				this.state = State.CsiEntry;
				this.params = newSeqParams();
				this.paramBuf = '';
				this.paramOverflow = false;
				this.intermediate = '';
				this.privatePrefix = '';
				return;
			case 0x5d: // ']'
				this.state = State.OscString;
				this.stringKind = 'osc';
				this.oscBuf = '';
				return;
			case 0x50: // 'P'
				this.stringKind = 'dcs';
				this.state = State.DcsEntry;
				this.params = newSeqParams();
				this.paramBuf = '';
				this.paramOverflow = false;
				this.intermediate = '';
				this.dcsBuf = '';
				this.dcsKind = 'unknown';
				this.dcsStarted = false;
				return;
			case 0x5f: // '_'
				this.state = State.ApcString;
				this.stringKind = 'apc';
				this.oscBuf = '';
				return;
			case 0x58: // 'X'
			case 0x5e: // '^'
				this.state = State.IgnoreString;
				this.oscBuf = '';
				return;
			case 0x5c: // '\' - ST
				this.finishString();
				return;
			case 0x37: // '7' DECSC
				this.saveCursor();
				this.state = State.Ground;
				return;
			case 0x38: // '8' DECRC
				this.restoreCursor();
				this.state = State.Ground;
				return;
			case 0x45: // 'E' NEL
				this.xpos = 0;
				this.lineFeed();
				this.state = State.Ground;
				return;
			case 0x48: // 'H' HTS
				this.charTabs.add(this.xpos);
				this.state = State.Ground;
				return;
			case 0x4a: // 'J' VTS
				this.lineTabs.add(this.ypos);
				this.state = State.Ground;
				return;
			case 0x4d: // 'M' RI
				this.reverseIndex();
				this.state = State.Ground;
				return;
			case 0x63: // 'c' RIS
				this.reset();
				this.state = State.Ground;
				return;
			case 0x46: // 'F' SSA
			case 0x47: // 'G' ESA
				this.state = State.Ground;
				return;
			case 0x53: // 'S' STS
				this.state = State.Ground;
				return;
			case 0x3a: // ':'
				this.state = State.Ground;
				return;
			default:
				this.state = State.Ground;
				return;
		}
	}

	private escapeIntermediate(b: number): void {
		if (b >= 0x20 && b <= 0x2f) {
			this.intermediate += String.fromCharCode(b);
			return;
		}
		// Only ESC intermediates that are not otherwise handled.
		this.state = State.Ground;
	}

	// ---------------------------------------------------------------------
	// CSI state
	// ---------------------------------------------------------------------

	private csi(b: number): void {
		if (b >= 0x30 && b <= 0x39) {
			if (this.state === State.CsiIntermediate || this.state === State.CsiIgnore) return;
			this.state = State.CsiParam;
			this.paramBuf += String.fromCharCode(b);
			if (this.paramBuf.length > 32) this.paramOverflow = true;
			return;
		}
		if (b === 0x3b) {
			// ';'
			if (this.state === State.CsiIntermediate || this.state === State.CsiIgnore) return;
			this.state = State.CsiParam;
			this.commitParam();
			return;
		}
		if (b === 0x3a) {
			// ':' - sub-parameter separator; kept verbatim in the raw text.
			if (this.state === State.CsiIntermediate || this.state === State.CsiIgnore) return;
			this.state = State.CsiParam;
			this.paramBuf += ':';
			return;
		}
		if (b >= 0x3c && b <= 0x3f) {
			// Private parameter prefix.
			if (this.state !== State.CsiEntry) return;
			this.state = State.CsiParam;
			this.paramBuf += String.fromCharCode(b);
			return;
		}
		if (b >= 0x20 && b <= 0x2f) {
			this.intermediate += String.fromCharCode(b);
			this.state = State.CsiIntermediate;
			return;
		}
		if (b >= 0x40 && b <= 0x7e) {
			this.commitParam();
			this.state = State.Ground;
			this.dispatchCsi(String.fromCharCode(b));
			return;
		}
		// Anything else aborts the sequence.
		this.state = State.Ground;
	}

	private commitParam(): void {
		const p = this.params;
		if (p.count >= MAX_SEQ_PARAMS) {
			this.paramOverflow = true;
			return;
		}
		let raw = this.paramBuf;
		// A private parameter prefix (<, =, >, ?) may only appear on the first
		// parameter; strip it and remember it.
		if (p.count === 0 && raw.length > 0) {
			const c = raw[0];
			if (c === '<' || c === '=' || c === '>' || c === '?') {
				this.privatePrefix = c;
				raw = raw.slice(1);
			}
		}
		p.strs.push(raw);
		const subs: number[] = [];
		for (const piece of raw.split(':')) {
			const v = piece === '' ? -1 : parseInt(piece, 10);
			subs.push(Number.isNaN(v) ? -1 : v);
		}
		p.subs.push(subs);
		const first = subs[0] ?? -1;
		p.ints.push(first);
		p.count++;
		this.paramBuf = '';
	}

	/** The private parameter prefix of the current sequence ('' when absent). */
	private privatePrefix = '';


	/** Parameter `i` (1-based, as used in the upstream docs). */
	private param(i: number, def = 1): number {
		if (this.paramOverflow) return def;
		const v = this.params.ints[i - 1];
		if (v === undefined || v < 0) return def;
		return v;
	}

	/** Parameter `i` with a default of 0 and no clamping to 1. */
	private param0(i: number, def = 0): number {
		if (this.paramOverflow) return def;
		const v = this.params.ints[i - 1];
		if (v === undefined || v < 0) return def;
		return v;
	}

	/** True when the parameter at `i` was explicitly provided. */
	private hasParam(i: number): boolean {
		if (this.paramOverflow) return false;
		return this.params.ints[i - 1] !== undefined && this.params.ints[i - 1] >= 0;
	}

	// ---------------------------------------------------------------------
	// OSC / APC / string states
	// ---------------------------------------------------------------------

	private osc(b: number): void {
		if (b === 0x07) {
			// BEL aborts an OSC string (it does not terminate it).
			this.state = State.Ground;
			return;
		}
		if (b === 0x1b) {
			this.state = State.Escape;
			this.intermediate = '';
			return;
		}
		if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return;
		this.oscBuf += String.fromCharCode(b);
		if (this.oscBuf.length > 8192) this.oscBuf = '';
	}

	private apc(b: number): void {
		if (b === 0x1b) {
			this.state = State.Escape;
			this.intermediate = '';
			return;
		}
		if (b < 0x08 || b > 0x7e) return;
		this.oscBuf += String.fromCharCode(b);
		if (this.oscBuf.length > 1 << 20) this.oscBuf = '';
	}

	private ignoreString(b: number): void {
		if (b === 0x1b) {
			this.state = State.Escape;
			this.intermediate = '';
			return;
		}
	}

	// ---------------------------------------------------------------------
	// DCS state
	// ---------------------------------------------------------------------

	private dcs(b: number): void {
		if (b >= 0x30 && b <= 0x39) {
			this.state = State.DcsParam;
			this.paramBuf += String.fromCharCode(b);
			return;
		}
		if (b === 0x3b) {
			this.state = State.DcsParam;
			this.commitParam();
			return;
		}
		if (b >= 0x3c && b <= 0x3f) {
			this.state = State.DcsParam;
			this.paramBuf += String.fromCharCode(b);
			return;
		}
		if (b >= 0x20 && b <= 0x2f) {
			this.intermediate += String.fromCharCode(b);
			this.state = State.DcsIntermediate;
			return;
		}
		if (b >= 0x40 && b <= 0x7e) {
			this.commitParam();
			this.dcsFinal = String.fromCharCode(b);
			this.state = State.DcsPassthrough;
			this.dcsStarted = true;
			this.beginDcs();
			return;
		}
		this.state = State.DcsIgnore;
	}

	private dcsFinal = '';

	private beginDcs(): void {
		const final = this.dcsFinal;
		const params = this.params.ints.map((v) => (v < 0 ? 0 : v));
		if (final === 'q') {
			this.dcsKind = 'sixel';
			this.sixel.reset({
				p1: params[0] ?? 0,
				p2: params[1] ?? 0,
				originX: this.xpos,
				originY: this.ypos,
				scrolling: (this.extattr & ExtAttr.SixelScroll) !== 0,
				palette: this.palette,
				fg: this.fgIndex(),
				bg: this.bgIndex(),
			});
			return;
		}
		if (final === 'z' && this.intermediate === '!') {
			this.dcsKind = 'mac';
			this.dcsBuf = '';
			return;
		}
		if (final === 'q' && this.intermediate === '$') {
			this.dcsKind = 'decrqss';
			this.dcsBuf = '';
			return;
		}
		if (final === 'z' && this.intermediate === '!') {
			this.dcsKind = 'mac';
			return;
		}
		// "CTerm:Font:<slot>:<base64>"
		this.dcsKind = 'unknown';
	}

	private dcsPassthrough(b: number): void {
		if (b === 0x1b) {
			this.state = State.Escape;
			this.intermediate = '';
			return;
		}
		if (this.dcsKind === 'sixel') {
			this.sixel.feed(b);
			return;
		}
		if (b < 0x08 || b > 0x7e) {
			// Illegal byte inside a command string aborts it.
			this.state = State.Ground;
			this.dcsKind = 'unknown';
			return;
		}
		this.dcsBuf += String.fromCharCode(b);
		if (this.dcsBuf.length > 1 << 20) this.dcsBuf = '';
	}

	private dcsIgnore(b: number): void {
		if (b === 0x1b) {
			this.state = State.Escape;
			this.intermediate = '';
			return;
		}
	}

	/**
	 * Finish a string sequence.
	 *
	 * Called when ESC \ is seen (or when the parser returns to the ground state
	 * from an ESC that turned out to be a string terminator).
	 */
	private finishString(): void {
		const kind = this.stringKind;
		this.stringKind = 'none';
		this.state = State.Ground;
		switch (kind) {
			case 'osc':
				this.handleOsc(this.oscBuf);
				this.oscBuf = '';
				return;
			case 'apc':
				this.opts.onApc?.(this.oscBuf);
				this.oscBuf = '';
				return;
			case 'dcs':
				this.finishDcs();
				return;
			default:
				return;
		}
	}

	/** Which kind of control string is being collected, if any. */
	private stringKind: 'none' | 'osc' | 'apc' | 'dcs' = 'none';

	private finishDcs(): void {
		switch (this.dcsKind) {
			case 'sixel':
				this.applySixel();
				break;
			case 'mac':
				this.storeMacro();
				break;
			case 'decrqss':
				this.answerDecrqss(this.dcsBuf);
				break;
			default:
				break;
		}
		this.dcsKind = 'unknown';
		this.dcsBuf = '';
	}

	private storeMacro(): void {
		const num = this.param0(1, 0);
		const mode = this.param0(2, 0);
		const format = this.param0(3, 0);
		if (mode === 1) {
			this.macros.clear();
			return;
		}
		if (num < 0 || num > 63) return;
		if (mode === 0) this.macros.delete(num);
		const body = format === 1 ? decodeHexMacro(this.dcsBuf) : this.dcsBuf;
		this.macros.set(num, body);
	}

	private answerDecrqss(pt: string): void {
		const value = this.decrqssValue(pt);
		if (value === null) {
			this.respond(`\x1bP0$r${pt}\x1b\\`);
			return;
		}
		this.respond(`\x1bP1$r${value}${pt}\x1b\\`);
	}

	private decrqssValue(pt: string): string | null {
		switch (pt) {
			case 'm':
				return this.sgrReport();
			case 'r':
				return `${this.scrollTop + 1};${this.scrollBottom + 1}`;
			case 's':
				return `1;${this.cols}`;
			case 't':
				return `${this.rows}`;
			case '$|':
				return `${this.cols}`;
			case '*|':
				return `${this.rows}`;
			case ' q':
				return this.cursorStyle === 'steady-block' || this.cursorStyle === 'steady-underline' ? '2' : '1';
			case '*r':
				return `;${this.throttleSpeed}`;
			case '*x':
				return `${this.decsace}`;
			case '$~':
				return `${this.statusRowType}`;
			case '$}':
				return '0';
			default:
				return null;
		}
	}

	/** Build the DECRQSS SGR report. */
	private sgrReport(): string {
		let out = '0';
		if (this.attr & 0x08) out += ';1';
		if (this.attr & 0x80) out += ';5';
		if (this.negative) out += ';7';
		const fg = this.attr & 0x0f;
		if (fg <= 6) out += `;3${fg}`;
		if (this.fgTc) out += `;${this.fgTc}`;
		const bg = (this.attr >> 4) & 0x0f;
		if (bg >= 1 && bg <= 7) out += `;4${bg}`;
		if (this.bgTc) out += `;${this.bgTc}`;
		return out;
	}

	// ---------------------------------------------------------------------
	// OSC handling
	// ---------------------------------------------------------------------

	private handleOsc(payload: string): void {
		const semi = payload.indexOf(';');
		const code = semi === -1 ? payload : payload.slice(0, semi);
		const rest = semi === -1 ? '' : payload.slice(semi + 1);
		switch (code) {
			case '4':
				this.oscPalette(rest);
				return;
			case '104':
				this.oscResetPalette(rest);
				return;
			case '10':
			case '11':
				this.oscQueryColour(code);
				return;
			case '8':
				this.oscHyperlink(rest);
				return;
			case '0':
			case '2':
				this.opts.onTitle?.(rest);
				return;
			default:
				return;
		}
	}

	private oscPalette(rest: string): void {
		const parts = rest.split(';');
		for (let i = 0; i + 1 < parts.length; i += 2) {
			const index = parseInt(parts[i], 10);
			if (!Number.isFinite(index) || index < 0 || index > 13200) return;
			const spec = parts[i + 1];
			if (spec === '?') {
				const rgb = this.palette.getDac(index);
				this.respond(`\x1b]4;${index};${formatRgbReply(rgb)}\x1b\\`);
				continue;
			}
			const rgb = parseRgbSpec(spec);
			if (rgb !== null) this.palette.setDac(index, rgb);
		}
	}

	private oscResetPalette(rest: string): void {
		if (rest === '') {
			this.palette.resetAll();
			return;
		}
		for (const part of rest.split(';')) {
			const index = parseInt(part, 10);
			if (Number.isFinite(index)) this.palette.reset(index + SHADOW_PALETTE_OFFSET);
		}
	}

	private oscQueryColour(which: '10' | '11'): void {
		const offset = this.extattr & ExtAttr.ExtendedPalette ? 16 : 0;
		const entry = which === '10' ? 7 + offset : offset;
		const rgb = this.palette.getDac(which === '10' ? 7 : 0);
		this.respond(`\x1b]${which};${formatRgbReply(rgb)}\x1b\\`);
	}

	private oscHyperlink(rest: string): void {
		const semi = rest.indexOf(';');
		const params = semi === -1 ? rest : rest.slice(0, semi);
		const uri = semi === -1 ? '' : rest.slice(semi + 1);
		if (uri === '') {
			this.hyperlinkUri = '';
			this.hyperlinkId = '';
			return;
		}
		const idMatch = /(?:^|:)id=([^:]*)/.exec(params);
		this.hyperlinkId = idMatch ? idMatch[1] : '';
		this.hyperlinkUri = uri;
	}

	// ---------------------------------------------------------------------
	// Sixel
	// ---------------------------------------------------------------------

	private applySixel(): void {
		const img = this.sixel.finish();
		if (!img) return;
		const cw = 8;
		const ch = 16;
		const baseX = this.extattr & ExtAttr.SixelScroll ? img.baseX : 0;
		const baseY = this.extattr & ExtAttr.SixelScroll ? img.baseY : 0;
		const pixels = img.pixels;
		const width = img.width;
		const height = img.height;
		for (let py = 0; py < height; py++) {
			const screenY = baseY + py;
			if (screenY < 0) continue;
			const row = Math.floor(screenY / ch);
			if (row >= this.rows) continue;
			for (let px = 0; px < width; px++) {
				const screenX = baseX + px;
				if (screenX < 0) continue;
				const col = Math.floor(screenX / cw);
				if (col >= this.cols) continue;
				const value = pixels[py * width + px];
				if (value < 0) continue;
				this.screen.dirty[row * this.cols + col] = 1;
			}
		}
		this.sixelPixels = { pixels, width, height, baseX, baseY, cw, ch };
		if (this.extattr & ExtAttr.SixelScroll) {
			const newX = Math.max(0, Math.min(this.cols - 1, Math.floor(img.cursorX / cw) + (img.baseX / cw) - (this.xpos - 1)));
			const newY = Math.max(0, Math.min(this.rows - 1, Math.floor(img.cursorY / ch) + (img.baseY / ch) - (this.ypos - 1)));
			this.xpos = newX;
			this.ypos = newY;
		}
	}

	/** The last decoded sixel image, for the renderer. */
	sixelPixels: {
		pixels: Int32Array;
		width: number;
		height: number;
		baseX: number;
		baseY: number;
		cw: number;
		ch: number;
	} | null = null;

	// ---------------------------------------------------------------------
	// ANSI music
	// ---------------------------------------------------------------------

	/** Begin capturing an ANSI music string. */
	private beginMusic(): void {
		this.musicCapture = { buffer: '', active: true };
	}

	private endMusic(): void {
		this.musicCapture = null;
	}

	/** The music string currently being captured, if any. */
	get musicString(): string | null {
		return this.musicCapture?.buffer ?? null;
	}

	/** Append a byte to the music capture buffer. */
	pushMusic(byte: number): void {
		if (!this.musicCapture) return;
		const allowed = 'aAbBcCdDeEfFgGlLmMnNoOpPsStT0123456789.-+#<> ';
		const ch = String.fromCharCode(byte);
		if (!allowed.includes(ch)) {
			this.endMusic();
			return;
		}
		this.musicCapture.buffer += ch;
	}

	// ---------------------------------------------------------------------
	// Dispatch
	// ---------------------------------------------------------------------

	private dispatchCsi(final: string): void {
		const pfx = this.privatePrefix;
		switch (pfx) {
			case '=':
				this.dispatchCsiEqual(final);
				return;
			case '?':
				this.dispatchCsiPrivate(final);
				return;
			case '<':
				this.dispatchCsiLess(final);
				return;
			default:
				this.dispatchCsiPlain(final);
				return;
		}
	}

	private dispatchCsiPlain(final: string): void {
		if (this.intermediate === ' ') {
			this.dispatchCsiSpace(final);
			return;
		}
		if (this.intermediate === '$' || this.intermediate === '*' || this.intermediate === "'") {
			this.dispatchCsiIntermediate(final);
			return;
		}
		switch (final) {
			case '@':
				this.insertChars(this.param(1, 1));
				break;
			case 'A':
				this.cursorUp(this.param(1, 1));
				this.lcf = false;
				break;
			case 'B':
				this.cursorDown(this.param(1, 1));
				this.lcf = false;
				break;
			case 'C':
				this.cursorForward(this.param(1, 1));
				break;
			case 'D':
				this.cursorBack(this.param(1, 1));
				break;
			case 'E':
				this.cursorNextLine(this.param(1, 1));
				break;
			case 'F':
				this.cursorPrevLine(this.param(1, 1));
				break;
			case 'G':
			case '`':
				this.cursorToColumn(this.param(1, 1) - 1);
				break;
			case 'H':
			case 'f':
				// CUP is "row;column".
				this.cursorTo(this.param(2, 1) - 1, this.param(1, 1) - 1);
				this.lcf = false;
				break;
			case 'I':
				this.chtab(this.param(1, 1));
				break;
			case 'J':
				this.eraseInDisplay(this.param0(1, 0));
				this.lcf = false;
				break;
			case 'K':
				this.eraseInLine(this.param0(1, 0));
				this.lcf = false;
				break;
			case 'L':
				this.insertLines(this.param(1, 1));
				break;
			case 'M':
				if (this.musicMode === MusicMode.Full && this.params.count === 0) {
					this.beginMusic();
				} else {
					this.deleteLines(this.param(1, 1));
				}
				break;
			case 'N':
				if (this.musicMode >= MusicMode.Bansi) {
					this.beginMusic();
				}
				break;
			case 'P':
				this.deleteChars(this.param(1, 1));
				break;
			case 'S':
				this.scrollUp(this.param(1, 1));
				break;
			case 'T':
				this.scrollDown(this.param(1, 1));
				break;
			case 'X':
				this.eraseChars(this.param(1, 1));
				this.lcf = false;
				break;
			case 'Y':
				this.vtab(this.param(1, 1));
				break;
			case 'Z':
				this.cbt(this.param(1, 1));
				break;
			case 'a':
				this.cursorForward(this.param(1, 1));
				this.lcf = false;
				break;
			case 'b':
				this.repeatLast(this.param(1, 1));
				break;
			case 'c':
				this.deviceAttributes();
				break;
			case 'd':
				this.cursorToRow(this.param(1, 1) - 1);
				break;
			case 'e':
				this.cursorDown(this.param(1, 1));
				break;
			case 'g':
				this.clearTabs(this.param0(1, 0));
				break;
			case 'h':
				this.setMode(this.params.ints);
				break;
			case 'l':
				this.resetMode(this.params.ints);
				break;
			case 'm':
				this.selectGraphicRendition();
				break;
			case 'n':
				this.deviceStatusReport(this.param0(1, 0));
				break;
			case 'p':
				break;
			case 'r':
				this.setScrollRegion(this.param(1, 1) - 1, this.param(2, this.rows) - 1);
				this.lcf = false;
				break;
			case 's':
				if (this.extattr & ExtAttr.DecLrmm) {
					this.setLeftRightMargins(this.param(1, 1) - 1, this.param(2, this.cols) - 1);
				} else {
					this.saveCursor();
				}
				break;
			case 'u':
				this.restoreCursor();
				break;
			case 't':
				this.ct24bc();
				break;
			case '|':
				this.beginMusic();
				break;
			case 'x':
				this.decrqssOrSpecial(final);
				break;
			case 'y':
				break;
			case 'z':
				this.invokeMacro(this.param0(1, 0));
				break;
			case 'w':
				this.tabStopReport();
				break;
			case 'q':
				if (this.intermediate === ' ') {
					this.setCursorStyle(this.param0(1, 1));
				}
				break;
			case ' ':
				// Handled via the intermediate space.
				break;
			default:
				break;
		}
	}

	/**
	 * Sequences with a single space intermediate.
	 *
	 *  `CSI Pn SP @`  SL   - scroll left
	 *  `CSI Pn SP A`  SR   - scroll right
	 *  `CSI Pn SP D`  FNT  - font selection
	 *  `CSI Pn SP d`  TSR  - tab stop remove
	 */
	/**
	 * Sequences with a `$`, `*` or `'` intermediate.
	 *
	 *  `CSI Ps $ p`        DECRQM
	 *  `CSI Pt;Pl;Pb;Pr $ x` DECFRA   `CSI Pt;Pl;Pb;Pr $ z` DECERA
	 *  `CSI Pt;Pl;Pb;Pr;Ps $ r` DECCARA   `CSI Pt;Pl;Pb;Pr;Ps $ t` DECRARA
	 *  `CSI Ps * x`        DECSACE
	 *  `CSI Ps $ }`        DECSASD   `CSI Ps $ ~`  DECSSDT
	 *  `CSI Pn ' }`        DECIC     `CSI Pn ' ~`  DECDC
	 */
	private dispatchCsiIntermediate(final: string): void {
		switch (this.intermediate) {
			case '$':
				switch (final) {
					case 'p':
						this.decrqmAnsi();
						return;
					case 'x':
						this.fillRect(this.param(1, 1) - 1, this.param(2, 1) - 1, this.param(3, this.rows) - 1, this.param(4, this.cols) - 1, this.param0(1, 0));
						return;
					case 'z':
						this.eraseRect(this.param(1, 1) - 1, this.param(2, 1) - 1, this.param(3, this.rows) - 1, this.param(4, this.cols) - 1);
						return;
					case 'r':
						this.changeRectAttrs(this.param(1, 1) - 1, this.param(2, 1) - 1, this.param(3, this.rows) - 1, this.param(4, this.cols) - 1, this.params.ints.slice(4).filter((v) => v >= 0));
						return;
					case 't':
						this.reverseRectAttrs(this.param(1, 1) - 1, this.param(2, 1) - 1, this.param(3, this.rows) - 1, this.param(4, this.cols) - 1, this.params.ints.slice(4).filter((v) => v >= 0));
						return;
					case '}':
						this.statusRowTarget = this.param0(1, 0);
						return;
					case '~':
						this.setStatusRowType(this.param0(1, 1));
						return;
					default:
						return;
				}
			case '*':
				if (final === 'x') this.decsace = this.param0(1, 0);
				return;
			case "'":
				switch (final) {
					case '}':
						this.insertColumns(this.param(1, 1));
						return;
					case '~':
						this.deleteColumns(this.param(1, 1));
						return;
					default:
						return;
				}
			default:
				return;
		}
	}

	private statusRowTarget = 0;

	private setStatusRowType(type: number): void {
		if (type < 0 || type > 2) return;
		if (type === this.statusRowType) return;
		this.statusRowType = type;
		this.opts.onResize?.(this.cols, this.rows);
	}

	private insertColumns(n: number): void {
		if (n < 1) return;
		if (this.ypos < this.scrollTop || this.ypos > this.scrollBottom) return;
		for (let y = this.scrollTop; y <= this.scrollBottom; y++) {
			for (let x = this.cols - 1; x >= this.xpos + n; x--) this.copyCell(y, x - n, y, x);
			for (let x = this.xpos; x < this.xpos + n; x++) this.eraseCell(y, x);
		}
	}

	private deleteColumns(n: number): void {
		if (n < 1) return;
		if (this.ypos < this.scrollTop || this.ypos > this.scrollBottom) return;
		for (let y = this.scrollTop; y <= this.scrollBottom; y++) {
			for (let x = this.xpos; x < this.cols; x++) {
				if (x + n < this.cols) this.copyCell(y, x + n, y, x);
				else this.eraseCell(y, x);
			}
		}
	}

	/** DECRQM for the ANSI (non-private) mode set. */
	private decrqmAnsi(): void {
		const ps = this.param0(1, 0);
		let pm = 0;
		switch (ps) {
			case 1:
			case 2:
			case 3:
			case 4:
			case 5:
			case 6:
			case 7:
			case 8:
			case 9:
			case 10:
			case 11:
			case 12:
			case 13:
			case 15:
			case 17:
			case 18:
				pm = 4;
				break;
			case 14:
				pm = 1;
				break;
			case 16:
				pm = 2;
				break;
			case 21:
			case 22:
				pm = 3;
				break;
			default:
				pm = 0;
				break;
		}
		this.respond(`\x1b[${ps};${pm}$y`);
	}

	/** Toggle attributes within a rectangle (DECRARA). */
	private reverseRectAttrs(top: number, left: number, bottom: number, right: number, params: number[]): void {
		if (bottom < top || right < left) return;
		const t = Math.max(0, top);
		const l = Math.max(0, left);
		const b = Math.min(this.rows - 1, bottom);
		const r = Math.min(this.cols - 1, right);
		for (let y = t; y <= b; y++) {
			for (let x = l; x <= r; x++) {
				const i = y * this.cols + x;
				let f = this.screen.flags[i];
				if (params.includes(0)) {
					f ^= 3; // bold + blink
					const fg = this.screen.fg[i] & 0x0f;
					const bg = this.screen.bg[i] & 0x0f;
					this.screen.fg[i] = bg;
					this.screen.bg[i] = fg;
				}
				if (params.includes(1) || params.includes(22)) f ^= 1;
				if (params.includes(5) || params.includes(25)) f ^= 2;
				if (params.includes(7) || params.includes(27)) {
					const fg = this.screen.fg[i] & 0x0f;
					const bg = this.screen.bg[i] & 0x0f;
					this.screen.fg[i] = bg;
					this.screen.bg[i] = fg;
				}
				this.screen.flags[i] = f;
				this.screen.dirty[i] = 1;
			}
		}
	}

	private dispatchCsiSpace(final: string): void {
		switch (final) {
			case '@':
				this.scrollLeft(this.param(1, 1));
				break;
			case 'A':
				this.scrollRight(this.param(1, 1));
				break;
			case 'D':
				this.selectFont(this.param(1, 0), this.param(2, 0));
				break;
			case 'd':
				if (this.hasParam(1)) this.charTabs.delete(this.param(1, 0));
				break;
			default:
				break;
		}
	}

	private dispatchCsiEqual(final: string): void {
		switch (final) {
			case 'h':
				this.setCtMode(this.params.ints, true);
				break;
			case 'l':
				this.setCtMode(this.params.ints, false);
				break;
			case 'K':
			case 'k':
				break;
			case 'M':
				this.musicMode = this.param0(1, 0) as MusicModeName;
				break;
			case 'n':
				this.ctermStateReport(this.param0(1, 1));
				break;
			case 'p':
				this.decrqmCt();
				break;
			case '{':
				this.ctosf();
				break;
			default:
				break;
		}
	}

	private dispatchCsiPrivate(final: string): void {
		switch (final) {
			case 'h':
				this.setDecMode(this.params.ints, true);
				break;
			case 'l':
				this.setDecMode(this.params.ints, false);
				break;
			case 'n':
				this.decdsr();
				break;
			case 'p':
				this.decrqmPrivate();
				break;
			case 'r':
				this.ctermSaveModes();
				break;
			case 's':
				this.ctermSaveModes();
				break;
			case 'u':
				this.ctermRestoreModes();
				break;
			case 'S':
				this.xtermGraphicsAttributes();
				break;
			default:
				break;
		}
	}

	private dispatchCsiLess(final: string): void {
		if (final === 'c') this.ctermDeviceAttributes();
	}

	// ---------------------------------------------------------------------
	// Cursor operations
	// ---------------------------------------------------------------------

	/** The maximum X coordinate, honouring origin mode. */
	private get maxX(): number {
		return this.extattr & ExtAttr.OriginMode ? this.scrollRightEdge() : this.cols - 1;
	}

	/** The maximum Y coordinate, honouring origin mode. */
	private get maxY(): number {
		return this.extattr & ExtAttr.OriginMode ? this.scrollBottom : this.rows - 1;
	}

	private scrollRightEdge(): number {
		return this.cols - 1;
	}

	private cursorUp(n: number): void {
		if (n < 1) return;
		const limit = this.extattr & ExtAttr.OriginMode ? this.scrollTop : 0;
		this.ypos = Math.max(limit, this.ypos - n);
	}

	private cursorDown(n: number): void {
		if (n < 1) return;
		const limit = this.extattr & ExtAttr.OriginMode ? this.scrollBottom : this.rows - 1;
		this.ypos = Math.min(limit, this.ypos + n);
	}

	private cursorForward(n: number): void {
		if (n < 1) return;
		this.xpos = Math.min(this.maxX, this.xpos + n);
	}

	private cursorBack(n: number): void {
		if (n < 1) return;
		this.xpos = Math.max(0, this.xpos - n);
	}

	private cursorNextLine(n: number): void {
		if (n < 1) return;
		this.xpos = 0;
		this.ypos = Math.min(this.maxY, this.ypos + n);
	}

	private cursorPrevLine(n: number): void {
		if (n < 1) return;
		this.xpos = 0;
		this.ypos = Math.max(0, this.ypos - n);
	}

	private cursorToColumn(x: number): void {
		if (x < 0 || x > this.maxX) return;
		this.xpos = x;
	}

	private cursorToRow(y: number): void {
		const base = this.extattr & ExtAttr.OriginMode ? this.scrollTop : 0;
		const y2 = base + y;
		if (y2 < base || y2 > this.maxY) return;
		this.ypos = y2;
	}

	private cursorTo(x: number, y: number): void {
		const base = this.extattr & ExtAttr.OriginMode ? this.scrollTop : 0;
		const ny = base + y;
		const nx = x;
		if (ny < base || ny > this.maxY) return;
		if (nx < 0 || nx > this.maxX) return;
		this.ypos = ny;
		this.xpos = nx;
	}

	private saveCursor(): void {
		this.savedX = this.xpos;
		this.savedY = this.ypos;
		this.savedValid = true;
	}

	private restoreCursor(): void {
		if (!this.savedValid) return;
		if (this.savedX < 0 || this.savedX > this.maxX) return;
		if (this.savedY < 0 || this.savedY > this.maxY) return;
		this.xpos = this.savedX;
		this.ypos = this.savedY;
	}

	// ---------------------------------------------------------------------
	// Editing operations
	// ---------------------------------------------------------------------

	private insertChars(n: number): void {
		if (n < 1) return;
		if (this.ypos < this.scrollTop || this.ypos > this.scrollBottom) return;
		const row = this.ypos;
		const max = this.cols - this.xpos;
		n = Math.min(n, max);
		for (let x = this.cols - 1; x >= this.xpos + n; x--) {
			this.copyCell(row, x - n, row, x);
		}
		for (let x = this.xpos; x < this.xpos + n; x++) this.eraseCell(row, x);
	}

	private deleteChars(n: number): void {
		if (n < 1) return;
		if (this.ypos < this.scrollTop || this.ypos > this.scrollBottom) return;
		const row = this.ypos;
		for (let x = this.xpos; x < this.cols; x++) {
			if (x + n < this.cols) this.copyCell(row, x + n, row, x);
			else this.eraseCell(row, x);
		}
	}

	private eraseChars(n: number): void {
		if (n < 1) return;
		const max = this.cols - this.xpos - 1;
		n = Math.min(n, max);
		for (let x = this.xpos; x < this.xpos + n; x++) this.eraseCell(this.ypos, x);
	}

	private copyCell(srcY: number, srcX: number, dstY: number, dstX: number): void {
		const si = srcY * this.cols + srcX;
		const di = dstY * this.cols + dstX;
		this.screen.chars[di] = this.screen.chars[si];
		this.screen.fg[di] = this.screen.fg[si];
		this.screen.bg[di] = this.screen.bg[si];
		this.screen.flags[di] = this.screen.flags[si];
		this.screen.fgRgb[di] = this.screen.fgRgb[si];
		this.screen.bgRgb[di] = this.screen.bgRgb[si];
		this.screen.linkId[di] = this.screen.linkId[si];
		this.screen.dirty[di] = 1;
	}

	private eraseCell(y: number, x: number): void {
		const i = y * this.cols + x;
		const fg = this.fgIndex();
		const bg = this.bgIndex();
		const flags = this.attrFlags();
		this.screen.chars[i] = 0x20;
		this.screen.fg[i] = fg;
		this.screen.bg[i] = bg;
		this.screen.flags[i] = flags;
		this.screen.fgRgb[i] = this.resolveColor(this.fgColor);
		this.screen.bgRgb[i] = this.resolveColor(this.bgColor);
		this.screen.linkId[i] = -1;
		this.screen.dirty[i] = 1;
	}

	private insertLines(n: number): void {
		if (n < 1) return;
		if (this.ypos < this.scrollTop || this.ypos > this.scrollBottom) return;
		const height = this.scrollBottom - this.ypos + 1;
		n = Math.min(n, height);
		for (let y = this.scrollBottom; y >= this.ypos + n; y--) {
			this.screen.copyRowFrom(this.screen, y - n, y);
		}
		for (let y = this.ypos; y < this.ypos + n; y++) this.eraseRow(y);
	}

	private deleteLines(n: number): void {
		if (n < 1) return;
		if (this.ypos < this.scrollTop || this.ypos > this.scrollBottom) return;
		const height = this.scrollBottom - this.ypos + 1;
		n = Math.min(n, height);
		for (let y = this.ypos; y <= this.scrollBottom - n; y++) {
			this.screen.copyRowFrom(this.screen, y + n, y);
		}
		for (let y = this.scrollBottom - n + 1; y <= this.scrollBottom; y++) this.eraseRow(y);
	}

	private eraseInDisplay(mode: number): void {
		switch (mode) {
			case 0:
				this.eraseCells(this.xpos, this.ypos, this.cols - 1, this.rows - 1);
				break;
			case 1:
				this.eraseCells(0, 0, this.xpos, this.ypos);
				break;
			case 2:
				this.eraseCells(0, 0, this.cols - 1, this.rows - 1);
				this.xpos = 0;
				this.ypos = 0;
				break;
			default:
				break;
		}
	}

	private eraseInLine(mode: number): void {
		switch (mode) {
			case 0:
				this.eraseCells(this.xpos, this.ypos, this.cols - 1, this.ypos);
				break;
			case 1:
				this.eraseCells(0, this.ypos, this.xpos, this.ypos);
				break;
			case 2:
				this.eraseCells(0, this.ypos, this.cols - 1, this.ypos);
				break;
			default:
				break;
		}
	}

	private chtab(n: number): void {
		for (let i = 0; i < n; i++) {
			const next = this.nextCharTab(this.xpos);
			if (next === -1) break;
			this.xpos = next;
		}
	}

	private cbt(n: number): void {
		for (let i = 0; i < n; i++) {
			const prev = this.prevCharTab(this.xpos);
			if (prev === -1) break;
			this.xpos = prev;
		}
	}

	private vtab(n: number): void {
		for (let i = 0; i < n; i++) {
			let next = -1;
			for (const t of this.lineTabs) {
				if (t > this.ypos && (next === -1 || t < next)) next = t;
			}
			if (next === -1) {
				this.scrollUp(1);
				this.ypos = this.scrollBottom;
				break;
			}
			this.ypos = next;
		}
	}

	private repeatLast(n: number): void {
		if (this.lastGraphic < 0) return;
		for (let i = 0; i < n; i++) this.putChar(this.lastGraphic);
	}

	private clearTabs(mode: number): void {
		switch (mode) {
			case 0:
				this.charTabs.delete(this.xpos);
				break;
			case 1:
				this.lineTabs.delete(this.ypos);
				break;
			case 3:
				this.charTabs.clear();
				break;
			case 4:
				this.lineTabs.clear();
				break;
			case 5:
				this.charTabs.clear();
				this.lineTabs.clear();
				break;
			default:
				break;
		}
	}

	// ---------------------------------------------------------------------
	// Modes
	// ---------------------------------------------------------------------

	private setMode(ints: number[]): void {
		for (const v of ints) {
			if (v === 14 || v === 16) continue; // FETM/TTM are accepted but not modelled
		}
	}

	private resetMode(ints: number[]): void {
		for (const v of ints) {
			if (v === 14 || v === 16) continue;
		}
	}

	private setDecMode(ints: number[], on: boolean): void {
		for (const raw of ints) {
			const mode = raw < 0 ? 0 : raw;
			switch (mode) {
				case DecMode.DecOm:
					this.setFlag(ExtAttr.OriginMode, on);
					this.lcf = false;
					break;
				case DecMode.DecAwm:
					this.setFlag(ExtAttr.AutoWrap, on);
					if (!on) this.lcf = false;
					break;
				case DecMode.DecCem:
					this.setFlag(ExtAttr.CursorVisible, on);
					break;
				case DecMode.AltChars:
					this.setFlag(ExtAttr.AltChars, on);
					break;
				case DecMode.NoBright:
					this.setFlag(ExtAttr.NoBright, on);
					break;
				case DecMode.BgBright:
					this.setFlag(ExtAttr.BgBright, on);
					break;
				case DecMode.BlinkAltChars:
					this.setFlag(ExtAttr.BlinkAltChars, on);
					break;
				case DecMode.NoBlink:
					this.setFlag(ExtAttr.NoBlink, on);
					break;
				case DecMode.DecBkm:
					this.setFlag(ExtAttr.DecBkm, on);
					break;
				case DecMode.DecLrmm:
					this.setFlag(ExtAttr.DecLrmm, on);
					break;
				case DecMode.SixelScroll:
					this.setFlag(ExtAttr.SixelScroll, on);
					break;
				case DecMode.X10Mouse:
					this.setFlag(ExtAttr.X10Mouse, on);
					break;
				case DecMode.NormalMouse:
					this.setFlag(ExtAttr.NormalMouse, on);
					break;
				case DecMode.ButtonMouse:
					this.setFlag(ExtAttr.ButtonMouse, on);
					break;
				case DecMode.AnyMouse:
					this.setFlag(ExtAttr.AnyMouse, on);
					break;
				case DecMode.SgrMouse:
					this.setFlag(ExtAttr.SgrMouse, on);
					break;
				case DecMode.SgrPixelMouse:
					this.setFlag(ExtAttr.SgrPixelMouse, on);
					break;
				case DecMode.BracketedPaste:
					this.setFlag(ExtAttr.BracketedPaste, on);
					break;
				default:
					break;
			}
			if (on) this.decModes.add(mode);
			else this.decModes.delete(mode);
		}
	}

	private setFlag(flag: number, on: boolean): void {
		if (on) this.extattr |= flag;
		else this.extattr &= ~flag;
	}

	private setCtMode(ints: number[], on: boolean): void {
		for (const raw of ints) {
			const mode = raw < 0 ? 0 : raw;
			switch (mode) {
				case CtMode.PhysicalKeys:
					this.setFlag(ExtAttr.PhysicalKeys, on);
					break;
				case CtMode.SuppressKeys:
					this.setFlag(ExtAttr.SuppressKeys, on);
					break;
				case CtMode.LcfEnabled:
					if (!on && (this.extattr & ExtAttr.LcfForced)) break;
					this.setFlag(ExtAttr.LcfEnabled, on);
					break;
				case CtMode.LcfForced:
					this.setFlag(ExtAttr.LcfForced, on);
					this.setFlag(ExtAttr.LcfEnabled, on);
					break;
				case CtMode.Doorway:
					this.setFlag(ExtAttr.DoorwayMode, on);
					break;
				default:
					break;
			}
		}
	}

	private ctermSaveModes(): void {
		if (this.params.count === 0) {
			this.savedDecModes = [...this.decModes];
			return;
		}
		const saved = new Set(this.savedDecModes ?? []);
		for (const raw of this.params.ints) {
			if (raw < 0) continue;
			if (this.decModes.has(raw)) saved.add(raw);
			else saved.delete(raw);
		}
		this.savedDecModes = [...saved];
	}

	private ctermRestoreModes(): void {
		if (!this.savedDecModes) return;
		if (this.params.count === 0) {
			this.decModes.clear();
			for (const m of this.savedDecModes) this.decModes.add(m);
		} else {
			for (const raw of this.params.ints) {
				if (raw < 0) continue;
				if (this.savedDecModes.includes(raw)) this.decModes.add(raw);
				else this.decModes.delete(raw);
			}
		}
	}

	// ---------------------------------------------------------------------
	// Scroll left / right, font selection and rectangular operations
	// ---------------------------------------------------------------------

	private scrollLeft(n: number): void {
		if (n < 1) return;
		for (let y = this.scrollTop; y <= this.scrollBottom; y++) {
			for (let x = 0; x < this.cols - n; x++) this.copyCell(y, x + n, y, x);
			for (let x = this.cols - n; x < this.cols; x++) this.eraseCell(y, x);
		}
	}

	private scrollRight(n: number): void {
		if (n < 1) return;
		for (let y = this.scrollTop; y <= this.scrollBottom; y++) {
			for (let x = this.cols - 1; x >= n; x--) this.copyCell(y, x - n, y, x);
			for (let x = 0; x < n; x++) this.eraseCell(y, x);
		}
	}

	/**
	 * `CSI Ps1 ; Ps2 SP D` - font selection.
	 *
	 * Ps1 selects the attribute slot (0 default, 1 high intensity, 2 blink,
	 * 3 both) and Ps2 the font slot (0-255).
	 */
	private selectFont(slot: number, font: number): void {
		if (font > 255) {
			this.fontSelectionResult = 1;
			return;
		}
		this.fontSlots[slot & 3] = font;
		this.fontSelectionResult = 0;
	}

	/** Result of the last font selection request (0 ok, 1 fail, 99 none). */
	fontSelectionResult = 99;

	/** The alternate font slots selected by the BBS. */
	readonly fontSlots: number[] = [0, 0, 0, 0];

	/** Erase a rectangle to spaces using the current attribute (DECERA). */
	private eraseRect(top: number, left: number, bottom: number, right: number): void {
		if (bottom < top || right < left) return;
		const t = Math.max(0, top);
		const l = Math.max(0, left);
		const b = Math.min(this.rows - 1, bottom);
		const r = Math.min(this.cols - 1, right);
		this.eraseCells(l, t, r, b);
	}

	/** Fill a rectangle with a character (DECFRA). */
	private fillRect(top: number, left: number, bottom: number, right: number, ch: number): void {
		if (bottom < top || right < left) return;
		if (ch < 0x20 || ch === 0x7f) return;
		const t = Math.max(0, top);
		const l = Math.max(0, left);
		const b = Math.min(this.rows - 1, bottom);
		const r = Math.min(this.cols - 1, right);
		for (let y = t; y <= b; y++) {
			for (let x = l; x <= r; x++) {
				this.writeCell(x, y, ch);
			}
		}
	}

	/** Apply SGR attributes to a rectangle (DECCARA). */
	private changeRectAttrs(top: number, left: number, bottom: number, right: number, params: number[]): void {
		if (bottom < top || right < left) return;
		const t = Math.max(0, top);
		const l = Math.max(0, left);
		const b = Math.min(this.rows - 1, bottom);
		const r = Math.min(this.cols - 1, right);
		const savedAttr = this.attr;
		const savedFg = this.fgColor;
		const savedBg = this.bgColor;
		const savedNeg = this.negative;
		for (let y = t; y <= b; y++) {
			for (let x = l; x <= r; x++) {
				const i = y * this.cols + x;
				this.attr = this.screen.flags[i] & 1 ? (this.screen.flags[i] & 2 ? 0x88 : 0x08) | ((this.screen.bg[i] & 0x0f) << 4) | (this.screen.fg[i] & 0x0f) : ((this.screen.bg[i] & 0x0f) << 4) | (this.screen.fg[i] & 0x0f);
				this.fgColor = this.screen.fgRgb[i] ? TRUECOLOR_FLAG | this.screen.fgRgb[i] : this.screen.fg[i];
				this.bgColor = this.screen.bgRgb[i] ? TRUECOLOR_FLAG | this.screen.bgRgb[i] : this.screen.bg[i];
				this.negative = false;
				this.applySgrList(params);
				this.screen.fg[i] = this.fgIndex();
				this.screen.bg[i] = this.bgIndex();
				this.screen.fgRgb[i] = this.resolveColor(this.fgColor);
				this.screen.bgRgb[i] = this.resolveColor(this.bgColor);
				let f = 0;
				if (this.attr & 0x08) f |= 1;
				if (this.attr & 0x80) f |= 2;
				if (this.negative) f |= 4;
				this.screen.flags[i] = f;
				this.screen.dirty[i] = 1;
			}
		}
		this.attr = savedAttr;
		this.fgColor = savedFg;
		this.bgColor = savedBg;
		this.negative = savedNeg;
	}

	/** Apply a list of SGR parameters to the current attribute. */
	private applySgrList(params: number[]): void {
		const saved = this.params;
		this.params = { ints: params.slice(), strs: params.map((p) => String(p)), subs: params.map(() => [-1]), count: params.length };
		this.selectGraphicRendition();
		this.params = saved;
	}

	// ---------------------------------------------------------------------
	// Device reports
	// ---------------------------------------------------------------------

	/** The CTerm revision reported by DA. */
	static readonly CTERM_REVISION = '1;332';

	private deviceAttributes(): void {
		this.respond(`\x1b=67;84;101;114;109;${CTerm.CTERM_REVISION}c`);
	}

	private ctermDeviceAttributes(): void {
		let caps = 0;
		caps |= 1; // loadable fonts
		caps |= 2; // bright background
		caps |= 4; // palette entries may be modified
		caps |= 8; // pixel operations
		caps |= 16; // font selection
		caps |= 32; // extended palette
		caps |= 64; // mouse
		caps |= 128; // physical key reports
		this.respond(`\x1b<0;${caps}c`);
	}

	private deviceStatusReport(ps: number): void {
		switch (ps) {
			case 5:
				this.respond('\x1b[0n');
				break;
			case 6:
				this.respond(`\x1b[${this.ypos + 1};${this.xpos + 1}R`);
				break;
			case 255:
				this.respond(`\x1b[${this.rows};${this.cols}R`);
				break;
			default:
				break;
		}
	}

	private ctermStateReport(ps: number): void {
		switch (ps) {
			case 1: {
				const slots = [0, 0, 0, 0];
				this.respond(`\x1b=1;0;0;${slots.join(';')}n`);
				break;
			}
			case 2: {
				const modes = [...this.decModes].sort((a, b) => a - b);
				if (modes.length === 0) this.respond('\x1b=2;n');
				else this.respond(`\x1b=2;${modes.join(';')}n`);
				break;
			}
			case 3:
				this.respond('\x1b=3;16;8n');
				break;
			case 4:
				this.respond(`\x1b=4;${this.extattr & ExtAttr.LcfEnabled ? 1 : 0}n`);
				break;
			case 5:
				this.respond(`\x1b=5;${this.extattr & ExtAttr.LcfForced ? 1 : 0}n`);
				break;
			case 6:
				this.respond('\x1b=6;1n');
				break;
			default:
				break;
		}
	}

	private decdsr(): void {
		const ps = this.param0(1, 0);
		const pn = this.param0(2, 1);
		if (ps === 62 && !this.hasParam(2)) {
			this.respond('\x1b[32767*{');
			return;
		}
		if (ps === 63) {
			// Upstream computes a CRC16 over each macro including its trailing NUL.
			let crc = 0;
			for (const [, body] of [...this.macros.entries()].sort((a, b) => a[0] - b[0])) {
				crc = crc16(crc, body);
				crc = crc16(crc, '\0');
			}
			this.respond(`\x1bP${pn}!${crc.toString(16).padStart(4, '0').toUpperCase()}\x1b\\`);
			return;
		}
	}

	private decrqmPrivate(): void {
		const ps = this.param0(1, 0);
		const known = new Set([
			6, 7, 9, 25, 31, 32, 33, 34, 35, 67, 69, 80, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1015, 1016, 2004,
		]);
		const pm = known.has(ps) ? 1 : 0;
		this.respond(`\x1b[?${ps};${pm}$y`);
	}

	private decrqmCt(): void {
		const ps = this.param0(1, 0);
		let pm = 0;
		if (ps === 1 || ps === 2 || ps === 4 || ps === 255) pm = 1;
		else if (ps === 5) pm = (this.extattr & ExtAttr.LcfForced) ? 3 : 2;
		this.respond(`\x1b=${ps};${pm}$y`);
	}

	private decrqssOrSpecial(final: string): void {
		// CSI ... $ x / $ z / $ v / $ t are DEC rectangular operations; they are
		// not implemented in this build.
		void final;
	}

	private xtermGraphicsAttributes(): void {
		const p1 = this.param0(1, 0);
		const p2 = this.param0(2, 0);
		if (p1 === 2 && p2 === 1) {
			this.respond(`\x1b[?2;0;${this.cols * 8};${this.rows * 16}S`);
		}
	}

	private ct24bc(): void {
		const which = this.param0(1, 0);
		const r = this.param0(2, 0) & 0xff;
		const g = this.param0(3, 0) & 0xff;
		const b = this.param0(4, 0) & 0xff;
		const rgb = (r << 16) | (g << 8) | b;
		if (which === 0) {
			this.bgColor = -1;
			this.bgTc = `${which};${r};${g};${b}`;
		} else {
			this.fgColor = -1;
			this.fgTc = `${which};${r};${g};${b}`;
		}
	}

	private ctosf(): void {
		// Deprecated font-upload announcement; the DCS form is preferred.
	}

	private tabStopReport(): void {
		const stops = [...this.charTabs].filter((t) => t < this.cols).sort((a, b) => a - b);
		this.respond(`\x1bP2$u${stops.join('/')}\x1b\\`);
	}

	private invokeMacro(num: number): void {
		if (num < 0 || num > 63) return;
		const body = this.macros.get(num);
		if (!body) return;
		const savedState = this.state;
		this.state = State.Ground;
		this.write(new TextEncoder().encode(body));
		this.state = savedState;
	}

	private setCursorStyle(ps: number): void {
		switch (ps) {
			case 2:
				this.cursorStyle = 'steady-block';
				break;
			case 3:
				this.cursorStyle = 'blinking-underline';
				break;
			case 4:
				this.cursorStyle = 'steady-underline';
				break;
			default:
				this.cursorStyle = 'blinking-block';
				break;
		}
	}

	private setScrollRegion(top: number, bottom: number): void {
		if (top < 0 || bottom <= top || bottom >= this.rows) return;
		this.scrollTop = top;
		this.scrollBottom = bottom;
		if (this.extattr & ExtAttr.OriginMode) {
			this.xpos = 0;
			this.ypos = top;
		} else {
			this.xpos = 0;
			this.ypos = 0;
		}
	}

	private setLeftRightMargins(left: number, right: number): void {
		if (left < 0 || right <= left || right >= this.cols) return;
		this.xpos = 0;
		this.ypos = 0;
	}

	// ---------------------------------------------------------------------
	// SGR
	// ---------------------------------------------------------------------

	private selectGraphicRendition(): void {
		if (this.params.count === 0) {
			this.sgrReset();
			return;
		}
		if (this.paramOverflow) return;
		for (let i = 0; i < this.params.count; i++) {
			const ps = this.params.ints[i] < 0 ? 0 : this.params.ints[i];
			const subs = this.params.subs[i] ?? [];
			switch (ps) {
				case 0:
					this.sgrReset();
					break;
				case 1:
					if (!(this.extattr & ExtAttr.NoBright)) {
						this.attr |= 0x08;
						this.fgTc = null;
					}
					break;
				case 2:
				case 22:
					this.attr &= ~0x08;
					if (!(this.extattr & ExtAttr.NoBright)) this.fgTc = null;
					break;
				case 4:
					break;
				case 5:
				case 6:
					this.attr |= 0x80;
					if (this.extattr & ExtAttr.BgBright) this.bgTc = null;
					break;
				case 7:
					this.setNegative(true);
					break;
				case 8:
					this.attr = (this.attr & 0xf0) | ((this.attr >> 4) & 0x0f);
					this.fgColor = this.bgColor;
					this.fgTc = this.bgTc;
					break;
				case 25:
					this.attr &= ~0x80;
					if (this.extattr & ExtAttr.BgBright) this.bgTc = null;
					break;
				case 27:
					this.setNegative(false);
					break;
				case 30:
				case 31:
				case 32:
				case 33:
				case 34:
				case 35:
				case 36:
				case 37:
					this.setFgColor(ps - 30);
					break;
				case 38:
					this.setExtendedColor(true, subs, i);
					break;
				case 39:
					this.setFgColor(7);
					break;
				case 40:
				case 41:
				case 42:
				case 43:
				case 44:
				case 45:
				case 46:
				case 47:
					this.setBgColor(ps - 40);
					break;
				case 48:
					this.setExtendedColor(false, subs, i);
					break;
				case 49:
					this.setBgColor(0);
					break;
				case 90:
				case 91:
				case 92:
				case 93:
				case 94:
				case 95:
				case 96:
				case 97:
					if (!(this.extattr & ExtAttr.NoBright)) {
						this.setFgColor(ps - 90);
						this.attr |= 0x08;
						this.fgTc = null;
					}
					break;
				case 100:
				case 101:
				case 102:
				case 103:
				case 104:
				case 105:
				case 106:
				case 107:
					if (this.extattr & ExtAttr.BgBright) {
						this.setBgColor(ps - 100);
						this.attr |= 0x80;
						this.bgTc = null;
					}
					break;
				default:
					break;
			}
		}
	}

	private sgrReset(): void {
		this.negative = false;
		this.attr = 0x07;
		this.fgColor = -1;
		this.bgColor = -1;
		this.fgTc = null;
		this.bgTc = null;
	}

	private setFgColor(index: number): void {
		if (this.negative) {
			this.attr = (this.attr & 0xf0) | ((this.attr >> 4) & 0x0f);
		} else {
			this.attr = (this.attr & 0xf0) | (index & 0x0f);
		}
		this.fgColor = -1;
		this.fgTc = null;
	}

	private setBgColor(index: number): void {
		if (this.negative) {
			this.attr = (this.attr & 0x0f) | ((this.attr & 0x0f) << 4);
		} else {
			this.attr = (this.attr & 0x0f) | ((index & 0x0f) << 4);
		}
		this.bgColor = -1;
		this.bgTc = null;
	}

	private setNegative(on: boolean): void {
		if (on === this.negative) return;
		const fg = this.attr & 0x0f;
		const bg = (this.attr >> 4) & 0x0f;
		this.attr = (this.attr & 0x88) | (on ? bg : fg) | ((on ? fg : bg) << 4);
		const fgColor = this.fgColor;
		this.fgColor = this.bgColor;
		this.bgColor = fgColor;
		const fgTc = this.fgTc;
		this.fgTc = this.bgTc;
		this.bgTc = fgTc;
		this.negative = on;
	}

	/**
	 * Handle `SGR 38`/`48` extended colours.
	 *
	 * Both the semicolon form (`38;5;N`, `38;2;R;G;B`) and the colon form
	 * (`38:5:N`, `38:2:R:G:B`) are accepted.
	 */
	private setExtendedColor(isForeground: boolean, subs: number[], index: number): void {
		const colonForm = subs.length > 1;
		let mode = -1;
		let values: number[] = [];
		if (colonForm) {
			mode = subs[1];
			values = subs.slice(2);
		} else {
			// Semicolon form: the values are the following parameters.
			mode = this.params.ints[index + 1] ?? -1;
			values = [];
			for (let k = index + 2; k < this.params.count; k++) {
				const v = this.params.ints[k];
				if (v < 0) break;
				values.push(v);
				if (mode === 2 && values.length === 3) break;
				if (mode === 5 && values.length === 1) break;
			}
		}
		if (mode === 5) {
			const n = values[0] ?? 0;
			// Only the semicolon form adds the shadow-palette offset.
			const idx = colonForm ? n : n + SHADOW_PALETTE_OFFSET;
			if (isForeground) {
				this.fgColor = this.negative ? this.bgColor : idx;
				this.fgTc = colonForm ? `38:5:${n}` : `38;5;${n}`;
			} else {
				this.bgColor = this.negative ? this.fgColor : idx;
				this.bgTc = colonForm ? `48:5:${n}` : `48;5;${n}`;
			}
			return;
		}
		if (mode === 2) {
			const r = (values[values.length - 3] ?? 0) & 0xff;
			const g = (values[values.length - 2] ?? 0) & 0xff;
			const b = (values[values.length - 1] ?? 0) & 0xff;
			const rgb = (r << 16) | (g << 8) | b;
			if (isForeground) {
				this.fgColor = TRUECOLOR_FLAG | rgb;
				this.fgTc = colonForm ? `38:2:${r}:${g}:${b}` : `38;2;${r};${g};${b}`;
			} else {
				this.bgColor = TRUECOLOR_FLAG | rgb;
				this.bgTc = colonForm ? `48:2:${r}:${g}:${b}` : `48;2;${r};${g};${b}`;
			}
		}
	}

}

function newSeqParams(): SeqParams {
	return { ints: [], strs: [], subs: [], count: 0 };
}

function parseRgbSpec(spec: string): number | null {
	const m = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(spec.trim());
	if (!m) return null;
	const scale = (s: string): number => {
		const v = parseInt(s, 16);
		const bits = s.length * 4;
		return bits >= 8 ? v >>> (bits - 8) : v << (8 - bits);
	};
	return ((scale(m[1]) << 16) | (scale(m[2]) << 8) | scale(m[3])) & 0xffffff;
}

function formatRgbReply(rgb: number): string {
	const r = (rgb >> 16) & 0xff;
	const g = (rgb >> 8) & 0xff;
	const b = rgb & 0xff;
	const c = (v: number): string => {
		const hi = v >> 4;
		const lo = v & 0x0f;
		return hi === lo ? hi.toString(16) : v.toString(16).padStart(2, '0');
	};
	return `rgb:${c(r)}/${c(g)}/${c(b)}`;
}

function decodeHexMacro(text: string): string {
	let out = '';
	for (let i = 0; i + 1 < text.length; i += 2) {
		const hex = text.slice(i, i + 2);
		const v = parseInt(hex, 16);
		if (!Number.isNaN(v)) out += String.fromCharCode(v);
	}
	return out;
}

function crc16(crc: number, text: string): number {
	let c = crc;
	for (let i = 0; i < text.length; i++) {
		c ^= text.charCodeAt(i) & 0xff;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? (c >> 1) ^ 0xa001 : c >> 1;
		}
	}
	return c & 0xffff;
}
