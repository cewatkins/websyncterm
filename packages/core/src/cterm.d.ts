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
import { Palette } from './palette.js';
import { type CodepageName } from './charset.js';
import type { CursorStyleName } from './types.js';
/** Maximum number of CSI parameters accepted, matching MAX_SEQ_PARAMS. */
export declare const MAX_SEQ_PARAMS = 64;
/**
 * Flag set on a colour value that carries a direct 24-bit RGB value rather
 * than a palette index (upstream `map_rgb()` sets bit 31).
 */
export declare const TRUECOLOR_FLAG = 2147483648;
/** Extended attribute flags (CTERM_EXTATTR_* in upstream). */
export declare const ExtAttr: {
    readonly OriginMode: number;
    readonly AutoWrap: number;
    readonly CursorVisible: number;
    readonly AltChars: number;
    readonly NoBright: number;
    readonly BgBright: number;
    readonly BlinkAltChars: number;
    readonly NoBlink: number;
    readonly DecBkm: number;
    readonly DecLrmm: number;
    readonly SixelScroll: number;
    readonly X10Mouse: number;
    readonly NormalMouse: number;
    readonly ButtonMouse: number;
    readonly AnyMouse: number;
    readonly SgrMouse: number;
    readonly SgrPixelMouse: number;
    readonly BracketedPaste: number;
    readonly DoorwayMode: number;
    readonly PhysicalKeys: number;
    readonly SuppressKeys: number;
    readonly LcfEnabled: number;
    readonly LcfForced: number;
    readonly ExtendedPalette: number;
};
/** DECSET/DECRST private mode numbers handled by the engine. */
export declare const DecMode: {
    readonly DecOm: 6;
    readonly DecAwm: 7;
    readonly X10Mouse: 9;
    readonly DecCem: 25;
    readonly AltChars: 31;
    readonly NoBright: 32;
    readonly BgBright: 33;
    readonly BlinkAltChars: 34;
    readonly NoBlink: 35;
    readonly DecBkm: 67;
    readonly DecLrmm: 69;
    readonly SixelScroll: 80;
    readonly NormalMouse: 1000;
    readonly ButtonMouse: 1002;
    readonly AnyMouse: 1003;
    readonly SgrMouse: 1006;
    readonly SgrPixelMouse: 1016;
    readonly BracketedPaste: 2004;
};
/** CTerm private mode numbers (the `CSI = Ps h` family). */
export declare const CtMode: {
    readonly PhysicalKeys: 1;
    readonly SuppressKeys: 2;
    readonly LcfEnabled: 4;
    readonly LcfForced: 5;
    readonly Doorway: 255;
};
/** Music introducer configuration (`CSI = Ps M`). */
export declare const MusicMode: {
    /** Only `CSI |` introduces music. */
    readonly Cterm: 0;
    /** `CSI |` and `CSI N`. */
    readonly Bansi: 1;
    /** `CSI |`, `CSI N` and `CSI M`. */
    readonly Full: 2;
};
export type MusicModeName = (typeof MusicMode)[keyof typeof MusicMode];
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
/**
 * The terminal engine.
 */
export declare class CTerm {
    readonly palette: Palette;
    cols: number;
    rows: number;
    screen: ScreenBuffer;
    scrollback: Scrollback;
    /** Cursor position, 0-based. */
    xpos: number;
    ypos: number;
    /** Saved cursor position (DECSC/DECRC). */
    private savedX;
    private savedY;
    private savedValid;
    /** Current attribute byte (see the file header). */
    attr: number;
    /** Extended foreground palette index (0..255) or -1. */
    fgColor: number;
    /** Extended background palette index (0..255) or -1. */
    bgColor: number;
    /** SGR 7 negative image. */
    negative: boolean;
    /** Raw SGR text for the foreground (DECRQSS). */
    fgTc: string | null;
    /** Raw SGR text for the background (DECRQSS). */
    bgTc: string | null;
    /** Extended attribute flags. */
    extattr: number;
    /** Scroll region, 0-based inclusive. */
    scrollTop: number;
    scrollBottom: number;
    /** Character and line tab stops. */
    charTabs: Set<number>;
    lineTabs: Set<number>;
    /** DECSDM-style status row state. */
    statusRowType: number;
    /** Last column flag (LCF). */
    lcf: boolean;
    /** Cursor style (DECSCUSR). */
    cursorStyle: CursorStyleName;
    /** Music introducer mode. */
    musicMode: MusicModeName;
    /** Output speed emulation (DECSCS): 0 = unlimited. */
    throttleSpeed: number;
    /** DECSACE: 0/2 = rectangle, 1 = stream. */
    decsace: number;
    /** Current hyperlink URI (OSC 8) and id. */
    hyperlinkUri: string;
    hyperlinkId: string;
    /** Macro storage (DECDMAC). */
    readonly macros: Map<number, string>;
    /** The last graphic character, for REP. */
    private lastGraphic;
    /** Doorway mode: the next byte is literal. */
    private doorwayNext;
    /** Music capture state. */
    private musicCapture;
    private state;
    private params;
    private paramBuf;
    private paramOverflow;
    private intermediate;
    private oscBuf;
    private dcsBuf;
    private dcsKind;
    private dcsStarted;
    private readonly sixel;
    private codepage;
    private readonly opts;
    /** Set of DEC modes currently enabled (for DECRQM and mode reports). */
    private readonly decModes;
    /** Saved DEC mode set (CTSMS). */
    private savedDecModes;
    constructor(opts?: CTermOptions);
    /** Change the screen size, preserving content where possible. */
    resize(cols: number, rows: number): void;
    /** Set the active code page. */
    setCodepage(cp: CodepageName): void;
    /** Get the active code page. */
    getCodepage(): CodepageName;
    /** Replace the first 16 palette entries (a BBS-supplied palette). */
    setBasePalette(colors: readonly number[]): void;
    /** Reset the terminal to its initial state (RIS). */
    reset(): void;
    /** Reset the tab stops to the default every-8-columns arrangement. */
    resetTabs(): void;
    private respond;
    private respondBytes;
    /** Feed bytes from the host into the terminal. */
    write(data: Uint8Array): void;
    /** Feed a string into the terminal (encoded as UTF-8). */
    writeString(text: string): void;
    private processByte;
    private ground;
    /**
     * Write a printable character at the cursor, honouring wrapping.
     *
     * Upstream CTerm moves the cursor to the first column of the next line as
     * soon as a character is written to the last column (unless LCF mode is
     * enabled, in which case the cursor stays at the right margin until the
     * next character arrives).
     */
    private putChar;
    /** Write the current attribute into a cell. */
    private writeCell;
    /** Resolve a colour value (palette index or truecolor) to 0xRRGGBB. */
    private resolveColor;
    /** Attribute flags for the current attribute byte. */
    private attrFlags;
    /** Foreground palette index after applying the NOBRIGHT rule. */
    private fgIndex;
    /** Background palette index after applying the BGBRIGHT rule. */
    private bgIndex;
    private backspace;
    private tab;
    /** Find the next character tab stop strictly after `from`, or -1. */
    private nextCharTab;
    /** Find the previous character tab stop strictly before `from`, or -1. */
    private prevCharTab;
    private lineFeed;
    private reverseIndex;
    /** Scroll the scroll region up by `n` lines. */
    private scrollUp;
    /** Scroll the scroll region down by `n` lines. */
    private scrollDown;
    /** Erase a whole row using the current attribute. */
    private eraseRow;
    /** Erase a range of cells using the current attribute. */
    private eraseCells;
    private clearScreenWithAttr;
    private escape;
    private escapeIntermediate;
    private csi;
    private commitParam;
    /** The private parameter prefix of the current sequence ('' when absent). */
    private privatePrefix;
    /** Parameter `i` (1-based, as used in the upstream docs). */
    private param;
    /** Parameter `i` with a default of 0 and no clamping to 1. */
    private param0;
    /** True when the parameter at `i` was explicitly provided. */
    private hasParam;
    private osc;
    private apc;
    private ignoreString;
    private dcs;
    private dcsFinal;
    private beginDcs;
    private dcsPassthrough;
    private dcsIgnore;
    /**
     * Finish a string sequence.
     *
     * Called when ESC \ is seen (or when the parser returns to the ground state
     * from an ESC that turned out to be a string terminator).
     */
    private finishString;
    /** Which kind of control string is being collected, if any. */
    private stringKind;
    private finishDcs;
    private storeMacro;
    private answerDecrqss;
    private decrqssValue;
    /** Build the DECRQSS SGR report. */
    private sgrReport;
    private handleOsc;
    private oscPalette;
    private oscResetPalette;
    private oscQueryColour;
    private oscHyperlink;
    private applySixel;
    /** The last decoded sixel image, for the renderer. */
    sixelPixels: {
        pixels: Int32Array;
        width: number;
        height: number;
        baseX: number;
        baseY: number;
        cw: number;
        ch: number;
    } | null;
    /** Begin capturing an ANSI music string. */
    private beginMusic;
    private endMusic;
    /** The music string currently being captured, if any. */
    get musicString(): string | null;
    /** Append a byte to the music capture buffer. */
    pushMusic(byte: number): void;
    private dispatchCsi;
    private dispatchCsiPlain;
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
    private dispatchCsiIntermediate;
    private statusRowTarget;
    private setStatusRowType;
    private insertColumns;
    private deleteColumns;
    /** DECRQM for the ANSI (non-private) mode set. */
    private decrqmAnsi;
    /** Toggle attributes within a rectangle (DECRARA). */
    private reverseRectAttrs;
    private dispatchCsiSpace;
    private dispatchCsiEqual;
    private dispatchCsiPrivate;
    private dispatchCsiLess;
    /** The maximum X coordinate, honouring origin mode. */
    private get maxX();
    /** The maximum Y coordinate, honouring origin mode. */
    private get maxY();
    private scrollRightEdge;
    private cursorUp;
    private cursorDown;
    private cursorForward;
    private cursorBack;
    private cursorNextLine;
    private cursorPrevLine;
    private cursorToColumn;
    private cursorToRow;
    private cursorTo;
    private saveCursor;
    private restoreCursor;
    private insertChars;
    private deleteChars;
    private eraseChars;
    private copyCell;
    private eraseCell;
    private insertLines;
    private deleteLines;
    private eraseInDisplay;
    private eraseInLine;
    private chtab;
    private cbt;
    private vtab;
    private repeatLast;
    private clearTabs;
    private setMode;
    private resetMode;
    private setDecMode;
    private setFlag;
    private setCtMode;
    private ctermSaveModes;
    private ctermRestoreModes;
    private scrollLeft;
    private scrollRight;
    /**
     * `CSI Ps1 ; Ps2 SP D` - font selection.
     *
     * Ps1 selects the attribute slot (0 default, 1 high intensity, 2 blink,
     * 3 both) and Ps2 the font slot (0-255).
     */
    private selectFont;
    /** Result of the last font selection request (0 ok, 1 fail, 99 none). */
    fontSelectionResult: number;
    /** The alternate font slots selected by the BBS. */
    readonly fontSlots: number[];
    /** Erase a rectangle to spaces using the current attribute (DECERA). */
    private eraseRect;
    /** Fill a rectangle with a character (DECFRA). */
    private fillRect;
    /** Apply SGR attributes to a rectangle (DECCARA). */
    private changeRectAttrs;
    /** Apply a list of SGR parameters to the current attribute. */
    private applySgrList;
    /** The CTerm revision reported by DA. */
    static readonly CTERM_REVISION = "1;332";
    private deviceAttributes;
    private ctermDeviceAttributes;
    private deviceStatusReport;
    private ctermStateReport;
    private decdsr;
    private decrqmPrivate;
    private decrqmCt;
    private decrqssOrSpecial;
    private xtermGraphicsAttributes;
    private ct24bc;
    private ctosf;
    private tabStopReport;
    private invokeMacro;
    private setCursorStyle;
    private setScrollRegion;
    private setLeftRightMargins;
    private selectGraphicRendition;
    private sgrReset;
    private setFgColor;
    private setBgColor;
    private setNegative;
    /**
     * Handle `SGR 38`/`48` extended colours.
     *
     * Both the semicolon form (`38;5;N`, `38;2;R;G;B`) and the colon form
     * (`38:5:N`, `38:2:R:G:B`) are accepted.
     */
    private setExtendedColor;
}
//# sourceMappingURL=cterm.d.ts.map