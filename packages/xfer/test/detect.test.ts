import { describe, expect, it } from 'vitest';
import { TransferDetector, detectTransfer, detectXModem } from '../src/detect.js';

describe('ZMODEM transfer detection', () => {
	it('recognises a remote-initiated download (ZRQINIT prefix)', () => {
		expect(detectTransfer(Uint8Array.of(0x18, 0x42, 0x30, 0x30))).toBe('zmodem-download');
	});

	it('recognises a remote-initiated upload (ZRINIT prefix)', () => {
		expect(detectTransfer(Uint8Array.of(0x18, 0x42, 0x30, 0x31))).toBe('zmodem-upload');
	});

	it('matches only the 4-byte prefix', () => {
		expect(detectTransfer(Uint8Array.of(0x18, 0x42, 0x30, 0x30, 0xff, 0xfe))).toBe('zmodem-download');
	});

	it('requires exactly the prefix bytes', () => {
		expect(detectTransfer(Uint8Array.of(0x18, 0x42, 0x30, 0x32))).toBeNull();
		expect(detectTransfer(Uint8Array.of(0x2a, 0x2a, 0x18, 0x42))).toBeNull();
		expect(detectTransfer(Uint8Array.of(0x18, 0x42, 0x30))).toBeNull();
		expect(detectTransfer(new Uint8Array(0))).toBeNull();
	});

	it('streams byte by byte and keeps the prefix buffered', () => {
		const d = new TransferDetector();
		expect(d.push(0x18)).toBeNull();
		expect(d.push(0x42)).toBeNull();
		expect(d.push(0x30)).toBeNull();
		expect(d.result).toBeNull();
		expect(d.push(0x31)).toBe('zmodem-upload');
		expect(d.result).toBe('zmodem-upload');
		expect([...d.bytes]).toEqual([0x18, 0x42, 0x30, 0x31]);
	});

	it('recovers from a mismatched byte', () => {
		const d = new TransferDetector();
		d.pushBytes(Uint8Array.of(0x18, 0x42, 0x99));
		expect(d.pushBytes(Uint8Array.of(0x18, 0x42, 0x30, 0x30))).toBe('zmodem-download');
	});

	it('resets cleanly', () => {
		const d = new TransferDetector();
		d.pushBytes(Uint8Array.of(0x18, 0x42, 0x30, 0x30));
		d.reset();
		expect(d.result).toBeNull();
		expect(d.bytes.length).toBe(0);
	});
});

describe('X/YMODEM transfer detection', () => {
	it('recognises two identical C bytes as XMODEM-CRC', () => {
		expect(detectXModem(Uint8Array.of(0x43, 0x43))).toBe('xmodem-crc');
	});

	it('recognises two identical NAK bytes as XMODEM checksum', () => {
		expect(detectXModem(Uint8Array.of(0x15, 0x15))).toBe('xmodem-chksum');
	});

	it('recognises two identical G bytes as YMODEM-G', () => {
		expect(detectXModem(Uint8Array.of(0x47, 0x47))).toBe('ymodem-g');
	});

	it('ignores non-consecutive or unrelated bytes', () => {
		expect(detectXModem(Uint8Array.of(0x43, 0x41, 0x43))).toBeNull();
		expect(detectXModem(Uint8Array.of(0x15, 0x43))).toBeNull();
		expect(detectXModem(Uint8Array.of(0x43))).toBeNull();
	});

	it('detects through the streaming detector', () => {
		const d = new TransferDetector();
		expect(d.push(0x15)).toBeNull();
		expect(d.push(0x15)).toBe('xmodem-chksum');
		expect([...d.bytes]).toEqual([0x15, 0x15]);
	});
});
