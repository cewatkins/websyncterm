/**
 * The screen buffer: a grid of cells plus a scrollback ring.
 *
 * Cells are stored as struct-of-arrays so that a 132x60 screen with tens of
 * thousands of scrollback lines stays cheap to copy and to serialise.
 */
import { AttrFlags, DEFAULT_COLOR } from './types.js';
/** A contiguous span of a single scrollback row. */
export class ScreenBuffer {
    cols;
    rows;
    /** Unicode code point per cell. */
    chars;
    /** Foreground palette index, or DEFAULT_COLOR. */
    fg;
    /** Background palette index, or DEFAULT_COLOR. */
    bg;
    /** AttrFlags bitmask. */
    flags;
    /** 24-bit foreground override. */
    fgRgb;
    /** 24-bit background override. */
    bgRgb;
    /** Hyperlink id per cell (index into `links`), or -1. */
    linkId;
    /** Hyperlink table shared by the screen and the scrollback. */
    links = [];
    linkIndex = new Map();
    /** True when the cell has been written to since the last clear. */
    dirty;
    constructor(cols, rows) {
        this.cols = cols;
        this.rows = rows;
        const n = cols * rows;
        this.chars = new Uint16Array(n);
        this.fg = new Int16Array(n);
        this.bg = new Int16Array(n);
        this.flags = new Uint16Array(n);
        this.fgRgb = new Uint32Array(n);
        this.bgRgb = new Uint32Array(n);
        this.linkId = new Int32Array(n);
        this.dirty = new Uint8Array(n);
        this.linkId.fill(-1);
        this.clear();
    }
    /** Index of a cell. */
    index(x, y) {
        return y * this.cols + x;
    }
    /** Fill every cell with the given attribute. */
    clear(fg = DEFAULT_COLOR, bg = DEFAULT_COLOR, flags = 0) {
        this.fg.fill(fg);
        this.bg.fill(bg);
        this.flags.fill(flags);
        this.fgRgb.fill(0);
        this.bgRgb.fill(0);
        this.linkId.fill(-1);
        this.chars.fill(0x20);
        this.dirty.fill(1);
    }
    /** Copy one row of cells from another buffer. */
    copyRowFrom(src, srcRow, dstRow) {
        const off = srcRow * src.cols;
        const doff = dstRow * this.cols;
        const n = Math.min(src.cols, this.cols);
        this.chars.set(src.chars.subarray(off, off + n), doff);
        this.fg.set(src.fg.subarray(off, off + n), doff);
        this.bg.set(src.bg.subarray(off, off + n), doff);
        this.flags.set(src.flags.subarray(off, off + n), doff);
        this.fgRgb.set(src.fgRgb.subarray(off, off + n), doff);
        this.bgRgb.set(src.bgRgb.subarray(off, off + n), doff);
        this.linkId.set(src.linkId.subarray(off, off + n), doff);
        this.dirty.fill(1, doff, doff + n);
    }
    /** Write a cell. */
    set(x, y, code, fg, bg, flags, fgRgb = 0, bgRgb = 0) {
        if (x < 0 || y < 0 || x >= this.cols || y >= this.rows)
            return;
        const i = y * this.cols + x;
        this.chars[i] = code;
        this.fg[i] = fg;
        this.bg[i] = bg;
        this.flags[i] = flags;
        this.fgRgb[i] = fgRgb;
        this.bgRgb[i] = bgRgb;
        this.dirty[i] = 1;
    }
    /** Read the character at a cell. */
    charAt(x, y) {
        return this.chars[y * this.cols + x];
    }
    /** Mark a cell dirty. */
    markDirty(x, y) {
        if (x < 0 || y < 0 || x >= this.cols || y >= this.rows)
            return;
        this.dirty[y * this.cols + x] = 1;
    }
    /** Register (or look up) a hyperlink and return its id. */
    internLink(uri, id) {
        const key = `${id ?? ''}\u0000${uri}`;
        const existing = this.linkIndex.get(key);
        if (existing !== undefined)
            return existing;
        const idx = this.links.length;
        this.links.push({ start: 0, length: 0, uri, id });
        this.linkIndex.set(key, idx);
        return idx;
    }
    /** Look up a link id. */
    link(id) {
        return this.links[id];
    }
    /** Extract a row of text (for copy/clipboard). */
    rowText(y, mapper) {
        let out = '';
        const base = y * this.cols;
        for (let x = 0; x < this.cols; x++) {
            out += String.fromCodePoint(mapper(this.chars[base + x]));
        }
        return out;
    }
}
/**
 * A scrollback buffer: a ring of complete screen rows.
 */
export class Scrollback {
    capacity;
    rows = [];
    head = 0;
    count = 0;
    constructor(capacity) {
        this.capacity = capacity;
    }
    /** Number of stored rows. */
    get length() {
        return this.count;
    }
    /** Maximum number of stored rows. */
    get limit() {
        return this.capacity;
    }
    /** Append a copy of the given screen row. */
    push(screen, row) {
        if (this.capacity <= 0)
            return;
        const copy = new ScreenBuffer(screen.cols, 1);
        copy.copyRowFrom(screen, row, 0);
        copy.links = screen.links;
        if (this.count === this.capacity) {
            this.rows[this.head] = copy;
            this.head = (this.head + 1) % this.capacity;
        }
        else {
            this.rows[(this.head + this.count) % this.capacity] = copy;
            this.count++;
        }
    }
    /** Read a row by logical index (0 = oldest). */
    get(index) {
        if (index < 0 || index >= this.count)
            return undefined;
        return this.rows[(this.head + index) % this.capacity];
    }
    /** Remove all rows. */
    clear() {
        this.rows.length = 0;
        this.head = 0;
        this.count = 0;
    }
    /** Discard the oldest `n` rows. */
    trim(n) {
        const remove = Math.min(n, this.count);
        for (let i = 0; i < remove; i++) {
            this.rows[(this.head + i) % this.capacity] = undefined;
        }
        this.head = (this.head + remove) % this.capacity;
        this.count -= remove;
    }
}
/** Attribute helper: build the flag mask for a cell. */
export function makeFlags(blink, bold, reverse, concealed, fgSet, bgSet, thin) {
    let f = 0;
    if (blink)
        f |= AttrFlags.Blink;
    if (bold)
        f |= AttrFlags.Bold;
    if (reverse)
        f |= AttrFlags.Reverse;
    if (concealed)
        f |= AttrFlags.Concealed;
    if (fgSet)
        f |= AttrFlags.FgSet;
    if (bgSet)
        f |= AttrFlags.BgSet;
    if (thin)
        f |= AttrFlags.Thin;
    return f;
}
//# sourceMappingURL=buffer.js.map