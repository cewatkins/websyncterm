import { describe, expect, it } from 'vitest';
import {
	ZCRCE,
	ZCRCW,
	ZDLE,
	ZFrame,
	ZFrameParser,
	ZPAD,
	decodeEscaped,
	decodeHexHeader,
	encodeBin16Header,
	encodeBin32Header,
	encodeBinaryHeader,
	encodeDataSubpacket,
	encodeHexHeader,
	escapeBytes,
	headerFromBytes,
	headerToBytes,
	makeHeader,
	parseZModemFileInfo,
	zmodemFileInfoPayload,
} from '../src/zmodem.js';
import { concatBytes } from '../src/bytes.js';

function hex(data: Uint8Array): string {
	return [...data].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function latin1(data: Uint8Array): string {
	return [...data].map((b) => String.fromCharCode(b)).join('');
}

describe('ZMODEM header encoding', () => {
	it('encodes ZRQINIT exactly', () => {
		const frame = encodeHexHeader(makeHeader(ZFrame.ZRQINIT, 0, 0));
		expect([...frame]).toEqual([
			ZPAD,
			ZPAD,
			ZDLE,
			0x42,
			...[...'00000000000000'].map((c) => c.charCodeAt(0)),
			0x0d,
			0x0a,
			0x11,
		]);
		expect(latin1(frame)).toBe('**\x18B00000000000000\r\n\x11');
	});

	it('encodes ZRINIT with CANFDX|CANOVIO|CANFC32 exactly', () => {
		const frame = encodeHexHeader(makeHeader(ZFrame.ZRINIT, 0, 0x23));
		expect(latin1(frame)).toBe('**\x18B0100000023be50\r\n\x11');
		const decoded = decodeHexHeader(frame);
		expect(decoded?.type).toBe(ZFrame.ZRINIT);
		expect(decoded?.f0).toBe(0x23);
	});

	it('encodes ZRINIT with ESCCTL exactly', () => {
		const frame = encodeHexHeader(makeHeader(ZFrame.ZRINIT, 0, 0x63));
		expect(latin1(frame)).toBe('**\x18B0100000063f694\r\n\x11');
	});

	it('omits the XON for ZACK and ZFIN only', () => {
		const zack = encodeHexHeader(makeHeader(ZFrame.ZACK, 0, 0));
		expect(zack[zack.length - 1]).toBe(0x0a);
		const zfin = encodeHexHeader(makeHeader(ZFrame.ZFIN, 0, 0));
		expect(zfin[zfin.length - 1]).toBe(0x0a);
		const zrpos = encodeHexHeader(makeHeader(ZFrame.ZRPOS, 100, 0));
		expect(zrpos[zrpos.length - 1]).toBe(0x11);
	});

	it('round-trips every frame type through the hex encoder', () => {
		for (const type of Object.values(ZFrame)) {
			const header = makeHeader(type, 0x11223344, type & 0xff);
			const decoded = decodeHexHeader(encodeHexHeader(header));
			expect(decoded).toEqual(headerFromBytes(header));
		}
	});

	it('round-trips a binary-16 header through the parser', () => {
		const header = makeHeader(ZFrame.ZDATA, 12345, 0);
		const parser = new ZFrameParser();
		parser.push(encodeBin16Header(header));
		const parsed = parser.readHeader();
		expect(parsed?.header.type).toBe(ZFrame.ZDATA);
		expect(parsed?.header.pos).toBe(12345);
		expect(parsed?.hex).toBe(false);
		expect(parsed?.fcs32).toBe(false);
	});

	it('round-trips a binary-32 header through the parser', () => {
		const header = makeHeader(ZFrame.ZFILE, 0, 1, 2);
		const parser = new ZFrameParser();
		parser.push(encodeBin32Header(header));
		const parsed = parser.readHeader();
		expect(parsed?.header).toEqual(headerFromBytes(header));
		expect(parsed?.fcs32).toBe(true);
	});

	it('stores the position little-endian in bytes 1-4', () => {
		const bytes = makeHeader(ZFrame.ZRPOS, 0x01020304);
		expect([...bytes]).toEqual([ZFrame.ZRPOS, 0x04, 0x03, 0x02, 0x01]);
		expect(headerToBytes(headerFromBytes(bytes))).toEqual(bytes);
	});

	it('rejects a corrupted hex header CRC', () => {
		const frame = encodeHexHeader(makeHeader(ZFrame.ZRINIT, 0, 0x63));
		const copy = frame.slice();
		// Flip a nibble of the header (not the CRC digits).
		copy[6] = copy[6] === 0x30 ? 0x31 : 0x30;
		expect(decodeHexHeader(copy)).toBeNull();
	});
});

describe('ZMODEM ZDLE escaping', () => {
	it('escapes 0x18 and 0xFF as ZDLE sequences', () => {
		const data = Uint8Array.of(0x18, 0xff, 0x10, 0x41);
		const escaped = escapeBytes(data, { escapeTelnetIac: true });
		expect([...escaped]).toEqual([ZDLE, 0x58, ZDLE, 0x6d, ZDLE, 0x50, 0x41]);
		expect([...decodeEscaped(escaped)]).toEqual([...data]);
	});

	it('escapes the always-escaped control bytes', () => {
		const data = Uint8Array.of(0x10, 0x11, 0x13, 0x18, 0x90, 0x91, 0x93, 0x98);
		const escaped = escapeBytes(data);
		for (let i = 0; i < escaped.length; i += 2) expect(escaped[i]).toBe(ZDLE);
		expect([...decodeEscaped(escaped)]).toEqual([...data]);
	});

	it('drops bare XON/XOFF on decode', () => {
		expect([...decodeEscaped(Uint8Array.of(0x41, 0x11, 0x42, 0x13, 0x43))]).toEqual([0x41, 0x42, 0x43]);
	});

	it('escapes every control character when ESCCTL is negotiated', () => {
		for (let b = 0; b < 0x20; b++) {
			const escaped = escapeBytes(Uint8Array.of(b), { escapeCtrl: true });
			expect(escaped[0]).toBe(ZDLE);
		}
	});

	it('round-trips a subpacket containing special bytes', () => {
		const data = new Uint8Array(64).map((_, i) => (i * 0x11) & 0xff);
		data[0] = 0x18;
		data[1] = 0xff;
		data[2] = 0x2a;
		for (const fcs32 of [false, true]) {
			const frame = encodeDataSubpacket(ZCRCW, data, fcs32, { escapeTelnetIac: true });
			const parser = new ZFrameParser();
			parser.push(frame);
			const parsed = parser.readSubpacket(fcs32);
			expect(parsed).not.toBeNull();
			if (parsed && !('corrupt' in parsed)) {
				expect(parsed.type).toBe(ZCRCW);
				expect(parsed.data).toEqual(data);
			}
		}
	});

	it('detects a corrupted subpacket CRC', () => {
		const frame = encodeDataSubpacket(ZCRCE, Uint8Array.of(1, 2, 3), false);
		frame[frame.length - 1] ^= 0xff;
		const parser = new ZFrameParser();
		parser.push(frame);
		expect(parser.readSubpacket(false)).toEqual({ corrupt: true });
	});

	it('parses a frame byte-by-byte', () => {
		const header = encodeBinaryHeader(makeHeader(ZFrame.ZDATA, 7, 0), true);
		const sub = encodeDataSubpacket(ZCRCE, Uint8Array.of(9, 8, 7), true);
		const frame = concatBytes([header, sub]);
		const parser = new ZFrameParser();
		let parsedHeader = null;
		let i = 0;
		for (; i < frame.length && !parsedHeader; i++) {
			parser.push(frame.subarray(i, i + 1));
			parsedHeader = parser.readHeader();
		}
		expect(parsedHeader?.header.pos).toBe(7);
		// The rest of the frame arrived after the header completed.
		for (; i < frame.length; i++) parser.push(frame.subarray(i, i + 1));
		const parsedSub = parser.readSubpacket(true);
		expect(parsedSub && !('corrupt' in parsedSub) ? [...parsedSub.data] : null).toEqual([9, 8, 7]);
	});
});

describe('ZMODEM ZFILE payload', () => {
	it('builds the SyncTERM header string', () => {
		const payload = zmodemFileInfoPayload('/tmp/test.bin', 1234, 0o1000000000, 2, 4321);
		expect(latin1(payload)).toBe('test.bin\0' + '1234 1000000000 0 0 2 4321 0');
		const info = parseZModemFileInfo(payload);
		expect(info.name).toBe('test.bin');
		expect(info.size).toBe(1234);
		expect(info.mtime).toBe(0o1000000000);
		expect(info.filesRemaining).toBe(2);
		expect(info.bytesRemaining).toBe(4321);
	});

	it('uses the ZPAD byte in a header prefix, not in data', () => {
		const frame = encodeHexHeader(makeHeader(ZFrame.ZACK, 3, 0));
		expect(frame[0]).toBe(ZPAD);
		expect(frame[1]).toBe(ZPAD);
	});
});
