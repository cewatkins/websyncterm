/**
 * Core value types shared by every WebSyncTERM package.
 *
 * The attribute model mirrors SyncTERM/CTerm (src/conio/cterm.c):
 * a cell carries a foreground palette index, a background palette index, a set of
 * boolean rendition flags, and optional 24-bit colour overrides.
 */
/** Rendition flags stored per cell. */
export declare const AttrFlags: {
    /** Blink (SGR 5/6). */
    readonly Blink: number;
    /** High intensity / "bold" (SGR 1). */
    readonly Bold: number;
    /** Negative image (SGR 7/27). */
    readonly Reverse: number;
    /** Concealed (SGR 8): foreground is painted in the background colour. */
    readonly Concealed: number;
    /** 24-bit foreground override is present in `fgRgb`. */
    readonly TrueFg: number;
    /** 24-bit background override is present in `bgRgb`. */
    readonly TrueBg: number;
    /** Foreground is explicitly set (not "default"). */
    readonly FgSet: number;
    /** Background is explicitly set (not "default"). */
    readonly BgSet: number;
    /** "Thin" font variant (SyncTERM's thin codepage fonts). */
    readonly Thin: number;
};
export type AttrFlag = (typeof AttrFlags)[keyof typeof AttrFlags];
/** Sentinel used for "default" palette entries. */
export declare const DEFAULT_COLOR = -1;
/** A colour reference: either a palette index or a 24-bit RGB value. */
export interface ColorRef {
    /** Palette index 0..255, or -1 for the terminal default. */
    index: number;
    /** 0xRRGGBB, or 0 when unused. */
    rgb: number;
}
export declare const DEFAULT_COLOR_REF: ColorRef;
/** Terminal emulation flavours implemented by the engine. */
export declare const TermEmulation: {
    /** CTerm "ANSI-BBS" mode: the SyncTERM default. */
    readonly AnsiBbs: "ansi-bbs";
    /** Strict ECMA-48 mode (cterm_ecma48.c). */
    readonly Ecma48: "ecma48";
    /** VT52 (cterm_vt52.c). */
    readonly Vt52: "vt52";
    /** Commodore PETSCII, upper case (cterm_petscii.c). */
    readonly PetsciiUpper: "petscii-upper";
    /** Commodore PETSCII, lower case (cterm_petscii.c). */
    readonly PetsciiLower: "petscii-lower";
    /** Atari 8-bit ATASCII (cterm_atascii.c). */
    readonly Atascii: "atascii";
    /** Prestel / Viewdata (cterm_prestel.c). */
    readonly Prestel: "prestel";
    /** BBC Micro Mode 7 (teletext). */
    readonly Beeb: "beeb";
    /** Atari ST (VT52-ish). */
    readonly AtariSt: "atari-st";
};
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
export declare const CursorStyle: {
    readonly BlinkingBlock: "blinking-block";
    readonly SteadyBlock: "steady-block";
    readonly BlinkingUnderline: "blinking-underline";
    readonly SteadyUnderline: "steady-underline";
};
export type CursorStyleName = (typeof CursorStyle)[keyof typeof CursorStyle];
/** Mouse reporting protocols supported by SyncTERM. */
export declare const MouseMode: {
    readonly None: 0;
    /** DECSET 9 - X10 compatibility (press only). */
    readonly X10: 1;
    /** DECSET 1000 - normal tracking. */
    readonly Normal: 2;
    /** DECSET 1002 - button-event tracking. */
    readonly ButtonEvent: 3;
    /** DECSET 1003 - any-event tracking. */
    readonly AnyEvent: 4;
    /** DECSET 1006 - SGR extended coordinates (overrides the encoding). */
    readonly SgrExtended: 8;
};
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
//# sourceMappingURL=types.d.ts.map