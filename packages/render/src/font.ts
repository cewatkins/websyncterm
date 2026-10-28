/**
 * SyncTERM bitmap font engine.
 *
 * The on-disk format is the one used by `src/conio/allfonts.c` and the user
 * supplied `.fNN` files in `src/syncterm/fonts/`:
 *
 *   - There is **no header**.  The data is a raw sequence of 256 glyphs.
 *   - Each glyph is `height` rows of `ceil(width / 8)` bytes, top to bottom.
 *   - Within a row the first byte holds the leftmost eight pixels with the
 *     most significant bit (bit 7) being the leftmost pixel.
 *   - 12 pixel wide glyphs use two bytes per row, big-endian, with the twelve
 *     active pixels in the high twelve bits and the low nibble unused.
 *
 * The font face is inferred from the byte length only, exactly like upstream
 * (`bitmap_loadfont_locked()`): a file that happens to be named `foo.f16` but
 * is 3584 bytes long is an 8x14 face.
 */

/** A bitmap font face (256 glyphs in code page byte order). */
export class BitmapFont {
	/** Glyph cell width in pixels (8 or 12). */
	readonly width: number;
	/** Glyph cell height in pixels. */
	readonly height: number;
	/** Raw glyph data. */
	readonly glyphs: Uint8Array;
	/** Bytes per glyph scanline (`ceil(width / 8)`). */
	readonly bytesPerRow: number;
	/** Bytes per glyph. */
	readonly glyphBytes: number;

	constructor(width: number, height: number, glyphs: Uint8Array) {
		this.width = width;
		this.height = height;
		this.bytesPerRow = Math.ceil(width / 8);
		this.glyphBytes = this.height * this.bytesPerRow;
		const expected = 256 * this.glyphBytes;
		if (glyphs.length !== expected) {
			throw new RangeError(
				`font data is ${glyphs.length} bytes, expected ${expected} for ${width}x${height}`,
			);
		}
		this.glyphs = glyphs;
	}

	/** Byte offset of a glyph in `glyphs`. */
	glyphOffset(code: number): number {
		return (code & 0xff) * this.glyphBytes;
	}

	/**
	 * Read a pixel.
	 *
	 * With two arguments the pixel is read from glyph 0; with three the first
	 * argument selects the glyph.
	 */
	getPixel(x: number, y: number): boolean;
	getPixel(code: number, x: number, y: number): boolean;
	getPixel(a: number, b: number, c?: number): boolean {
		const code = c === undefined ? 0 : a;
		const x = c === undefined ? a : b;
		const y = c === undefined ? b : c;
		if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
		const offset = this.glyphOffset(code) + y * this.bytesPerRow + (x >> 3);
		const byte = this.glyphs[offset];
		return byte !== undefined && (byte & (0x80 >> (x & 7))) !== 0;
	}

	/** Read a pixel of a specific glyph. */
	getGlyphPixel(code: number, x: number, y: number): boolean {
		return this.getPixel(code, x, y);
	}

	/**
	 * Read a pixel as it is displayed in a cell that may be wider than the
	 * stored glyph (the VGA 9 pixel cell).
	 *
	 * Upstream `src/conio/bitmap_con.c:860-885` synthesises the ninth column:
	 * for the single-line box drawing characters 0xC0..0xDF the ninth pixel
	 * duplicates the eighth (the last pixel of the row); every other character
	 * leaves it blank.
	 */
	getCellPixel(code: number, x: number, y: number, cellWidth = this.width): boolean {
		if (x < this.width) return this.getPixel(code, x, y);
		if (cellWidth === 9 && x === 8) {
			return code >= 0xc0 && code <= 0xdf ? this.getPixel(code, 7, y) : false;
		}
		return false;
	}
}

/** A recognised font face geometry. */
export interface FontVariant {
	readonly width: number;
	readonly height: number;
}

/** Font faces recognised by byte length (upstream `allfonts.c`). */
export const FONT_VARIANTS: Readonly<Record<number, FontVariant>> = {
	1536: { width: 8, height: 6 },
	1792: { width: 8, height: 7 },
	2048: { width: 8, height: 8 },
	2560: { width: 8, height: 10 },
	3072: { width: 8, height: 12 },
	3328: { width: 8, height: 13 },
	3584: { width: 8, height: 14 },
	4096: { width: 8, height: 16 },
	10240: { width: 12, height: 20 },
};

/** Infer the face geometry from a raw font length, or `null`. */
export function inferFontVariant(size: number): FontVariant | null {
	return FONT_VARIANTS[size] ?? null;
}

/** Load a font from raw bytes, inferring the geometry from the data length. */
export function loadFontFromBytes(data: Uint8Array): BitmapFont | null {
	if (!(data instanceof Uint8Array)) return null;
	const variant = inferFontVariant(data.length);
	if (!variant) return null;
	return new BitmapFont(variant.width, variant.height, data);
}

// ---------------------------------------------------------------------------
// Built-in codepage fonts
// ---------------------------------------------------------------------------

/** Heights supported by the built-in font table. */
export type BuiltinFontHeight = 8 | 14 | 16 | 20;

const BUILTIN_HEIGHT_KEYS: Readonly<Record<BuiltinFontHeight, string>> = {
	8: '8x8',
	14: '8x14',
	16: '8x16',
	20: '12x20',
};

/** One slot of the upstream `conio_fontdata` table. */
export interface BuiltinFontSlot {
	'8x16'?: string;
	'8x14'?: string;
	'8x8'?: string;
	'12x20'?: string;
	cp?: string;
	brokenBar?: boolean;
}

/** The parsed contents of `assets/fonts/builtin-fonts.json`. */
export interface BuiltinFontData {
	fonts: Record<string, BuiltinFontSlot>;
}

/** Decode standard base64 without requiring a DOM or Node Buffer type. */
export function decodeBase64(text: string): Uint8Array {
	const g = globalThis as unknown as {
		atob?: (data: string) => string;
		Buffer?: { from(data: string, encoding: string): Uint8Array };
	};
	if (typeof g.atob === 'function') {
		const binary = g.atob(text);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff;
		return out;
	}
	if (g.Buffer) return new Uint8Array(g.Buffer.from(text, 'base64'));
	throw new Error('no base64 decoder available');
}

/**
 * A set of built-in fonts, indexed in upstream `conio_fontdata` slot order.
 */
export class BuiltinFontSet {
	/** Slot descriptions (index == slot). */
	readonly names: readonly string[];
	readonly data: BuiltinFontData;

	private readonly cache = new Map<string, BitmapFont | null>();

	constructor(data: BuiltinFontData) {
		this.data = data;
		this.names = Object.keys(data.fonts ?? {});
	}

	/** Number of slots. */
	get slotCount(): number {
		return this.names.length;
	}

	/** Description of a slot, or an empty string. */
	slotName(slot: number): string {
		return this.names[slot] ?? '';
	}

	/**
	 * Look a font up by slot and height.
	 *
	 * Mirrors `bitmap_loadfont_locked()`: an unknown slot falls back to slot 0,
	 * and a missing face falls back to slot 0's face of the same height.
	 */
	getFont(slot: number, height: BuiltinFontHeight): BitmapFont | null {
		if (this.names.length === 0) return null;
		const key = BUILTIN_HEIGHT_KEYS[height];
		if (!key) return null;
		const valid = slot >= 0 && slot < this.names.length ? slot : 0;
		const direct = this.load(valid, key);
		if (direct) return direct;
		return valid === 0 ? null : this.load(0, key);
	}

	private load(slot: number, key: string): BitmapFont | null {
		const cacheKey = `${slot}:${key}`;
		const cached = this.cache.get(cacheKey);
		if (cached !== undefined) return cached;
		const name = this.names[slot];
		const encoded = name === undefined ? undefined : (this.data.fonts[name] as Record<string, unknown> | undefined)?.[key];
		let font: BitmapFont | null = null;
		if (typeof encoded === 'string' && encoded.length > 0) {
			font = loadFontFromBytes(decodeBase64(encoded));
		}
		this.cache.set(cacheKey, font);
		return font;
	}
}

/** Parse the built-in font JSON (or accept an already parsed object). */
export function parseBuiltinFonts(source: BuiltinFontData | string): BuiltinFontSet {
	const data = typeof source === 'string' ? (JSON.parse(source) as BuiltinFontData) : source;
	return new BuiltinFontSet(data);
}

/** Parse the built-in font JSON and install it as the default set. */
export function loadBuiltinFonts(source: BuiltinFontData | string): BuiltinFontSet {
	return setBuiltinFonts(source);
}

let defaultBuiltinFonts: BuiltinFontSet | null = null;

/** Install the set used by {@link getBuiltinFont}. */
export function setBuiltinFonts(source: BuiltinFontSet | BuiltinFontData | string): BuiltinFontSet {
	defaultBuiltinFonts = source instanceof BuiltinFontSet ? source : parseBuiltinFonts(source);
	return defaultBuiltinFonts;
}

/** The currently installed built-in font set (if any). */
export function getBuiltinFontSet(): BuiltinFontSet | null {
	return defaultBuiltinFonts;
}

/** Look up a built-in font by slot and height. */
export function getBuiltinFont(slot: number, height: BuiltinFontHeight): BitmapFont | null {
	return defaultBuiltinFonts ? defaultBuiltinFonts.getFont(slot, height) : null;
}

/** Default location of the built-in font JSON, relative to the package root. */
export const BUILTIN_FONTS_PATH = 'assets/fonts/builtin-fonts.json';

/** Fetch and install the built-in font JSON. */
export async function fetchBuiltinFonts(
	url: string = BUILTIN_FONTS_PATH,
	fetchImpl: typeof fetch | undefined = undefined,
): Promise<BuiltinFontSet> {
	const fn = fetchImpl ?? globalThis.fetch;
	if (typeof fn !== 'function') throw new Error('fetch is not available');
	const response = await fn(url);
	if (!response.ok) throw new Error(`failed to load fonts: ${response.status} ${response.statusText}`);
	const data = (await response.json()) as BuiltinFontData;
	return setBuiltinFonts(data);
}

// ---------------------------------------------------------------------------
// User supplied .fNN fonts
// ---------------------------------------------------------------------------

/** One entry of the user font manifest. */
export interface UserFontEntry {
	readonly name: string;
	readonly file: string;
	readonly height: number;
}

/** Base path of the copied upstream `.fNN` files. */
export const USER_FONTS_PATH = 'assets/fonts/user';

/** All user fonts shipped with the package (74 files). */
export const USER_FONT_MANIFEST: readonly UserFontEntry[] = [
	{ name: '25', file: '25.f16', height: 16 },
	{ name: '28', file: '28.f14', height: 14 },
	{ name: '50', file: '50.f8', height: 8 },
	{ name: 'antique', file: 'antique.f14', height: 14 },
	{ name: 'antique', file: 'antique.f16', height: 16 },
	{ name: 'backward', file: 'backward.f16', height: 16 },
	{ name: 'big', file: 'big.f16', height: 16 },
	{ name: 'bigserif', file: 'bigserif.f16', height: 16 },
	{ name: 'block', file: 'block.f16', height: 16 },
	{ name: 'bold', file: 'bold.f10', height: 10 },
	{ name: 'bold', file: 'bold.f12', height: 12 },
	{ name: 'bold', file: 'bold.f13', height: 13 },
	{ name: 'bold', file: 'bold.f14', height: 14 },
	{ name: 'bold', file: 'bold.f16', height: 16 },
	{ name: 'bold', file: 'bold.f8', height: 8 },
	{ name: 'bren', file: 'bren.f16', height: 16 },
	{ name: 'broadway', file: 'broadway.f16', height: 16 },
	{ name: 'computer', file: 'computer.f14', height: 14 },
	{ name: 'computer', file: 'computer.f16', height: 16 },
	{ name: 'courier', file: 'courier.f14', height: 14 },
	{ name: 'courier', file: 'courier.f16', height: 16 },
	{ name: 'deco', file: 'deco.f16', height: 16 },
	{ name: 'digital', file: 'digital.f16', height: 16 },
	{ name: 'empty', file: 'empty.f16', height: 16 },
	{ name: 'eurotype', file: 'eurotype.f16', height: 16 },
	{ name: 'frankfrt', file: 'frankfrt.f14', height: 14 },
	{ name: 'future', file: 'future.f16', height: 16 },
	{ name: 'georgian', file: 'georgian.f14', height: 14 },
	{ name: 'gothical', file: 'gothical.f16', height: 16 },
	{ name: 'greek', file: 'greek.f16', height: 16 },
	{ name: 'hearst', file: 'hearst.f14', height: 14 },
	{ name: 'hearst', file: 'hearst.f16', height: 16 },
	{ name: 'hebrew', file: 'hebrew.f16', height: 16 },
	{ name: 'ibmstd', file: 'ibmstd.f16', height: 16 },
	{ name: 'ice', file: 'ice.f16', height: 16 },
	{ name: 'inverted', file: 'inverted.f16', height: 16 },
	{ name: 'italics', file: 'italics.f16', height: 16 },
	{ name: 'jasnew', file: 'jasnew.f16', height: 16 },
	{ name: 'lcd', file: 'lcd.f16', height: 16 },
	{ name: 'lorefont', file: 'lorefont.f16', height: 16 },
	{ name: 'magic', file: 'magic.f16', height: 16 },
	{ name: 'medieval', file: 'medieval.f16', height: 16 },
	{ name: 'medievl-', file: 'medievl-.f16', height: 16 },
	{ name: 'modern', file: 'modern.f16', height: 16 },
	{ name: 'modern-r', file: 'modern-r.f16', height: 16 },
	{ name: 'oldeng', file: 'oldeng.f14', height: 14 },
	{ name: 'prestel', file: 'prestel.f16', height: 16 },
	{ name: 'reverse', file: 'reverse.f16', height: 16 },
	{ name: 'roman-1', file: 'roman-1.f16', height: 16 },
	{ name: 'roman', file: 'roman.f16', height: 16 },
	{ name: 'sansrif-', file: 'sansrif-.f16', height: 16 },
	{ name: 'scott', file: 'scott.f16', height: 16 },
	{ name: 'scrawl-1', file: 'scrawl-1.f16', height: 16 },
	{ name: 'scrawl-2', file: 'scrawl-2.f16', height: 16 },
	{ name: 'scribble', file: 'scribble.f16', height: 16 },
	{ name: 'script', file: 'script.f14', height: 14 },
	{ name: 'script', file: 'script.f16', height: 16 },
	{ name: 'senapl', file: 'senapl.f8', height: 8 },
	{ name: 'side', file: 'side.f8', height: 8 },
	{ name: 'smalcaps', file: 'smalcaps.f14', height: 14 },
	{ name: 'standard', file: 'standard.f16', height: 16 },
	{ name: 'strange', file: 'strange.f14', height: 14 },
	{ name: 'stretch', file: 'stretch.f16', height: 16 },
	{ name: 'super', file: 'super.f16', height: 16 },
	{ name: 'swiss-1', file: 'swiss-1.f16', height: 16 },
	{ name: 'swiss-2', file: 'swiss-2.f16', height: 16 },
	{ name: 'swiss-3', file: 'swiss-3.f16', height: 16 },
	{ name: 'tekton', file: 'tekton.f16', height: 16 },
	{ name: 'thai', file: 'thai.f16', height: 16 },
	{ name: 'thick', file: 'thick.f16', height: 16 },
	{ name: 'thin', file: 'thin.f16', height: 16 },
	{ name: 'tiny', file: 'tiny.f6', height: 6 },
	{ name: 'tiny', file: 'tiny.f7', height: 7 },
	{ name: 'tiny', file: 'tiny.f8', height: 8 },
];

/** Infer the nominal height from a `.fNN` suffix. */
export function inferHeightFromFilename(file: string): number | null {
	const match = /\.f(\d+)$/i.exec(file);
	if (!match) return null;
	const height = Number.parseInt(match[1], 10);
	return Number.isFinite(height) ? height : null;
}

/** Find a manifest entry by file name or font name. */
export function findUserFont(nameOrFile: string): UserFontEntry | undefined {
	return USER_FONT_MANIFEST.find((entry) => entry.file === nameOrFile || entry.name === nameOrFile);
}

/** Fetch a user font by URL (the result is validated by byte length). */
export async function loadUserFont(
	url: string,
	fetchImpl: typeof fetch | undefined = undefined,
): Promise<BitmapFont | null> {
	const fn = fetchImpl ?? globalThis.fetch;
	if (typeof fn !== 'function') throw new Error('fetch is not available');
	const response = await fn(url);
	if (!response.ok) throw new Error(`failed to load font: ${response.status} ${response.statusText}`);
	const buffer = await response.arrayBuffer();
	return loadFontFromBytes(new Uint8Array(buffer));
}

/** Fetch a manifest entry relative to a base URL. */
export async function loadUserFontEntry(
	entry: UserFontEntry,
	baseUrl: string = USER_FONTS_PATH,
	fetchImpl: typeof fetch | undefined = undefined,
): Promise<BitmapFont | null> {
	const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
	return loadUserFont(`${base}${entry.file}`, fetchImpl);
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

/** A canvas that works in the main thread and in workers. */
export type RenderCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Either 2D context flavour. */
export type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Create an offscreen (or detached) canvas, or `null` without a DOM. */
export function createCanvas2D(width: number, height: number): RenderCanvas | null {
	const g = globalThis as unknown as { OffscreenCanvas?: typeof OffscreenCanvas; document?: Document };
	if (typeof g.OffscreenCanvas !== 'undefined') {
		try {
			return new g.OffscreenCanvas(Math.max(1, width), Math.max(1, height));
		} catch {
			/* fall through */
		}
	}
	if (typeof g.document !== 'undefined' && typeof g.document.createElement === 'function') {
		const canvas = g.document.createElement('canvas');
		canvas.width = Math.max(1, width);
		canvas.height = Math.max(1, height);
		return canvas;
	}
	return null;
}

/** Get a 2D context from a canvas. */
export function get2DContext(canvas: RenderCanvas): Context2D | null {
	return (canvas as HTMLCanvasElement).getContext('2d') as Context2D | null;
}

// ---------------------------------------------------------------------------
// Glyph atlas
// ---------------------------------------------------------------------------

export interface GlyphAtlasOptions {
	/** Cell width; defaults to the font width. Use 9 for the VGA cell. */
	cellWidth?: number;
	/** Cell height; defaults to the font height. */
	cellHeight?: number;
	/** Integer pixel scale; defaults to 1. */
	scale?: number;
	/** Atlas columns; defaults to 16. */
	columns?: number;
	/** Colour of the glyph pixels (CSS colour); defaults to white. */
	foreground?: string;
}

/** A glyph atlas ready for `drawImage` blitting. */
export interface GlyphAtlas {
	readonly canvas: RenderCanvas;
	readonly font: BitmapFont;
	readonly cellWidth: number;
	readonly cellHeight: number;
	readonly scale: number;
	readonly columns: number;
	readonly rows: number;
	/** Atlas source rectangle of a glyph code. */
	cellRect(code: number): { sx: number; sy: number };
}

/**
 * Rasterise a font into a 16x16 (or `columns` wide) atlas.
 *
 * Returns `null` when no canvas implementation is available (for example in
 * Node), in which case callers should use {@link drawGlyphDirect}.
 */
export function buildGlyphAtlas(font: BitmapFont, options: GlyphAtlasOptions = {}): GlyphAtlas | null {
	const scale = Math.max(1, Math.floor(options.scale ?? 1));
	const cellWidth = Math.max(font.width, Math.floor(options.cellWidth ?? font.width));
	const cellHeight = Math.max(font.height, Math.floor(options.cellHeight ?? font.height));
	const columns = Math.max(1, Math.floor(options.columns ?? 16));
	const rows = Math.ceil(256 / columns);
	const canvas = createCanvas2D(cellWidth * columns * scale, cellHeight * rows * scale);
	if (!canvas) return null;
	const ctx = get2DContext(canvas);
	if (!ctx) return null;
	ctx.imageSmoothingEnabled = false;
	ctx.fillStyle = options.foreground ?? '#ffffff';

	for (let code = 0; code < 256; code++) {
		const cx = (code % columns) * cellWidth * scale;
		const cy = Math.floor(code / columns) * cellHeight * scale;
		for (let y = 0; y < font.height; y++) {
			for (let x = 0; x < cellWidth; x++) {
				if (!font.getCellPixel(code, x, y, cellWidth)) continue;
				ctx.fillRect(cx + x * scale, cy + y * scale, scale, scale);
			}
		}
	}

	return {
		canvas,
		font,
		cellWidth,
		cellHeight,
		scale,
		columns,
		rows,
		cellRect(code: number): { sx: number; sy: number } {
			const index = code & 0xff;
			return {
				sx: (index % columns) * cellWidth * scale,
				sy: Math.floor(index / columns) * cellHeight * scale,
			};
		},
	};
}

/** Recolour an atlas by filling its opaque pixels with `color`. */
export function tintGlyphAtlas(atlas: GlyphAtlas, color: number | string): RenderCanvas | null {
	const width = atlas.canvas.width;
	const height = atlas.canvas.height;
	const canvas = createCanvas2D(width, height);
	if (!canvas) return null;
	const ctx = get2DContext(canvas);
	if (!ctx) return null;
	ctx.drawImage(atlas.canvas as CanvasImageSource, 0, 0);
	ctx.globalCompositeOperation = 'source-in';
	ctx.fillStyle = typeof color === 'number' ? rgbToCss(color) : color;
	ctx.fillRect(0, 0, width, height);
	ctx.globalCompositeOperation = 'source-over';
	return canvas;
}

/** Format a 0xRRGGBB value as a CSS colour. */
export function rgbToCss(rgb: number): string {
	const value = rgb >>> 0;
	return `#${((value >> 16) & 0xff).toString(16).padStart(2, '0')}${((value >> 8) & 0xff)
		.toString(16)
		.padStart(2, '0')}${(value & 0xff).toString(16).padStart(2, '0')}`;
}

export interface DrawGlyphOptions {
	scale?: number;
	cellWidth?: number;
	cellHeight?: number;
}

/** Fallback glyph painter for when no atlas can be built. */
export function drawGlyphDirect(
	ctx: Context2D,
	font: BitmapFont,
	code: number,
	x: number,
	y: number,
	color: number | string,
	options: DrawGlyphOptions = {},
): void {
	const scale = Math.max(1, Math.floor(options.scale ?? 1));
	const cellWidth = Math.max(font.width, Math.floor(options.cellWidth ?? font.width));
	ctx.fillStyle = typeof color === 'number' ? rgbToCss(color) : color;
	for (let py = 0; py < font.height; py++) {
		for (let px = 0; px < cellWidth; px++) {
			if (!font.getCellPixel(code, px, py, cellWidth)) continue;
			ctx.fillRect(x + px * scale, y + py * scale, scale, scale);
		}
	}
}

// ---------------------------------------------------------------------------
// CP437 code point mapping
// ---------------------------------------------------------------------------

/**
 * Non-identity CP437 byte -> Unicode code point pairs.
 *
 * The screen buffer stores Unicode code points (see `@websyncterm/core`), while
 * the fonts are indexed by code page byte. This table inverts the CP437
 * mapping so the renderer can find the right glyph.
 */
const CP437_PAIRS: readonly (readonly [number, number])[] = [
	[0x263a, 0x1], [0x263b, 0x2], [0x2665, 0x3], [0x2666, 0x4], [0x2663, 0x5], [0x2660, 0x6], [0x2022, 0x7], [0x25d8, 0x8],
	[0x25cb, 0x9], [0x25d9, 0xa], [0x2642, 0xb], [0x2640, 0xc], [0x266a, 0xd], [0x266b, 0xe], [0x263c, 0xf], [0x25ba, 0x10],
	[0x25c4, 0x11], [0x2195, 0x12], [0x203c, 0x13], [0xb6, 0x14], [0xa7, 0x15], [0x25ac, 0x16], [0x21a8, 0x17], [0x2191, 0x18],
	[0x2193, 0x19], [0x2192, 0x1a], [0x2190, 0x1b], [0x221f, 0x1c], [0x2194, 0x1d], [0x25b2, 0x1e], [0x25bc, 0x1f], [0x2302, 0x7f],
	[0xc7, 0x80], [0xfc, 0x81], [0xe9, 0x82], [0xe2, 0x83], [0xe4, 0x84], [0xe0, 0x85], [0xe5, 0x86], [0xe7, 0x87],
	[0xea, 0x88], [0xeb, 0x89], [0xe8, 0x8a], [0xef, 0x8b], [0xee, 0x8c], [0xec, 0x8d], [0xc4, 0x8e], [0xc5, 0x8f],
	[0xc9, 0x90], [0xe6, 0x91], [0xc6, 0x92], [0xf4, 0x93], [0xf6, 0x94], [0xf2, 0x95], [0xfb, 0x96], [0xf9, 0x97],
	[0xff, 0x98], [0xd6, 0x99], [0xdc, 0x9a], [0xa2, 0x9b], [0xa3, 0x9c], [0xa5, 0x9d], [0x20a7, 0x9e], [0x192, 0x9f],
	[0xe1, 0xa0], [0xed, 0xa1], [0xf3, 0xa2], [0xfa, 0xa3], [0xf1, 0xa4], [0xd1, 0xa5], [0xaa, 0xa6], [0xba, 0xa7],
	[0xbf, 0xa8], [0x2310, 0xa9], [0xac, 0xaa], [0xbd, 0xab], [0xbc, 0xac], [0xa1, 0xad], [0xab, 0xae], [0xbb, 0xaf],
	[0x2591, 0xb0], [0x2592, 0xb1], [0x2593, 0xb2], [0x2502, 0xb3], [0x2524, 0xb4], [0x2561, 0xb5], [0x2562, 0xb6], [0x2556, 0xb7],
	[0x2555, 0xb8], [0x2563, 0xb9], [0x2551, 0xba], [0x255d, 0xbb], [0x255c, 0xbc], [0x255b, 0xbd], [0x2510, 0xbe], [0x2514, 0xbf],
	[0x2534, 0xc0], [0x252c, 0xc1], [0x251c, 0xc2], [0x2500, 0xc3], [0x253c, 0xc4], [0x255e, 0xc5], [0x255f, 0xc6], [0x255a, 0xc7],
	[0x2554, 0xc8], [0x2569, 0xc9], [0x2566, 0xca], [0x2560, 0xcb], [0x2550, 0xcc], [0x256c, 0xcd], [0x2567, 0xce], [0x2568, 0xcf],
	[0x2564, 0xd0], [0x2565, 0xd1], [0x2559, 0xd2], [0x2558, 0xd3], [0x2552, 0xd4], [0x2553, 0xd5], [0x256b, 0xd6], [0x256a, 0xd7],
	[0x2518, 0xd8], [0x250c, 0xd9], [0x2588, 0xda], [0x2584, 0xdb], [0x258c, 0xdc], [0x2590, 0xdd], [0x2580, 0xde], [0x3b1, 0xdf],
	[0xdf, 0xe0], [0x393, 0xe1], [0x3c0, 0xe2], [0x3a3, 0xe3], [0x3c3, 0xe4], [0xb5, 0xe5], [0x3c4, 0xe6], [0x3a6, 0xe7],
	[0x398, 0xe8], [0x3a9, 0xe9], [0x3b4, 0xea], [0x221e, 0xeb], [0x3c6, 0xec], [0x3b5, 0xed], [0x2229, 0xee], [0x2261, 0xef],
	[0xb1, 0xf0], [0x2265, 0xf1], [0x2264, 0xf2], [0x2320, 0xf3], [0x2321, 0xf4], [0xf7, 0xf5], [0x2248, 0xf6], [0xb0, 0xf7],
	[0x2219, 0xf8], [0xb7, 0xf9], [0x221a, 0xfa], [0x207f, 0xfb], [0xb2, 0xfc], [0x25a0, 0xfd], [0xa0, 0xfe], [0xa0, 0xff],
];

const CP437_REVERSE: ReadonlyMap<number, number> = (() => {
	const map = new Map<number, number>();
	for (let i = 0; i < 256; i++) map.set(i, i);
	for (const [code, byte] of CP437_PAIRS) map.set(code, byte);
	return map;
})();

/** Map a screen buffer code point to a CP437 glyph index. */
export function unicodeToGlyphIndex(code: number): number {
	return CP437_REVERSE.get(code) ?? (code < 256 ? code : 0x3f);
}
