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
export const DEFAULT_VGA_PALETTE: readonly number[] = [
	0x000000, // 0  black
	0xa80000, // 1  red
	0x00a800, // 2  green
	0xa85400, // 3  brown / dark yellow
	0x0000a8, // 4  blue
	0xa800a8, // 5  magenta
	0x00a8a8, // 6  cyan
	0xa8a8a8, // 7  light grey
	0x545454, // 8  dark grey
	0xff5454, // 9  light red
	0x54ff54, // 10 light green
	0xffff54, // 11 yellow
	0x5454ff, // 12 light blue
	0xff54ff, // 13 light magenta
	0x54ffff, // 14 light cyan
	0xffffff, // 15 white
];

/** The Commodore 64 palette (pepto.de "colorvic" values, as shipped upstream). */
export const C64_PALETTE: readonly number[] = [
	0x000000, 0xffffff, 0x813338, 0x75cec8, 0x8e3c97, 0x56ac4d, 0x2e2c9b, 0xedf171,
	0x8e5029, 0x553800, 0xc46c71, 0x4a4a4a, 0x7b7b7b, 0xa9ff9f, 0x706deb, 0xb2b2b2,
];

/** The Atari 8-bit palette: background then foreground. */
export const ATARI_PALETTE: readonly number[] = [0x005181, 0x60b7e7];

/** The Atari ST palette (RGB333 expanded). */
export const ATARI_ST_PALETTE: readonly number[] = [
	0xb6b6b6, 0x6d6d6d, 0xff6d6d, 0x6dff6d, 0xffff6d, 0x6d6dff, 0xff6dff, 0x6dffff,
];

/** Number of DAC entries. */
export const DAC_SIZE = 282;

/** Offset of the shadow palette (DAC entry `n` lives at shadow index `16 + n`). */
export const SHADOW_PALETTE_OFFSET = 16;

/**
 * Build the DAC table: 282 entries.
 */
export function buildDacPalette(): number[] {
	const dac = new Array<number>(DAC_SIZE);
	for (let i = 0; i < 16; i++) dac[i] = DEFAULT_VGA_PALETTE[i];
	const steps = [0, 95, 135, 175, 215, 255];
	for (let i = 0; i < 216; i++) {
		const r = steps[Math.floor(i / 36) % 6];
		const g = steps[Math.floor(i / 6) % 6];
		const b = steps[i % 6];
		dac[16 + i] = (r << 16) | (g << 8) | b;
	}
	for (let i = 0; i < 24; i++) {
		const v = 8 + i * 10;
		dac[232 + i] = (v << 16) | (v << 8) | v;
	}
	for (let i = 0; i < 16; i++) dac[256 + i] = C64_PALETTE[i];
	dac[272] = ATARI_PALETTE[0];
	dac[273] = ATARI_PALETTE[1];
	for (let i = 0; i < 8; i++) dac[274 + i] = ATARI_ST_PALETTE[i];
	return dac;
}

/**
 * A mutable palette.
 *
 * Index 0-15 are the SGR attribute colours; index 16 and above are the
 * shadow palette holding the full DAC.
 */
export class Palette {
	private readonly entries: number[];
	private readonly defaults: number[];

	constructor() {
		this.defaults = buildDacPalette();
		// entries[0..15]   -> DAC 0..15 (SGR colours)
		// entries[16..297] -> DAC 0..281 (shadow)
		this.entries = new Array<number>(SHADOW_PALETTE_OFFSET + DAC_SIZE);
		for (let i = 0; i < 16; i++) this.entries[i] = this.defaults[i];
		for (let i = 0; i < DAC_SIZE; i++) this.entries[SHADOW_PALETTE_OFFSET + i] = this.defaults[i];
	}

	/** Number of addressable entries. */
	get size(): number {
		return this.entries.length;
	}

	/** Read an entry as 0xRRGGBB. */
	get(index: number): number {
		return this.entries[index] ?? 0;
	}

	/** Write an entry. Out-of-range indices are ignored, matching SyncTERM. */
	set(index: number, rgb: number): void {
		if (index < 0 || index >= this.entries.length) return;
		this.entries[index] = rgb & 0xffffff;
	}

	/** Write a DAC entry (applies the shadow offset). */
	setDac(index: number, rgb: number): void {
		this.set(index + SHADOW_PALETTE_OFFSET, rgb);
	}

	/** Read a DAC entry (applies the shadow offset). */
	getDac(index: number): number {
		return this.get(index + SHADOW_PALETTE_OFFSET);
	}

	/** Reset a single entry to its default. */
	reset(index: number): void {
		if (index < 0 || index >= this.entries.length) return;
		this.entries[index] = this.defaults[index];
	}

	/** Reset every entry to its default. */
	resetAll(): void {
		for (let i = 0; i < this.entries.length; i++) this.entries[i] = this.defaults[i];
	}

	/**
	 * Replace the 16 SGR attribute colours with a BBS-supplied palette.
	 *
	 * A Synchronet server sends its palette in SGR attribute order.
	 */
	setBase(base: readonly number[]): void {
		for (let i = 0; i < 16; i++) {
			const v = base[i];
			if (v === undefined) continue;
			this.entries[i] = v & 0xffffff;
			this.entries[SHADOW_PALETTE_OFFSET + i] = v & 0xffffff;
		}
	}

	/** Snapshot of every entry. */
	toArray(): number[] {
		return this.entries.slice();
	}
}

/**
 * Parse an XTerm `rgb:R/G/B` colour specification (used by OSC 4).
 *
 * Each channel is one to four hex digits; a short channel is scaled to 8 bits.
 */
export function parseXtermRgb(spec: string): number | null {
	const m = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(spec.trim());
	if (!m) return null;
	const scale = (s: string): number => {
		const v = parseInt(s, 16);
		const bits = s.length * 4;
		return bits >= 8 ? v >>> (bits - 8) : v << (8 - bits);
	};
	return ((scale(m[1]) << 16) | (scale(m[2]) << 8) | scale(m[3])) & 0xffffff;
}

/**
 * Format an RGB value as the XTerm `rgb:R/G/B` specification.
 */
export function formatXtermRgb(rgb: number): string {
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
