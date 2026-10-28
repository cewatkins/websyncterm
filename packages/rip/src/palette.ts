// RIPscrip colour model.
//
// The 16-colour RIP palette is a mapping into a fixed 64-entry EGA master
// palette.  Master palette components are only ever 0x00, 0x55, 0xAA or
// 0xFF.  Colours are exposed as 0xAARRGGBB values, matching the pixel
// buffer format used by the renderer.

/** 64-entry EGA master palette, as 0xFFRRGGBB. */
export const MASTER_PALETTE: readonly number[] = [
	0xff000000, 0xff0000aa, 0xff00aa00, 0xff00aaaa,
	0xffaa0000, 0xffaa00aa, 0xffaaaa00, 0xffaaaaaa,
	0xff000055, 0xff0000ff, 0xff00aa55, 0xff00aaff,
	0xffaa0055, 0xffaa00ff, 0xffaaaa55, 0xffaaaaff,
	0xff005500, 0xff0055aa, 0xff00ff00, 0xff00ffaa,
	0xffaa5500, 0xffaa55aa, 0xffaaff00, 0xffaaffaa,
	0xff005555, 0xff0055ff, 0xff00ff55, 0xff00ffff,
	0xffaa5555, 0xffaa55ff, 0xffaaff55, 0xffaaffff,
	0xff550000, 0xff5500aa, 0xff55aa00, 0xff55aaaa,
	0xffff0000, 0xffff00aa, 0xffffaa00, 0xffffaaaa,
	0xff550055, 0xff5500ff, 0xff55aa55, 0xff55aaff,
	0xffff0055, 0xffff00ff, 0xffffaa55, 0xffffaaff,
	0xff555500, 0xff5555aa, 0xff55ff00, 0xff55ffaa,
	0xffff5500, 0xffff55aa, 0xffffff00, 0xffffffaa,
	0xff555555, 0xff5555ff, 0xff55ff55, 0xff55ffff,
	0xffff5555, 0xffff55ff, 0xffffff55, 0xffffffff,
];

/** Default RIP mapping: colour index -> master palette index. */
export const DEFAULT_PALETTE: readonly number[] = [
	0, 1, 2, 3, 4, 5, 20, 7, 56, 57, 58, 59, 60, 61, 62, 63,
];

/** Default drawing colour (colour index 1). */
export const DEFAULT_COLOR = 1;
/** Default fill colour (colour index 7). */
export const DEFAULT_FILL_COLOR = 7;

/** Convert a master palette index to an 0xAARRGGBB value. */
export function masterColor(index: number): number {
	return MASTER_PALETTE[index & 0x3f] ?? 0xff000000;
}

/**
 * Resolve a RIP colour index (0-15) through a palette mapping to an
 * 0xAARRGGBB value.  Indices outside 0-15 resolve to black, matching the
 * fact that the interpreter only ever stores 4-bit drawing colours.
 */
export function mapColor(index: number, palette: readonly number[]): number {
	const master = palette[index & 0x0f] ?? 0;
	return masterColor(master);
}

/** A mutable RIP 16-colour palette. */
export class RipPalette {
	private readonly mapping: number[];

	constructor(initial?: readonly number[]) {
		this.mapping = new Array<number>(16).fill(0);
		this.setAll(initial ?? DEFAULT_PALETTE);
	}

	/** Current colour index -> master index mapping (copy). */
	get entries(): number[] {
		return this.mapping.slice();
	}

	/** Resolve a colour index to 0xAARRGGBB. */
	color(index: number): number {
		return mapColor(index, this.mapping);
	}

	/** Set all 16 entries.  Values must already be in 0-63. */
	setAll(values: readonly number[]): void {
		for (let i = 0; i < 16; i++) {
			const v = values[i];
			this.mapping[i] = typeof v === 'number' && v >= 0 && v <= 63
				? v
				: DEFAULT_PALETTE[i]!;
		}
	}

	/** Set one entry (0-15) to a master index (0-63). */
	setOne(index: number, value: number): void {
		if (index < 0 || index > 15 || value < 0 || value > 63)
			return;
		this.mapping[index] = value;
	}

	/** Restore the default 16-colour mapping. */
	reset(): void {
		this.setAll(DEFAULT_PALETTE);
	}

	/**
	 * Reverse lookup: find the colour index whose resolved RGB matches.
	 * Returns -1 when the value is not one of the 16 palette colours.
	 */
	indexOf(rgb: number): number {
		for (let i = 0; i < 16; i++) {
			if (this.color(i) === rgb)
				return i;
		}
		return -1;
	}
}
