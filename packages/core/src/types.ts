/**
 * Core value types shared by every WebSyncTERM package.
 *
 * The attribute model mirrors SyncTERM/CTerm (src/conio/cterm.c):
 * a cell carries a foreground palette index, a background palette index, a set of
 * boolean rendition flags, and optional 24-bit colour overrides.
 */

/** Rendition flags stored per cell. */
export const AttrFlags = {
	/** Blink (SGR 5/6). */
	Blink: 1 << 0,
	/** High intensity / "bold" (SGR 1). */
	Bold: 1 << 1,
	/** Negative image (SGR 7/27). */
	Reverse: 1 << 2,
	/** Concealed (SGR 8): foreground is painted in the background colour. */
	Concealed: 1 << 3,
	/** 24-bit foreground override is present in `fgRgb`. */
	TrueFg: 1 << 4,
	/** 24-bit background override is present in `bgRgb`. */
	TrueBg: 1 << 5,
	/** Foreground is explicitly set (not "default"). */
	FgSet: 1 << 6,
	/** Background is explicitly set (not "default"). */
	BgSet: 1 << 7,
	/** "Thin" font variant (SyncTERM's thin codepage fonts). */
	Thin: 1 << 8,
} as const;

export type AttrFlag = (typeof AttrFlags)[keyof typeof AttrFlags];

/** Sentinel used for "default" palette entries. */
export const DEFAULT_COLOR = -1;

/** A colour reference: either a palette index or a 24-bit RGB value. */
export interface ColorRef {
	/** Palette index 0..255, or -1 for the terminal default. */
	index: number;
	/** 0xRRGGBB, or 0 when unused. */
	rgb: number;
}

export const DEFAULT_COLOR_REF: ColorRef = { index: DEFAULT_COLOR, rgb: 0 };

/** Terminal emulation flavours implemented by the engine. */
export const TermEmulation = {
	/** CTerm "ANSI-BBS" mode: the SyncTERM default. */
	AnsiBbs: 'ansi-bbs',
	/** Strict ECMA-48 mode (cterm_ecma48.c). */
	Ecma48: 'ecma48',
	/** VT52 (cterm_vt52.c). */
	Vt52: 'vt52',
	/** Commodore PETSCII, upper case (cterm_petscii.c). */
	PetsciiUpper: 'petscii-upper',
	/** Commodore PETSCII, lower case (cterm_petscii.c). */
	PetsciiLower: 'petscii-lower',
	/** Atari 8-bit ATASCII (cterm_atascii.c). */
	Atascii: 'atascii',
	/** Prestel / Viewdata (cterm_prestel.c). */
	Prestel: 'prestel',
	/** BBC Micro Mode 7 (teletext). */
	Beeb: 'beeb',
	/** Atari ST (VT52-ish). */
	AtariSt: 'atari-st',
} as const;

export type TermEmulationName = (typeof TermEmulation)[keyof typeof TermEmulation];

/** A screen geometry. */
export interface ScreenSize {
	cols: number;
	rows: number;
}

/** One cell of the screen. */
export interface Cell {
	/** Unicode code point displayed (CP437 bytes are mapped to their Unicode glyph). */
	code: number;
	fg: number;
	bg: number;
	flags: number;
	fgRgb: number;
	bgRgb: number;
}

/** Cursor position, 0-based. */
export interface CursorPosition {
	x: number;
	y: number;
}

/** Cursor style (DECSCUSR). */
export const CursorStyle = {
	BlinkingBlock: 'blinking-block',
	SteadyBlock: 'steady-block',
	BlinkingUnderline: 'blinking-underline',
	SteadyUnderline: 'steady-underline',
} as const;

export type CursorStyleName = (typeof CursorStyle)[keyof typeof CursorStyle];

/** Mouse reporting protocols supported by SyncTERM. */
export const MouseMode = {
	None: 0,
	/** DECSET 9 - X10 compatibility (press only). */
	X10: 1,
	/** DECSET 1000 - normal tracking. */
	Normal: 2,
	/** DECSET 1002 - button-event tracking. */
	ButtonEvent: 3,
	/** DECSET 1003 - any-event tracking. */
	AnyEvent: 4,
	/** DECSET 1006 - SGR extended coordinates (overrides the encoding). */
	SgrExtended: 8,
} as const;

/** A hyperlink attached to a run of cells (OSC 8). */
export interface Hyperlink {
	uri: string;
	id?: string;
}

/** Severity of a diagnostic emitted by the engine. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A diagnostic emitted by the engine. */
export interface EngineLog {
	level: LogLevel;
	message: string;
	detail?: unknown;
}
