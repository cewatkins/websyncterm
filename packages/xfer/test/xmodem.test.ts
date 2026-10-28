import { describe, expect, it } from 'vitest';
import {
	ACK,
	CAN,
	CPMEOF,
	CRC_REQUEST,
	EOT,
	NAK,
	SOH,
	XModemReceiver,
	XModemSender,
	XMODEM_TIMEOUTS,
	baseName,
	encodeXModemBlock,
	parseYModemBlock0,
	xmodemCancelSequence,
	ymodemBlock0,
} from '../src/xmodem.js';
import { MemoryFileSink, MemoryFileSource } from '../src/files.js';
import { ManualTimers } from '../src/timers.js';
import { concatBytes } from '../src/bytes.js';

function payload128(seed = 0): Uint8Array {
	const data = new Uint8Array(128);
	for (let i = 0; i < data.length; i++) data[i] = (seed + i * 7) & 0xff;
	return data;
}

describe('XMODEM receiver', () => {
	it('asks for CRC with C on construction', () => {
		const timers = new ManualTimers();
		const rx = new XModemReceiver({ sink: new MemoryFileSink(), timers });
		expect([...rx.poll()]).toEqual([CRC_REQUEST]);
		expect(rx.state.phase).toBe('handshake');
		rx.dispose();
	});

	it('ACKs a valid CRC block and writes the payload to the sink', () => {
		const timers = new ManualTimers();
		const sink = new MemoryFileSink();
		const rx = new XModemReceiver({ sink, timers, fileName: 'a.bin' });
		expect([...rx.poll()]).toEqual([CRC_REQUEST]);

		const data = payload128();
		rx.receive(encodeXModemBlock(1, data, 128, true));

		expect([...rx.poll()]).toEqual([ACK]);
		expect(sink.data).toEqual(data);
		expect(rx.progress.bytesTransferred).toBe(128);
		expect(rx.progress.blockNumber).toBe(1);
		rx.dispose();
	});

	it('NAKs a block with a bad CRC and does not write it', () => {
		const timers = new ManualTimers();
		const sink = new MemoryFileSink();
		const rx = new XModemReceiver({ sink, timers });
		rx.poll();

		const block = encodeXModemBlock(1, payload128(), 128, true);
		block[block.length - 1] ^= 0xff;
		rx.receive(block);

		expect([...rx.poll()]).toEqual([NAK]);
		expect(sink.size).toBe(0);
		expect(rx.done).toBe(false);
		rx.dispose();
	});

	it('NAKs a block whose complement does not match', () => {
		const rx = new XModemReceiver({ sink: new MemoryFileSink(), timers: new ManualTimers() });
		rx.poll();
		const block = encodeXModemBlock(1, payload128(), 128, true);
		block[2] ^= 0x01;
		rx.receive(block);
		expect([...rx.poll()]).toEqual([NAK]);
		rx.dispose();
	});

	it('uses the checksum variant when the variant says so', () => {
		const timers = new ManualTimers();
		const sink = new MemoryFileSink();
		const rx = new XModemReceiver({ sink, timers, variant: 'xmodem-chksum' });
		expect([...rx.poll()]).toEqual([NAK]);

		const data = payload128(3);
		rx.receive(encodeXModemBlock(1, data, 128, false));
		expect([...rx.poll()]).toEqual([ACK]);
		expect(sink.data).toEqual(data);
		rx.dispose();
	});

	it('handles a 1024-byte block for XMODEM-1K', () => {
		const timers = new ManualTimers();
		const sink = new MemoryFileSink();
		const rx = new XModemReceiver({ sink, timers, variant: 'xmodem-1k' });
		rx.poll();
		const data = new Uint8Array(1024).map((_, i) => (i * 3) & 0xff);
		rx.receive(encodeXModemBlock(1, data, 1024, true));
		expect([...rx.poll()]).toEqual([ACK]);
		expect(sink.size).toBe(1024);
		rx.dispose();
	});

	it('ACKs EOT only after NAKing the first one (double-EOT trick)', () => {
		const timers = new ManualTimers();
		const sink = new MemoryFileSink();
		const rx = new XModemReceiver({ sink, timers });
		rx.poll();
		rx.receive(encodeXModemBlock(1, payload128(), 128, true));
		rx.poll();

		rx.receive(Uint8Array.of(EOT));
		expect([...rx.poll()]).toEqual([NAK]);

		rx.receive(Uint8Array.of(EOT));
		expect([...rx.poll()]).toEqual([ACK]);
		expect(rx.done).toBe(true);
		expect(rx.result?.ok).toBe(true);
		expect(sink.closed).toBe(true);
		rx.dispose();
	});

	it('aborts after two consecutive CAN bytes', () => {
		const rx = new XModemReceiver({ sink: new MemoryFileSink(), timers: new ManualTimers() });
		rx.poll();
		rx.receive(Uint8Array.of(CAN, CAN));
		expect(rx.done).toBe(true);
		expect(rx.state.phase).toBe('aborted');
		rx.dispose();
	});

	it('emits the local cancel sequence: 8 x CAN then 10 x BS', () => {
		const rx = new XModemReceiver({ sink: new MemoryFileSink(), timers: new ManualTimers() });
		rx.poll();
		rx.abort();
		const out = rx.poll();
		expect(out.length).toBe(18);
		expect([...out.subarray(0, 8)]).toEqual([CAN, CAN, CAN, CAN, CAN, CAN, CAN, CAN]);
		expect([...out.subarray(8)]).toEqual(new Array(10).fill(0x08));
		expect([...xmodemCancelSequence()]).toEqual([...out]);
		expect(rx.state.phase).toBe('aborted');
	});

	it('re-requests the mode when the header times out', () => {
		const timers = new ManualTimers();
		const rx = new XModemReceiver({ sink: new MemoryFileSink(), timers });
		expect([...rx.poll()]).toEqual([CRC_REQUEST]);
		timers.advance(XMODEM_TIMEOUTS.handshake);
		expect([...rx.poll()]).toEqual([CRC_REQUEST]);
		rx.dispose();
	});

	it('pads a short final block with CPMEOF on the wire', () => {
		const block = encodeXModemBlock(1, new Uint8Array(128).fill(CPMEOF), 128, true);
		expect(block[0]).toBe(SOH);
		expect(block[1]).toBe(1);
		expect(block[2]).toBe(0xfe);
	});
});

describe('XMODEM sender', () => {
	it('waits for the receiver to choose the mode', async () => {
		const timers = new ManualTimers();
		const source = new MemoryFileSource(new Uint8Array(300).fill(0x41));
		const tx = new XModemSender({
			timers,
			files: [{ name: 'x.bin', size: 300, source }],
			variant: 'xmodem-crc',
		});
		await tx.pump();
		expect(tx.poll().length).toBe(0);

		tx.receive(Uint8Array.of(CRC_REQUEST));
		await tx.pump();
		const block = tx.poll();
		expect(block[0]).toBe(SOH);
		expect(block[1]).toBe(1);
		expect(block[2]).toBe(0xfe);
		expect(block.length).toBe(3 + 128 + 2);

		tx.receive(Uint8Array.of(ACK));
		await tx.pump();
		const second = tx.poll();
		expect(second[1]).toBe(2);

		// Remaining 44 bytes: short block padded with CPMEOF.
		tx.receive(Uint8Array.of(ACK));
		await tx.pump();
		const third = tx.poll();
		expect(third[1]).toBe(3);
		expect(third[3 + 44]).toBe(CPMEOF);

		tx.receive(Uint8Array.of(ACK));
		await tx.pump();
		expect([...tx.poll()]).toEqual([EOT]);

		tx.receive(Uint8Array.of(ACK));
		await tx.pump();
		expect(tx.done).toBe(true);
		expect(tx.result?.bytes).toBe(300);
		tx.dispose();
	});

	it('retransmits the last block after a NAK', async () => {
		const timers = new ManualTimers();
		const source = new MemoryFileSource(new Uint8Array(128).fill(0x42));
		const tx = new XModemSender({
			timers,
			files: [{ name: 'x.bin', size: 128, source }],
		});
		tx.receive(Uint8Array.of(CRC_REQUEST));
		await tx.pump();
		const first = tx.poll();
		tx.receive(Uint8Array.of(NAK));
		await tx.pump();
		expect([...tx.poll()]).toEqual([...first]);
		tx.dispose();
	});

	it('honours a checksum-mode request', async () => {
		const timers = new ManualTimers();
		const source = new MemoryFileSource(new Uint8Array(128).fill(0x43));
		const tx = new XModemSender({
			timers,
			files: [{ name: 'x.bin', size: 128, source }],
			variant: 'xmodem-crc',
		});
		tx.receive(Uint8Array.of(NAK));
		await tx.pump();
		const block = tx.poll();
		expect(block.length).toBe(3 + 128 + 1);
	});
});

describe('XMODEM end to end', () => {
	it('transfers a file from sender to receiver', async () => {
		const timers = new ManualTimers();
		const data = new Uint8Array(700).map((_, i) => (i * 11) & 0xff);
		const sink = new MemoryFileSink();
		const rx = new XModemReceiver({ sink, timers });
		const tx = new XModemSender({
			timers,
			files: [{ name: 'roundtrip.bin', size: data.length, source: new MemoryFileSource(data, 100) }],
		});

		for (let i = 0; i < 100 && !tx.done; i++) {
			const toSender = rx.poll();
			if (toSender.length) tx.receive(toSender);
			await tx.pump();
			const toReceiver = tx.poll();
			if (toReceiver.length) rx.receive(toReceiver);
			if (tx.done && !rx.done) continue;
			if (rx.done && tx.done) break;
		}

		expect(tx.done).toBe(true);
		expect(rx.done).toBe(true);
		// XMODEM carries no length: the final block is CPMEOF-padded.
		expect(sink.data.subarray(0, data.length)).toEqual(data);
		for (let i = data.length; i < sink.size; i++) expect(sink.data[i]).toBe(CPMEOF);
	});
});

describe('YMODEM helpers', () => {
	it('builds the block-0 payload with octal mtime and zero mode/serial', () => {
		const block = ymodemBlock0('dir/file.txt', 1234, 0o1234567, 2, 4321, 128);
		expect(block.length).toBe(128);
		const info = parseYModemBlock0(block);
		expect(info).toEqual({
			name: 'file.txt',
			size: 1234,
			mtime: 0o1234567,
			mode: 0,
			serial: 0,
			filesRemaining: 2,
			bytesRemaining: 4321,
			index: 0,
		});
		expect(block[0]).toBe('f'.charCodeAt(0));
		const text = [...block].map((b) => String.fromCharCode(b)).join('');
		expect(text).toContain('1234 1234567 0 0 2 4321');
	});

	it('returns null for the empty batch terminator', () => {
		expect(parseYModemBlock0(new Uint8Array(128))).toBeNull();
	});

	it('strips directories from the name', () => {
		expect(baseName('/a/b/c.txt')).toBe('c.txt');
		expect(baseName('C:\\a\\b.txt')).toBe('b.txt');
	});
});

describe('YMODEM receiver', () => {
	it('parses block 0 then a data block', () => {
		const timers = new ManualTimers();
		const sink = new MemoryFileSink();
		let opened: { name: string; size: number } | null = null;
		const rx = new XModemReceiver({
			timers,
			variant: 'ymodem',
			sinkFactory: (info) => {
				opened = { name: info.name, size: info.size };
				return sink;
			},
		});
		expect([...rx.poll()]).toEqual([CRC_REQUEST]);

		const header = ymodemBlock0('hello.txt', 200, 0o1234567, 1, 200, 128);
		rx.receive(encodeXModemBlock(0, header, 128, true));
		expect([...rx.poll()]).toEqual([ACK]);
		expect(opened).toEqual({ name: 'hello.txt', size: 200 });
		expect(rx.progress.fileName).toBe('hello.txt');
		expect(rx.progress.bytesTotal).toBe(200);

		const data = payload128(9);
		rx.receive(encodeXModemBlock(1, data, 128, true));
		expect([...rx.poll()]).toEqual([ACK]);
		expect(sink.size).toBe(128);
		expect(rx.progress.bytesTransferred).toBe(128);

		// Second block; only 72 bytes belong to the file, so it is truncated.
		const data2 = payload128(4);
		rx.receive(encodeXModemBlock(2, data2, 128, true));
		expect([...rx.poll()]).toEqual([ACK]);
		expect(sink.size).toBe(200);
		rx.dispose();
	});

	it('handles EOT and then the empty batch terminator', () => {
		const timers = new ManualTimers();
		const sink = new MemoryFileSink();
		const rx = new XModemReceiver({ timers, variant: 'ymodem', sinkFactory: () => sink });
		rx.poll();
		rx.receive(encodeXModemBlock(0, ymodemBlock0('a.txt', 3, 0, 1, 3), 128, true));
		rx.poll();
		rx.receive(encodeXModemBlock(1, concatBytes([Uint8Array.of(0x61, 0x62, 0x63), new Uint8Array(125)]), 128, true));
		rx.poll();

		rx.receive(Uint8Array.of(EOT));
		expect([...rx.poll()]).toEqual([NAK]);
		rx.receive(Uint8Array.of(EOT));
		expect([...rx.poll()]).toEqual([ACK, CRC_REQUEST]);
		expect(sink.closed).toBe(true);
		expect(sink.size).toBe(3);

		rx.receive(encodeXModemBlock(0, new Uint8Array(128), 128, true));
		expect([...rx.poll()]).toEqual([ACK]);
		expect(rx.done).toBe(true);
		expect(rx.result?.files).toBe(1);
		rx.dispose();
	});

	it('transfers a YMODEM batch end to end', async () => {
		const timers = new ManualTimers();
		const fileA = new Uint8Array(150).fill(0x41);
		const fileB = new Uint8Array(64).fill(0x42);
		const sinks: Record<string, MemoryFileSink> = {};
		const rx = new XModemReceiver({
			timers,
			variant: 'ymodem',
			sinkFactory: (info) => (sinks[info.name] = new MemoryFileSink()),
		});
		const tx = new XModemSender({
			timers,
			variant: 'ymodem',
			files: [
				{ name: 'a.bin', size: fileA.length, mtime: 0o1000000000, source: new MemoryFileSource(fileA) },
				{ name: 'b.bin', size: fileB.length, mtime: 0o1000000001, source: new MemoryFileSource(fileB) },
			],
		});

		for (let i = 0; i < 200 && !(tx.done && rx.done); i++) {
			const toSender = rx.poll();
			if (toSender.length) tx.receive(toSender);
			await tx.pump();
			const toReceiver = tx.poll();
			if (toReceiver.length) rx.receive(toReceiver);
		}
		await rx.whenIdle;

		expect(tx.done).toBe(true);
		expect(rx.done).toBe(true);
		expect(sinks['a.bin'].data).toEqual(fileA);
		expect(sinks['b.bin'].data).toEqual(fileB);
	});
});
