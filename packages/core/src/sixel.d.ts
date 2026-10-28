/**
 * Sixel graphics decoder.
 *
 * Mirrors the behaviour of `cterm_dec.c` in SynchronetBBS/sbbs:
 *
 *  - The intro is `DCS P1 [;P2 [;P3]] q`. P1 is a *vertical replication
 *    factor* (0/1/5/6 -> 2, 2 -> 5, 3/4 -> 3, 7/8/9 -> 1, otherwise 2) and
 *    P2 selects the background behaviour (0 = opaque, non-zero = transparent).
 *  - Raster attributes (`"`) are only honoured before the first data byte;
 *    P1 overrides the vertical multiplier and P2 is a horizontal
 *    replication factor.
 *  - `#Pc` selects a colour, `#Pc;2;Pr;Pg;Pb` defines one (percentages).
 *  - `!Pn` repeats the next data character, `$` returns to the left border
 *    and `-` starts a new sixel row.
 *  - Data characters are `?`..`~`; each carries six vertical pixels with the
 *    least significant bit at the top.
 */
import type { Palette } from './palette.js';
/** Options supplied when a sixel string starts. */
export interface SixelOptions {
    /** Intro parameter 1 (vertical replication factor). */
    p1: number;
    /** Intro parameter 2 (background/transparency). */
    p2: number;
    /** Text cursor column at the time the string started (0-based). */
    originX: number;
    /** Text cursor row at the time the string started (0-based). */
    originY: number;
    /** Whether sixel scrolling (DECSET 80) is enabled. */
    scrolling: boolean;
    /** The palette used to resolve colour indices. */
    palette: Palette;
    /** Current foreground palette index. */
    fg: number;
    /** Current background palette index. */
    bg: number;
}
/** The decoded image. */
export interface SixelImage {
    /** Palette index per pixel; -1 means "leave the background alone". */
    pixels: Int32Array;
    width: number;
    height: number;
    /** Origin of the image in device pixels. */
    baseX: number;
    baseY: number;
    /** Where the cursor ends up, in device pixels relative to the origin. */
    cursorX: number;
    cursorY: number;
}
export declare class SixelDecoder {
    private opts;
    private pixels;
    private width;
    private height;
    private x;
    private y;
    private colour;
    private transparent;
    private repeat;
    private pending;
    private sentPixels;
    private pixelHeight;
    private pixelWidth;
    private declaredWidth;
    private declaredHeight;
    private active;
    /** Begin a new sixel image. */
    reset(opts: SixelOptions): void;
    private band;
    private bandWidth;
    /** Feed one byte of the sixel body. */
    feed(byte: number): void;
    /** Collect a numeric argument. */
    private collectNumber;
    private ensureBandWidth;
    /** Draw one sixel (six vertical pixels) at the current position. */
    private drawSixel;
    /** Copy the current band into the image buffer. */
    private flushBand;
    /** Finish the image and return it. */
    finish(): SixelImage | null;
}
/** Map an intro P1 value to the vertical replication factor. */
export declare function verticalMultiplier(p1: number): number;
//# sourceMappingURL=sixel.d.ts.map