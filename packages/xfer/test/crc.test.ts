import { describe, expect, it } from 'vitest';
import { crc16, crc16Update, crc32, crc32Update } from '../src/crc.js';

function bytes(text: string): Uint8Array {
	return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

describe('CRC helpers', () => {
	it('computes CRC-16/XMODEM for the standard check value', () => {
		expect(crc16(bytes('123456789'))).toBe(0x31c3);
	});

	it('matches the empty-string init value', () => {
		expect(crc16(new Uint8Array(0))).toBe(0);
	});

	it('updates incrementally the same as in one call', () => {
		let crc = 0;
		for (const b of bytes('The quick brown fox')) crc = crc16Update(crc, b);
		expect(crc).toBe(crc16(bytes('The quick brown fox')));
	});

	it('computes reflected CRC-32 for the standard check value', () => {
		expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
	});

	it('exposes the raw running CRC-32 state', () => {
		let crc = 0xffffffff;
		for (const b of bytes('123456789')) crc = crc32Update(crc, b);
		expect(~crc >>> 0).toBe(0xcbf43926);
	});
});
