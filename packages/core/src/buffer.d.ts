/**
 * The screen buffer: a grid of cells plus a scrollback ring.
 *
 * Cells are stored as struct-of-arrays so that a 132x60 screen with tens of
 * thousands of scrollback lines stays cheap to copy and to serialise.
 */
/** A run of cells that share the same hyperlink (OSC 8). */
export interface LinkRun {
    /** Flat cell index of the first cell in the run. */
    start: number;
    /** Number of cells. */
    length: number;
    /** Target URI (empty string terminates the hyperlink). */
    uri: string;
    /** Optional OSC 8 id. */
    id?: string;
}
/** A contiguous span of a single scrollback row. */
export declare class ScreenBuffer {
    readonly cols: number;
    readonly rows: number;
    /** Unicode code point per cell. */
    readonly chars: Uint16Array;
    /** Foreground palette index, or DEFAULT_COLOR. */
    readonly fg: Int16Array;
    /** Background palette index, or DEFAULT_COLOR. */
    readonly bg: Int16Array;
    /** AttrFlags bitmask. */
    readonly flags: Uint16Array;
    /** 24-bit foreground override. */
    readonly fgRgb: Uint32Array;
    /** 24-bit background override. */
    readonly bgRgb: Uint32Array;
    /** Hyperlink id per cell (index into `links`), or -1. */
    readonly linkId: Int32Array;
    /** Hyperlink table shared by the screen and the scrollback. */
    links: LinkRun[];
    private linkIndex;
    /** True when the cell has been written to since the last clear. */
    readonly dirty: Uint8Array;
    constructor(cols: number, rows: number);
    /** Index of a cell. */
    index(x: number, y: number): number;
    /** Fill every cell with the given attribute. */
    clear(fg?: number, bg?: number, flags?: number): void;
    /** Copy one row of cells from another buffer. */
    copyRowFrom(src: ScreenBuffer, srcRow: number, dstRow: number): void;
    /** Write a cell. */
    set(x: number, y: number, code: number, fg: number, bg: number, flags: number, fgRgb?: number, bgRgb?: number): void;
    /** Read the character at a cell. */
    charAt(x: number, y: number): number;
    /** Mark a cell dirty. */
    markDirty(x: number, y: number): void;
    /** Register (or look up) a hyperlink and return its id. */
    internLink(uri: string, id?: string): number;
    /** Look up a link id. */
    link(id: number): LinkRun | undefined;
    /** Extract a row of text (for copy/clipboard). */
    rowText(y: number, mapper: (byte: number) => number): string;
}
/**
 * A scrollback buffer: a ring of complete screen rows.
 */
export declare class Scrollback {
    private readonly capacity;
    private readonly rows;
    private head;
    private count;
    constructor(capacity: number);
    /** Number of stored rows. */
    get length(): number;
    /** Maximum number of stored rows. */
    get limit(): number;
    /** Append a copy of the given screen row. */
    push(screen: ScreenBuffer, row: number): void;
    /** Read a row by logical index (0 = oldest). */
    get(index: number): ScreenBuffer | undefined;
    /** Remove all rows. */
    clear(): void;
    /** Discard the oldest `n` rows. */
    trim(n: number): void;
}
/** Attribute helper: build the flag mask for a cell. */
export declare function makeFlags(blink: boolean, bold: boolean, reverse: boolean, concealed: boolean, fgSet: boolean, bgSet: boolean, thin: boolean): number;
//# sourceMappingURL=buffer.d.ts.map