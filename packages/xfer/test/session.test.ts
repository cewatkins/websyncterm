import { describe, expect, it } from 'vitest';
import { MemoryFileSink, MemoryFileSource } from '../src/files.js';
import { ManualTimers } from '../src/timers.js';
import {
	DOWNLOAD_PROTOCOLS,
	TransferSession,
	UPLOAD_PROTOCOLS,
	directionFor,
	isProtocolSupported,
} from '../src/session.js';
import { TRANSFER_PROTOCOLS } from '../src/types.js';
import { XModemReceiver, XModemSender } from '../src/xmodem.js';
import { ZModemReceiver, ZModemSender, ZFrame, decodeHexHeader } from '../src/zmodem.js';

describe('protocol list', () => {
	it('offers exactly the protocols SyncTERM supports', () => {
		expect([...TRANSFER_PROTOCOLS].sort()).toEqual(
			[
				'zmodem',
				'ymodem',
				'ymodem-g',
				'xmodem-crc',
				'xmodem-chksum',
				'xmodem-1k',
				'xmodem-128',
				'ascii',
				'raw',
			].sort(),
		);
		expect(TRANSFER_PROTOCOLS).not.toContain('zmodem-8k');
		expect(TRANSFER_PROTOCOLS).not.toContain('zmodem-32k');
	});

	it('offers XMODEM-128 as an upload only', () => {
		expect(UPLOAD_PROTOCOLS).toContain('xmodem-128');
		expect(DOWNLOAD_PROTOCOLS).not.toContain('xmodem-128');
		expect(isProtocolSupported('xmodem-128', 'send')).toBe(true);
		expect(isProtocolSupported('xmodem-128', 'receive')).toBe(false);
	});

	it('offers no CRC/checksum choice for uploads', () => {
		expect(UPLOAD_PROTOCOLS).not.toContain('xmodem-crc');
		expect(UPLOAD_PROTOCOLS).not.toContain('xmodem-chksum');
		expect(DOWNLOAD_PROTOCOLS).toContain('xmodem-crc');
		expect(DOWNLOAD_PROTOCOLS).toContain('xmodem-chksum');
	});

	it('maps detection results to a direction', () => {
		expect(directionFor('zmodem-download')).toBe('receive');
		expect(directionFor('zmodem-upload')).toBe('send');
		expect(directionFor('xmodem-crc')).toBe('send');
		expect(directionFor('xmodem-chksum')).toBe('send');
		expect(directionFor('ymodem-g')).toBe('send');
	});
});

describe('TransferSession', () => {
	it('creates a ZMODEM receiver immediately when the protocol is given', () => {
		const timers = new ManualTimers();
		const session = new TransferSession({ protocol: 'zmodem', sink: new MemoryFileSink(), timers });
		expect(session.engine).toBeInstanceOf(ZModemReceiver);
		expect(decodeHexHeader(session.poll())?.type).toBe(ZFrame.ZRINIT);
		session.dispose();
	});

	it('creates a ZMODEM sender for an upload', () => {
		const timers = new ManualTimers();
		const session = new TransferSession({
			protocol: 'zmodem',
			direction: 'send',
			timers,
			files: [{ name: 'a', size: 0, source: new MemoryFileSource(new Uint8Array(0)) }],
		});
		expect(session.engine).toBeInstanceOf(ZModemSender);
		session.dispose();
	});

	it('auto-detects a ZMODEM download and replays the prefix', () => {
		const timers = new ManualTimers();
		const session = new TransferSession({ sink: new MemoryFileSink(), timers });
		expect(session.detecting).toBe(true);
		session.receive(Uint8Array.of(0x18, 0x42, 0x30, 0x30));
		expect(session.engine).toBeInstanceOf(ZModemReceiver);
		expect(session.protocol).toBe('zmodem');
		expect(session.direction).toBe('receive');
		expect(decodeHexHeader(session.poll())?.type).toBe(ZFrame.ZRINIT);
		session.dispose();
	});

	it('auto-detects a ZMODEM upload', () => {
		const timers = new ManualTimers();
		const session = new TransferSession({ timers, files: [] });
		session.receive(Uint8Array.of(0x18, 0x42, 0x30, 0x31));
		expect(session.engine).toBeInstanceOf(ZModemSender);
		expect(session.direction).toBe('send');
		session.dispose();
	});

	it('auto-detects an XMODEM-CRC request from two C bytes', () => {
		const timers = new ManualTimers();
		const session = new TransferSession({
			timers,
			files: [{ name: 'a', size: 1, source: new MemoryFileSource(Uint8Array.of(1)) }],
		});
		session.receive(Uint8Array.of(0x43, 0x43));
		expect(session.engine).toBeInstanceOf(XModemSender);
		expect(session.protocol).toBe('xmodem-crc');
		expect(session.direction).toBe('send');
		session.dispose();
	});

	it('auto-detects an XMODEM checksum request from two NAK bytes', () => {
		const timers = new ManualTimers();
		const session = new TransferSession({ timers, files: [] });
		session.receive(Uint8Array.of(0x15, 0x15));
		expect(session.engine).toBeInstanceOf(XModemSender);
		expect(session.protocol).toBe('xmodem-chksum');
		session.dispose();
	});

	it('dispatches an XMODEM-CRC download to the receiver', () => {
		const timers = new ManualTimers();
		const session = new TransferSession({ protocol: 'xmodem-crc', timers, sink: new MemoryFileSink() });
		expect(session.engine).toBeInstanceOf(XModemReceiver);
		expect([...session.poll()]).toEqual([0x43]);
		session.dispose();
	});

	it('buffers bytes until detection, then feeds them all to the engine', () => {
		const timers = new ManualTimers();
		const session = new TransferSession({ timers });
		// First byte of the prefix, then the rest plus an XMODEM-ish tail.
		session.receive(Uint8Array.of(0x18));
		expect(session.engine).toBeNull();
		session.receive(Uint8Array.of(0x42, 0x30, 0x30));
		expect(session.engine).toBeInstanceOf(ZModemReceiver);
		// The engine saw the full ZRQINIT prefix and answered with ZRINIT.
		const headers: number[] = [];
		let out = session.poll();
		while (out.length) {
			const h = decodeHexHeader(out);
			if (!h) break;
			headers.push(h.type);
			out = new Uint8Array(0);
		}
		expect(headers).toContain(ZFrame.ZRINIT);
		session.dispose();
	});
});
