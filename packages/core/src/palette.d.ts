/**
 * Palette handling.
 *
 * SyncTERM keeps a DAC ("device colour") table with 282 entries
 * (`dac_default[]` in src/conio/vidmodes.c):
 *
 *   0-15    system colours, in SGR order
 *           (0 black, 1 red, 2 green, 3 brown, 4 blue, 5 magenta, 6 cyan,
 *            7 light grey, 8 dark grey, 9 light red, 10 light green,
 *            11 yellow, 12 light blue, 13 light magenta, 14 light cyan,
 *            15 white)
 *   16-231  the XTerm 6x6x6 colour cube
 *   232-255 the 24-step greyscale ramp
 *   256-271 Commodore 64 colours
 *   272-273 Atari 8-bit colours
 *   274-281 Atari ST colours
 *
 * The terminal addresses the DAC through a *shadow* palette: when the extended
 * palette is enabled, entry `16 + n` holds DAC entry `n`
 * (src/conio/cterm.c:1949-1961). Consequently `SGR 38;5;N` selects shadow
 * index `N + 16` — i.e. the DAC ordering, not the XTerm ordering.
 *
 * This module exposes the same layout: `Palette.get(0..15)` is the SGR colour
 * set and `Palette.get(16 + n)` is DAC entry `n`.
 */
/** The 16 system colours, in SGR attribute order. */
export declare const DEFAULT_VGA_PALETTE: readonly number[];
/** The Commodore 64 palette (pepto.de "colorvic" values, as shipped upstream). */
export declare const C64_PALETTE: readonly number[];
/** The Atari 8-bit palette: background then foreground. */
export declare const ATARI_PALETTE: readonly number[];
/** The Atari ST palette (RGB333 expanded). */
export declare const ATARI_ST_PALETTE: readonly number[];
/** Number of DAC entries. */
export declare const DAC_SIZE = 282;
/** Offset of the shadow palette (DAC entry `n` lives at shadow index `16 + n`). */
export declare const SHADOW_PALETTE_OFFSET = 16;
/**
 * Build the DAC table: 282 entries.
 */
export declare function buildDacPalette(): number[];
/**
 * A mutable palette.
 *
 * Index 0-15 are the SGR attribute colours; index 16 and above are the
 * shadow palette holding the full DAC.
 */
export declare class Palette {
    private readonly entries;
    private readonly defaults;
    constructor();
    /** Number of addressable entries. */
    get size(): number;
    /** Read an entry as 0xRRGGBB. */
    get(index: number): number;
    /** Write an entry. Out-of-range indices are ignored, matching SyncTERM. */
    set(index: number, rgb: number): void;
    /** Write a DAC entry (applies the shadow offset). */
    setDac(index: number, rgb: number): void;
    /** Read a DAC entry (applies the shadow offset). */
    getDac(index: number): number;
    /** Reset a single entry to its default. */
    reset(index: number): void;
    /** Reset every entry to its default. */
    resetAll(): void;
    /**
     * Replace the 16 SGR attribute colours with a BBS-supplied palette.
     *
     * A Synchronet server sends its palette in SGR attribute order.
     */
    setBase(base: readonly number[]): void;
    /** Snapshot of every entry. */
    toArray(): number[];
}
/**
 * Parse an XTerm `rgb:R/G/B` colour specification (used by OSC 4).
 *
 * Each channel is one to four hex digits; a short channel is scaled to 8 bits.
 */
export declare function parseXtermRgb(spec: string): number | null;
/**
 * Format an RGB value as the XTerm `rgb:R/G/B` specification.
 */
export declare function formatXtermRgb(rgb: number): string;
//# sourceMappingURL=palette.d.ts.map