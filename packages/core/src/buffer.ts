/**
 * The screen buffer: a grid of cells plus a scrollback ring.
 *
 * Cells are stored as struct-of-arrays so that a 132x60 screen with tens of
 * thousands of scrollback lines stays cheap to copy and to serialise.
 */

import { AttrFlags, DEFAULT_COLOR, type ScreenSize } from './types.js';

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
export class ScreenBuffer {
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
	links: LinkRun[] = [];
	private linkIndex = new Map<string, number>();

	/** True when the cell has been written to since the last clear. */
	readonly dirty: Uint8Array;

	constructor(cols: number, rows: number, skipClear = false) {
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
		if (!skipClear) this.clear();
	}

	/** Index of a cell. */
	index(x: number, y: number): number {
		return y * this.cols + x;
	}

	/** Fill every cell with the given attribute. */
	clear(fg = DEFAULT_COLOR, bg = DEFAULT_COLOR, flags = 0): void {
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
	copyRowFrom(src: ScreenBuffer, srcRow: number, dstRow: number): void {
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

	/**
	 * Copy a block of rows.
	 *
	 * `copyWithin` has memmove semantics, so overlapping regions (as used by
	 * scrolling) are handled correctly.
	 */
	copyRows(srcStart: number, dstStart: number, count: number): void {
		if (count <= 0) return;
		const srcOff = srcStart * this.cols;
		const dstOff = dstStart * this.cols;
		const n = count * this.cols;
		this.chars.copyWithin(dstOff, srcOff, srcOff + n);
		this.fg.copyWithin(dstOff, srcOff, srcOff + n);
		this.bg.copyWithin(dstOff, srcOff, srcOff + n);
		this.flags.copyWithin(dstOff, srcOff, srcOff + n);
		this.fgRgb.copyWithin(dstOff, srcOff, srcOff + n);
		this.bgRgb.copyWithin(dstOff, srcOff, srcOff + n);
		this.linkId.copyWithin(dstOff, srcOff, srcOff + n);
		this.dirty.fill(1, dstOff, dstOff + n);
	}

	/** Write a cell. */
	set(x: number, y: number, code: number, fg: number, bg: number, flags: number, fgRgb = 0, bgRgb = 0): void {
		if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
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
	charAt(x: number, y: number): number {
		return this.chars[y * this.cols + x];
	}

	/** Mark a cell dirty. */
	markDirty(x: number, y: number): void {
		if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
		this.dirty[y * this.cols + x] = 1;
	}

	/** Register (or look up) a hyperlink and return its id. */
	internLink(uri: string, id?: string): number {
		const key = `${id ?? ''}\u0000${uri}`;
		const existing = this.linkIndex.get(key);
		if (existing !== undefined) return existing;
		const idx = this.links.length;
		this.links.push({ start: 0, length: 0, uri, id });
		this.linkIndex.set(key, idx);
		return idx;
	}

	/** Look up a link id. */
	link(id: number): LinkRun | undefined {
		return this.links[id];
	}

	/** Extract a row of text (for copy/clipboard). */
	rowText(y: number, mapper: (byte: number) => number): string {
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
	private readonly rows: ScreenBuffer[] = [];
	private head = 0;
	private count = 0;

	constructor(private readonly capacity: number) {}

	/** Number of stored rows. */
	get length(): number {
		return this.count;
	}

	/** Maximum number of stored rows. */
	get limit(): number {
		return this.capacity;
	}

	/** Append a copy of the given screen row. */
	push(screen: ScreenBuffer, row: number): void {
		if (this.capacity <= 0) return;
		const index =
			this.count === this.capacity ? this.head : (this.head + this.count) % this.capacity;
		// The row buffers are reused rather than reallocated: scrolling a
		// full screen is a hot path.
		let copy = this.rows[index];
		if (!copy) {
			copy = new ScreenBuffer(screen.cols, 1, true);
			this.rows[index] = copy;
		}
		copy.copyRowFrom(screen, row, 0);
		copy.links = screen.links;
		if (this.count === this.capacity) {
			this.head = (this.head + 1) % this.capacity;
		} else {
			this.count++;
		}
	}

	/** Read a row by logical index (0 = oldest). */
	get(index: number): ScreenBuffer | undefined {
		if (index < 0 || index >= this.count) return undefined;
		return this.rows[(this.head + index) % this.capacity];
	}

	/** Remove all rows. */
	clear(): void {
		this.rows.length = 0;
		this.head = 0;
		this.count = 0;
	}

	/** Discard the oldest `n` rows. */
	trim(n: number): void {
		const remove = Math.min(n, this.count);
		for (let i = 0; i < remove; i++) {
			this.rows[(this.head + i) % this.capacity] = undefined as unknown as ScreenBuffer;
		}
		this.head = (this.head + remove) % this.capacity;
		this.count -= remove;
	}
}

/** Attribute helper: build the flag mask for a cell. */
export function makeFlags(
	blink: boolean,
	bold: boolean,
	reverse: boolean,
	concealed: boolean,
	fgSet: boolean,
	bgSet: boolean,
	thin: boolean,
): number {
	let f = 0;
	if (blink) f |= AttrFlags.Blink;
	if (bold) f |= AttrFlags.Bold;
	if (reverse) f |= AttrFlags.Reverse;
	if (concealed) f |= AttrFlags.Concealed;
	if (fgSet) f |= AttrFlags.FgSet;
	if (bgSet) f |= AttrFlags.BgSet;
	if (thin) f |= AttrFlags.Thin;
	return f;
}
