import { describe, expect, it } from 'vitest';

import {
	RipInterpreter,
	bezierPolyline,
	bezierSampleCount,
	parseMegaNum,
	RIP_VERSION_STRING,
} from '../src/index.js';

/** Encode a number as a fixed-width uppercase base-36 MegaNum field. */
function mn(value: number, width: number): string {
	return value.toString(36).toUpperCase().padStart(width, '0');
}

function bytes(s: string): Uint8Array {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++)
		out[i] = s.charCodeAt(i) & 0xff;
	return out;
}

function feedText(interp: RipInterpreter, s: string): void {
	interp.feed(bytes(s));
}

function enable(interp: RipInterpreter): void {
	feedText(interp, '\x1b[!');
	interp.takeReplies();
	interp.takeText();
}

function cmd(interp: RipInterpreter, body: string): void {
	feedText(interp, `!|${body}\r`);
	interp.takeText();
}

function nonBlackPixels(interp: RipInterpreter): number {
	const { data } = interp.pixelBuffer;
	let n = 0;
	for (let i = 0; i < data.length; i++) {
		if ((data[i]! & 0x00ffffff) !== 0)
			n++;
	}
	return n;
}

describe('parseMegaNum', () => {
	it('parses uppercase base-36 fields of several widths', () => {
		expect(parseMegaNum('0', 1)).toBe(0);
		expect(parseMegaNum('Z', 1)).toBe(35);
		expect(parseMegaNum('10', 2)).toBe(36);
		expect(parseMegaNum('ZZ', 2)).toBe(35 * 36 + 35);
		expect(parseMegaNum('100', 3)).toBe(36 * 36);
		expect(parseMegaNum('0000', 4)).toBe(0);
	});

	it('accepts lowercase digits', () => {
		expect(parseMegaNum('zz', 2)).toBe(parseMegaNum('ZZ', 2));
		expect(parseMegaNum('a', 1)).toBe(10);
	});

	it('treats "-" as digit zero', () => {
		expect(parseMegaNum('-1', 2)).toBe(1);
		expect(parseMegaNum('1-', 2)).toBe(36);
		expect(parseMegaNum('--', 2)).toBe(0);
	});

	it('stops early on | or NUL after the first digit', () => {
		expect(parseMegaNum('1|', 4)).toBe(1);
		expect(parseMegaNum('1\0', 4)).toBe(1);
	});

	it('rejects invalid characters and empty fields', () => {
		expect(parseMegaNum('', 1)).toBe(-1);
		expect(parseMegaNum('!', 1)).toBe(-1);
		expect(parseMegaNum(' 1', 2)).toBe(-1);
		expect(parseMegaNum('|1', 2)).toBe(-1);
	});
});

describe('RIP framing', () => {
	it('recognises !| at the start of a line', () => {
		const rip = new RipInterpreter();
		enable(rip);
		cmd(rip, `C${mn(100, 2)}${mn(100, 2)}${mn(20, 2)}`);
		expect(nonBlackPixels(rip)).toBeGreaterThan(0);
	});

	it('does not recognise !| in the middle of a line', () => {
		const rip = new RipInterpreter();
		enable(rip);
		feedText(rip, `hello!|C${mn(100, 2)}${mn(100, 2)}${mn(20, 2)}|`);
		expect(nonBlackPixels(rip)).toBe(0);
		expect(rip.takeText()).toContain('hello!|C');
	});

	it('accepts SOH| and STX| anywhere except after a backslash', () => {
		const rip = new RipInterpreter();
		enable(rip);
		feedText(rip, `\x02|c0F\r`);
		expect(rip.graphicsState.color).toBe(0x0f);
	});

	it('uses | as a command boundary and opens the next command', () => {
		const rip = new RipInterpreter();
		enable(rip);
		feedText(rip, `!|c0F|X${mn(10, 2)}${mn(11, 2)}\r`);
		expect(rip.graphicsState.color).toBe(0x0f);
		const px = rip.pixelBuffer.data[11 * rip.pixelWidth + 10]!;
		expect(px & 0x00ffffff).not.toBe(0);
	});

	it('swallows LF in the middle of a command', () => {
		const rip = new RipInterpreter();
		enable(rip);
		feedText(rip, '!|c0\nF\r');
		expect(rip.graphicsState.color).toBe(0x0f);
	});

	it('swallows one LF immediately after a dispatched command', () => {
		const rip = new RipInterpreter();
		enable(rip);
		feedText(rip, '!|c0F\r\nX');
		expect(rip.takeText()).toBe('X');
	});

	it('supports backslash line continuation', () => {
		const rip = new RipInterpreter();
		enable(rip);
		feedText(rip, `!|X0A\\\r0B|`);
		const px = rip.pixelBuffer.data[11 * rip.pixelWidth + 10]!;
		expect(px & 0x00ffffff).not.toBe(0);
	});

	it('treats an escaped pipe as data, not a boundary', () => {
		const rip = new RipInterpreter();
		enable(rip);
		// Text argument contains a literal pipe via \|.
		feedText(rip, '!|@0000A\\|B\r');
		expect(nonBlackPixels(rip)).toBeGreaterThan(0);
	});
});

describe('version query', () => {
	it('replies with exactly the 14 version bytes', () => {
		const rip = new RipInterpreter();
		let called = 0;
		const withCallback = new RipInterpreter({ onVersion: () => { called++; } });
		feedText(withCallback, '\x1b[!');
		const replies = withCallback.takeReplies();
		expect(called).toBe(1);
		expect(replies).toHaveLength(1);
		expect(replies[0]).toHaveLength(14);
		expect(Array.from(replies[0]!)).toEqual(Array.from(bytes('RIPSCRIP015410')));
		expect(RIP_VERSION_STRING).toBe('RIPSCRIP015410');

		feedText(rip, '\x1b[0!');
		expect(rip.takeReplies()[0]).toHaveLength(14);
	});

	it('disables RIP on ESC[1!', () => {
		const rip = new RipInterpreter();
		enable(rip);
		feedText(rip, '\x1b[1!');
		expect(rip.enabled).toBe(false);
		feedText(rip, '!|c0F\r');
		expect(rip.graphicsState.color).toBe(1);
		expect(rip.takeText()).toContain('!|c0F');
	});
});

describe('graphics commands', () => {
	it('draws a circle into the pixel buffer', () => {
		const rip = new RipInterpreter();
		enable(rip);
		cmd(rip, `C${mn(100, 2)}${mn(100, 2)}${mn(20, 2)}`);
		expect(nonBlackPixels(rip)).toBeGreaterThan(20);
	});

	it('|Q sets all 16 palette entries and |* restores the default', () => {
		const rip = new RipInterpreter();
		enable(rip);
		cmd(rip, `Q${mn(63, 2).repeat(16)}`);
		expect(rip.palette).toEqual(new Array(16).fill(63));
		cmd(rip, '*');
		expect(rip.palette).toEqual([
			0, 1, 2, 3, 4, 5, 20, 7, 56, 57, 58, 59, 60, 61, 62, 63,
		]);
	});

	it('|a remaps one palette entry', () => {
		const rip = new RipInterpreter();
		enable(rip);
		cmd(rip, 'a0F3F');
		expect(rip.palette[15]).toBe(63);
		expect(rip.palette[0]).toBe(0);
	});

	it('uses 0xCCCC for built-in line style 1', () => {
		const rip = new RipInterpreter();
		enable(rip);
		cmd(rip, '$01000001');
		expect(rip.graphicsState.lineStyle).toBe(1);
		expect(rip.graphicsState.linePattern).toBe(0xcccc);
		expect(rip.graphicsState.lineWidth).toBe(1);
	});

	it('keeps the colour, line style and clipboard across |*', () => {
		const rip = new RipInterpreter();
		enable(rip);
		cmd(rip, 'c0E');
		cmd(rip, '$01000001');
		cmd(rip, '*');
		expect(rip.graphicsState.color).toBe(0x0e);
		expect(rip.graphicsState.linePattern).toBe(0xcccc);
		expect(rip.graphicsState.lineStyle).toBe(1);
		expect(rip.palette).toEqual([
			0, 1, 2, 3, 4, 5, 20, 7, 56, 57, 58, 59, 60, 61, 62, 63,
		]);
	});

	it('applies the 0.775 EGA Y-radius quirk to circles', () => {
		// A radius-20 circle on 640x350 is 40 wide and ~31 tall.
		const rip = new RipInterpreter();
		enable(rip);
		cmd(rip, `C${mn(150, 2)}${mn(100, 2)}${mn(20, 2)}`);
		const { data, width } = rip.pixelBuffer;
		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
		for (let y = 0; y < rip.pixelHeight; y++) {
			for (let x = 0; x < width; x++) {
				if ((data[y * width + x]! & 0x00ffffff) === 0)
					continue;
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
				minY = Math.min(minY, y);
				maxY = Math.max(maxY, y);
			}
		}
		expect(maxX - minX).toBeGreaterThanOrEqual(38);
		expect(maxX - minX).toBeLessThanOrEqual(40);
		expect(maxY - minY).toBeGreaterThanOrEqual(28);
		expect(maxY - minY).toBeLessThanOrEqual(31);
	});
});

describe('Bezier point-count quirk', () => {
	it('uses 1020 samples when cnt <= 0', () => {
		expect(bezierSampleCount(0)).toBe(0x3fc);
		expect(bezierSampleCount(-1)).toBe(0x3fc);
		expect(bezierSampleCount(10)).toBe(10);
		const poly = bezierPolyline(0, 0, 10, 10, 20, 0, 30, 10, 0);
		expect(poly.length).toBeGreaterThan(1000);
	});

	it('uses the requested count when positive', () => {
		const poly = bezierPolyline(0, 0, 10, 10, 20, 0, 30, 10, 4);
		expect(poly.length).toBeLessThan(20);
		expect(poly[0]).toEqual({ x: 0, y: 0 });
		expect(poly[poly.length - 1]).toEqual({ x: 30, y: 10 });
	});

	it('honours cnt 00 in !|Z', () => {
		const rip = new RipInterpreter();
		enable(rip);
		const fields = [0, 0, 10, 10, 20, 0, 30, 10, 0]
			.map(n => mn(n, 2)).join('');
		cmd(rip, `Z${fields}`);
		expect(nonBlackPixels(rip)).toBeGreaterThan(30);
	});
});

describe('end-of-scene and clipboard', () => {
	it('marks the scene complete on the !|# marker', () => {
		const rip = new RipInterpreter();
		enable(rip);
		feedText(rip, '!|#|#|#\r');
		expect(rip.sceneIsComplete).toBe(true);
	});

	it('captures a region with !|1C and pastes it with !|1P', () => {
		const rip = new RipInterpreter();
		enable(rip);
		cmd(rip, `K${mn(0, 2)}${mn(0, 2)}${mn(20, 2)}${mn(20, 2)}`);
		cmd(rip, `1C${mn(0, 2)}${mn(0, 2)}${mn(20, 2)}${mn(20, 2)}0`);
		cmd(rip, 'E');
		const before = rip.pixelBuffer.data[30 * rip.pixelWidth + 30]!;
		expect(before & 0x00ffffff).toBe(0);
		cmd(rip, `1P${mn(30, 2)}${mn(30, 2)}000`);
		const after = rip.pixelBuffer.data[30 * rip.pixelWidth + 30]!;
		expect(after & 0x00ffffff).not.toBe(0);
	});
});
