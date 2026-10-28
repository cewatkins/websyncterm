import { describe, expect, it } from 'vitest';
import { TransferHandshakeGuard } from '../src/transfer-guard.js';

describe('TransferHandshakeGuard', () => {
	it('passes ordinary text straight through', () => {
		const guard = new TransferHandshakeGuard();
		const out: number[] = [];
		for (const b of new TextEncoder().encode('Hello, world!')) {
			out.push(...guard.push(b).display);
		}
		expect(new TextDecoder().decode(Uint8Array.from(out))).toBe('Hello, world!');
	});

	it('holds back the bytes that could start a ZMODEM handshake', () => {
		const guard = new TransferHandshakeGuard();
		expect(guard.push(0x18).display).toEqual([]);
		expect(guard.push(0x42).display).toEqual([]);
		expect(guard.push(0x30).display).toEqual([]);
		const result = guard.push(0x30);
		expect(result.handshake).toBe('zmodem-download');
		expect(result.display.length).toBe(4);
	});

	it('recognises a ZMODEM upload request', () => {
		const guard = new TransferHandshakeGuard();
		guard.push(0x18);
		guard.push(0x42);
		guard.push(0x30);
		expect(guard.push(0x31).handshake).toBe('zmodem-upload');
	});

	it('recognises two identical XMODEM request bytes', () => {
		for (const [byte, expected] of [
			[0x43, 'xmodem-crc'],
			[0x47, 'ymodem-g'],
			[0x15, 'xmodem-chksum'],
		] as const) {
			const guard = new TransferHandshakeGuard();
			expect(guard.push(byte).handshake).toBeNull();
			expect(guard.push(byte).handshake).toBe(expected);
		}
	});

	it('releases the withheld bytes when the handshake does not materialise', () => {
		const guard = new TransferHandshakeGuard();
		guard.push(0x18);
		guard.push(0x42);
		// Not a ZMODEM prefix after all.
		const result = guard.push(0x41);
		expect(result.handshake).toBeNull();
		expect(new TextDecoder().decode(Uint8Array.from(result.display))).toBe('\x18BA');
	});

	it('does not lose a byte when a candidate is followed by another candidate', () => {
		const guard = new TransferHandshakeGuard();
		guard.push(0x18);
		const result = guard.push(0x18);
		expect(new TextDecoder().decode(Uint8Array.from(result.display))).toBe('\x18');
		expect(guard.pending.length).toBe(1);
	});

	it('handles a chunk boundary inside the handshake', () => {
		const guard = new TransferHandshakeGuard();
		expect(guard.push(0x18).display).toEqual([]);
		expect(guard.push(0x42).display).toEqual([]);
		expect(guard.push(0x30).display).toEqual([]);
		expect(guard.push(0x30).handshake).toBe('zmodem-download');
	});

	it('does not mistake a single C for a handshake', () => {
		const guard = new TransferHandshakeGuard();
		const result = guard.push(0x43);
		expect(result.handshake).toBeNull();
		expect(result.display).toEqual([]);
		// The next byte is not a C, so the held byte is released.
		const next = guard.push(0x41);
		expect(new TextDecoder().decode(Uint8Array.from(next.display))).toBe('CA');
	});
});
