import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
	BitmapFont,
	FONT_VARIANTS,
	USER_FONT_MANIFEST,
	findUserFont,
	getBuiltinFont,
	inferFontVariant,
	inferHeightFromFilename,
	loadBuiltinFonts,
	loadFontFromBytes,
	setBuiltinFonts,
	unicodeToGlyphIndex,
} from '../src/font.js';

const FONT_JSON = readFileSync(new URL('../assets/fonts/builtin-fonts.json', import.meta.url), 'utf8');

function fontWith(glyphBytes: (code: number, row: number) => number): BitmapFont {
	const data = new Uint8Array(4096);
	for (let code = 0; code < 256; code++) {
		for (let row = 0; row < 16; row++) {
			data[code * 16 + row] = glyphBytes(code, row) & 0xff;
		}
	}
	return new BitmapFont(8, 16, data);
}

describe('font size inference', () => {
	test('recognises every upstream face from its byte length', () => {
		const expected: Record<number, [number, number]> = {
			1536: [8, 6],
			1792: [8, 7],
			2048: [8, 8],
			2560: [8, 10],
			3072: [8, 12],
			3328: [8, 13],
			3584: [8, 14],
			4096: [8, 16],
			10240: [12, 20],
		};
		expect(Object.keys(FONT_VARIANTS).map(Number).sort((a, b) => a - b)).toEqual(
			Object.keys(expected)
				.map(Number)
				.sort((a, b) => a - b),
		);
		for (const [size, [width, height]] of Object.entries(expected)) {
			const font = loadFontFromBytes(new Uint8Array(Number(size)));
			expect(font, `size ${size}`).not.toBeNull();
			expect(font?.width).toBe(width);
			expect(font?.height).toBe(height);
			expect(inferFontVariant(Number(size))).toEqual({ width, height });
		}
	});

	test('rejects unknown lengths', () => {
		expect(loadFontFromBytes(new Uint8Array(1234))).toBeNull();
		expect(inferFontVariant(4097)).toBeNull();
	});

	test('handles the 12x20 packing (two bytes per row, high 12 bits)', () => {
		const data = new Uint8Array(10240);
		data[0] = 0xf0; // glyph 0, row 0: pixels 0..3
		data[1] = 0xf0; // glyph 0, row 0: pixels 8..11
		const font = loadFontFromBytes(data)!;
		expect(font.width).toBe(12);
		expect(font.height).toBe(20);
		expect(font.bytesPerRow).toBe(2);
		for (let x = 0; x < 12; x++) {
			const expected = x < 4 || x >= 8;
			expect(font.getPixel(0, x, 0), `x=${x}`).toBe(expected);
		}
		// The low nibble of the second byte is padding and must not be read.
		expect(font.getPixel(0, 11, 0)).toBe(true);
	});

	test('glyphOffset uses the inferred face', () => {
		const font = loadFontFromBytes(new Uint8Array(3584))!;
		expect(font.glyphOffset(0)).toBe(0);
		expect(font.glyphOffset(1)).toBe(14);
		expect(font.glyphOffset(255)).toBe(255 * 14);
	});
});

describe('9 pixel VGA cells', () => {
	test('duplicates the eighth column for 0xC0..0xDF only', () => {
		const font = fontWith((code, row) => {
			if (code === 0xc0) return row === 0 ? 0x01 : row === 1 ? 0x80 : 0;
			if (code === 0xdf) return row === 0 ? 0x01 : 0;
			if (code === 0x41) return row === 0 ? 0x01 : 0;
			return 0;
		});

		// 0xC0: bit 0 (the eighth pixel) is set on row 0 -> ninth pixel set.
		expect(font.getPixel(0xc0, 7, 0)).toBe(true);
		expect(font.getCellPixel(0xc0, 8, 0, 9)).toBe(true);
		// Row 1 only has the first pixel set, so the ninth is blank.
		expect(font.getPixel(0xc0, 7, 1)).toBe(false);
		expect(font.getCellPixel(0xc0, 8, 1, 9)).toBe(false);
		// The upper end of the range behaves the same.
		expect(font.getCellPixel(0xdf, 8, 0, 9)).toBe(true);
		// Every other character leaves the ninth column blank.
		expect(font.getPixel(0x41, 7, 0)).toBe(true);
		expect(font.getCellPixel(0x41, 8, 0, 9)).toBe(false);
		expect(font.getCellPixel(0xe0, 8, 0, 9)).toBe(false);
		// An 8 pixel cell never synthesises a column.
		expect(font.getCellPixel(0xc0, 8, 0, 8)).toBe(false);
	});
});

describe('built-in codepage fonts', () => {
	test('decodes the CP437 smiley (glyph 1) from the JSON asset', () => {
		const fonts = loadBuiltinFonts(FONT_JSON);
		setBuiltinFonts(fonts);
		const font = fonts.getFont(0, 16);
		expect(font).not.toBeNull();
		expect(font?.width).toBe(8);
		expect(font?.height).toBe(16);

		const glyph0 = Array.from(font!.glyphs.subarray(font!.glyphOffset(0), font!.glyphOffset(0) + 16));
		expect(glyph0).toEqual(new Array(16).fill(0));

		const smiley = Array.from(font!.glyphs.subarray(font!.glyphOffset(1), font!.glyphOffset(1) + 16));
		expect(smiley).toEqual([0x00, 0x00, 0x7e, 0x81, 0xa5, 0x81, 0x81, 0xbd, 0x99, 0x81, 0x81, 0x7e, 0x00, 0x00, 0x00, 0x00]);
		expect(getBuiltinFont(0, 16)?.glyphs.length).toBe(4096);
	});

	test('falls back to slot 0 for an unknown slot or missing face', () => {
		const data = JSON.parse(FONT_JSON) as {
			fonts: Record<string, Record<string, string>>;
		};
		const firstName = Object.keys(data.fonts)[0];
		delete data.fonts[firstName]['8x14'];
		const fonts = loadBuiltinFonts(data);

		// Missing 8x14 on slot 0 falls back to slot 0's own 8x14 - which is gone,
		// so there is nothing left to fall back to.
		expect(fonts.getFont(0, 14)).toBeNull();

		// Unknown slot falls back to slot 0 for an available face.
		const fallback = fonts.getFont(999, 16);
		const slot0 = fonts.getFont(0, 16);
		expect(fallback).not.toBeNull();
		expect(fallback?.width).toBe(slot0?.width);
		expect(fallback?.height).toBe(slot0?.height);
		expect(fallback).toBe(slot0);
	});

	test('missing face on another slot uses slot 0', () => {
		const data = JSON.parse(FONT_JSON) as {
			fonts: Record<string, Record<string, string>>;
		};
		const names = Object.keys(data.fonts);
		delete data.fonts[names[3]]['8x8'];
		const fonts = loadBuiltinFonts(data);
		const font = fonts.getFont(3, 8);
		expect(font).not.toBeNull();
		expect(font).toBe(fonts.getFont(0, 8));
	});

	test('maps CP437 code points back to glyph indices', () => {
		expect(unicodeToGlyphIndex(0x263a)).toBe(1);
		expect(unicodeToGlyphIndex(0x2500)).toBe(0xc3);
		expect(unicodeToGlyphIndex(0x41)).toBe(0x41);
		expect(unicodeToGlyphIndex(0x1f600)).toBe(0x3f);
	});
});

describe('user font manifest', () => {
	test('lists all copied .fNN files with a height', () => {
		expect(USER_FONT_MANIFEST).toHaveLength(74);
		expect(USER_FONT_MANIFEST.every((entry) => /\.f\d+$/.test(entry.file))).toBe(true);
		expect(USER_FONT_MANIFEST.every((entry) => entry.height === inferHeightFromFilename(entry.file))).toBe(true);
		expect(findUserFont('standard.f16')).toEqual({ name: 'standard', file: 'standard.f16', height: 16 });
		expect(findUserFont('tiny')?.file).toBe('tiny.f6');
		expect(inferHeightFromFilename('foo.txt')).toBeNull();
	});
});
