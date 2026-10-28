import { describe, expect, it } from 'vitest';
import { CTerm } from '../src/cterm.js';

/**
 * A deterministic PRNG so a failure is always reproducible from the seed.
 */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Byte sequences that commonly appear in real ANSI output. */
const INTERESTING = [
	0x1b, 0x5b, 0x5d, 0x50, 0x5f, 0x58, 0x5e, 0x5c, 0x07, 0x00, 0x0e, 0x0f,
	0x18, 0x1a, 0x3f, 0x3c, 0x3d, 0x3e, 0x20, 0x3b, 0x3a, 0x40, 0x7e,
	0x30, 0x39, 0x41, 0x5a, 0x61, 0x7a, 0x24, 0x2a, 0x27, 0x22, 0x2d, 0x21,
	0x80, 0xff, 0xa0, 0x0a, 0x0d, 0x09, 0x08,
];

describe('ANSI parser fuzzing', () => {
	it('never throws on random byte input', () => {
		for (let seed = 1; seed <= 200; seed++) {
			const rand = mulberry32(seed);
			const term = new CTerm({ cols: 80, rows: 25, onResponse: () => {} });
			const length = 50 + Math.floor(rand() * 500);
			for (let i = 0; i < length; i++) {
				const useInteresting = rand() < 0.6;
				const byte = useInteresting
					? INTERESTING[Math.floor(rand() * INTERESTING.length)]
					: Math.floor(rand() * 256);
				term.write(Uint8Array.of(byte));
			}
			// The cursor must always remain inside the screen.
			expect(term.xpos).toBeGreaterThanOrEqual(0);
			expect(term.xpos).toBeLessThanOrEqual(term.cols);
			expect(term.ypos).toBeGreaterThanOrEqual(0);
			expect(term.ypos).toBeLessThanOrEqual(term.rows);
		}
	});

	it('survives being split at every possible boundary', () => {
		const payload = new TextEncoder().encode(
			'\x1b[1;32mGreen\x1b[0m \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\' +
				'\x1b[2J\x1b[H\x1b[10;20Hxy\x1b[38;2;255;0;0mZ\x1bP1;1q#0;2;100;0;0#0~~~\x1b\\',
		);
		for (let split = 0; split <= payload.length; split++) {
			const term = new CTerm({ cols: 80, rows: 25, onResponse: () => {} });
			term.write(payload.subarray(0, split));
			term.write(payload.subarray(split));
			expect(term.xpos).toBeLessThanOrEqual(term.cols);
			expect(term.ypos).toBeLessThanOrEqual(term.rows);
		}
	});

	it('ignores an over-long CSI parameter list', () => {
		const term = new CTerm({ cols: 80, rows: 25, onResponse: () => {} });
		const params = Array.from({ length: 200 }, () => '1').join(';');
		term.writeString(`\x1b[${params}m`);
		// The engine must still be usable afterwards.
		term.writeString('ok');
		expect(term.screen.charAt(0, 0)).toBe('o'.charCodeAt(0));
	});

	it('does not leak state between a string terminator and the next sequence', () => {
		const responses: string[] = [];
		const term = new CTerm({
			cols: 80,
			rows: 25,
			onResponse: (d) => responses.push(new TextDecoder().decode(d)),
		});
		term.writeString('\x1b]4;1;rgb:00/ff/00\x1b\\');
		term.writeString('\x1b[c');
		expect(responses.join('')).toContain('67;84;101;114;109');
	});
});
