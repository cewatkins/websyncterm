import { describe, expect, it, vi } from 'vitest';
import { concatBytes } from '../src/bytes.js';
import { MemoryFileSink, MemoryFileSource } from '../src/files.js';
import { ManualTimers } from '../src/timers.js';
import {
	ZCRCE,
	ZCRCG,
	ZCRCW,
	ZFrame,
	ZFrameParser,
	ZModemReceiver,
	ZModemSender,
	decodeHexHeader,
	encodeBinaryHeader,
	encodeDataSubpacket,
	encodeHexHeader,
	makeHeader,
	zmodemFileInfoPayload,
} from '../src/zmodem.js';

const canFcs32 = 0x23;

function zfileFrame(
	name: string,
	size: number,
	mtime: number,
	opts: { fcs32?: boolean; files?: number; bytes?: number } = {},
): Uint8Array {
	const fcs32 = opts.fcs32 ?? true;
	const payload = zmodemFileInfoPayload(name, size, mtime, opts.files ?? 1, opts.bytes ?? size);
	return concatBytes([
		encodeBinaryHeader(makeHeader(ZFrame.ZFILE, 0, 1, 2), fcs32),
		encodeDataSubpacket(ZCRCW, payload, fcs32),
	]);
}

function dataFrame(pos: number, data: Uint8Array, type = ZCRCW, fcs32 = true): Uint8Array {
	return concatBytes([
		encodeBinaryHeader(makeHeader(ZFrame.ZDATA, pos, 0), fcs32),
		encodeDataSubpacket(type, data, fcs32),
	]);
}

function pollHeader(rx: ZModemReceiver) {
	return decodeHexHeader(rx.poll());
}

function ascii(text: string): Uint8Array {
	return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

describe('ZMODEM receiver', () => {
	it('announces ZRINIT with CANFDX|CANOVIO|CANFC32', () => {
		const timers = new ManualTimers();
		const rx = new ZModemReceiver({ sink: new MemoryFileSink(), timers });
		const h = pollHeader(rx);
		expect(h?.type).toBe(ZFrame.ZRINIT);
		expect(h?.f0).toBe(canFcs32);
		// ZRINIT carries no position; the low two header bytes hold the
		// receiver's buffer size (0 = unlimited).
		expect(h?.pos & 0xffff).toBe(0);
		rx.dispose();
	});

	it('answers ZRQINIT with another ZRINIT', () => {
		const timers = new ManualTimers();
		const rx = new ZModemReceiver({ sink: new MemoryFileSink(), timers });
		rx.poll();
		rx.receive(encodeHexHeader(makeHeader(ZFrame.ZRQINIT, 0, 0)));
		expect(pollHeader(rx)?.type).toBe(ZFrame.ZRINIT);
		rx.dispose();
	});

	it('handles ZFILE, ZDATA and ZEOF and writes the payload', async () => {
		const timers = new ManualTimers();
		const sink = new MemoryFileSink();
		const rx = new ZModemReceiver({ sink, timers });
		rx.poll();

		const data = ascii('hello zmodem');
		rx.receive(zfileFrame('test.bin', data.length, 0o1000000000));
		const zrpos = pollHeader(rx);
		expect(zrpos?.type).toBe(ZFrame.ZRPOS);
		expect(zrpos?.pos).toBe(0);
		expect(rx.progress.fileName).toBe('test.bin');
		expect(rx.progress.bytesTotal).toBe(data.length);
		expect(rx.progress.phase).toBe('transfer');

		rx.receive(dataFrame(0, data));
		const zack = pollHeader(rx);
		expect(zack?.type).toBe(ZFrame.ZACK);
		expect(zack?.pos).toBe(data.length);
		await rx.whenIdle;
		expect(sink.data).toEqual(data);

		rx.receive(encodeHexHeader(makeHeader(ZFrame.ZEOF, data.length, 0)));
		expect(pollHeader(rx)?.type).toBe(ZFrame.ZRINIT);
		expect(sink.closed).toBe(true);
		expect(rx.progress.fileIndex).toBe(1);
		expect(rx.progress.bytesTransferred).toBe(data.length);

		rx.receive(encodeHexHeader(makeHeader(ZFrame.ZFIN, 0, 0)));
		expect(pollHeader(rx)?.type).toBe(ZFrame.ZFIN);
		expect(rx.done).toBe(true);
		expect(rx.result?.ok).toBe(true);
		rx.dispose();
	});

	it('ACKs ZCRCW but not ZCRCE, and keeps reading ZCRCG', async () => {
		const timers = new ManualTimers();
		const sink = new MemoryFileSink();
		const rx = new ZModemReceiver({ sink, timers });
		rx.poll();
		const total = 64;
		rx.receive(zfileFrame('a.bin', total, 0));
		rx.poll();

		// One frame: ZDATA header, then ZCRCG subpackets, then a ZCRCE.
		const frame = concatBytes([
			encodeBinaryHeader(makeHeader(ZFrame.ZDATA, 0, 0), true),
			encodeDataSubpacket(ZCRCG, ascii('a'.repeat(16)), true),
			encodeDataSubpacket(ZCRCG, ascii('b'.repeat(16)), true),
			encodeDataSubpacket(ZCRCE, new Uint8Array(0), true),
		]);
		rx.receive(frame);
		expect(rx.poll().length).toBe(0); // ZCRCG/ZCRCE: no ACK
		expect(rx.progress.bytesTransferred).toBe(32);
		rx.receive(dataFrame(32, ascii('c'.repeat(32)), ZCRCW));
		expect(pollHeader(rx)?.type).toBe(ZFrame.ZACK);
		await rx.whenIdle;
		expect(sink.size).toBe(64);
		rx.dispose();
	});

	it('repositions the sender when the ZDATA offset is wrong', () => {
		const timers = new ManualTimers();
		const rx = new ZModemReceiver({ sink: new MemoryFileSink(), timers });
		rx.poll();
		rx.receive(zfileFrame('a.bin', 100, 0));
		rx.poll();

		rx.receive(dataFrame(50, ascii('nope'), ZCRCW));
		const zrpos = pollHeader(rx);
		expect(zrpos?.type).toBe(ZFrame.ZRPOS);
		expect(zrpos?.pos).toBe(0);
		rx.dispose();
	});

	it('sends ZRPOS with the resume offset before reading data', () => {
		const timers = new ManualTimers();
		const sink = new MemoryFileSink();
		const rx = new ZModemReceiver({ sink, timers, resumeFrom: 100 });
		rx.poll();
		rx.receive(zfileFrame('big.bin', 400, 0));
		const zrpos = pollHeader(rx);
		expect(zrpos?.type).toBe(ZFrame.ZRPOS);
		expect(zrpos?.pos).toBe(100);
		expect(rx.progress.bytesTransferred).toBe(100);

		rx.receive(dataFrame(100, ascii('tail'), ZCRCW));
		expect(pollHeader(rx)?.pos).toBe(104);
		expect(sink.data).toEqual(ascii('tail'));
		rx.dispose();
	});

	it('sends another ZRPOS after a corrupted data subpacket', () => {
		const timers = new ManualTimers();
		const rx = new ZModemReceiver({ sink: new MemoryFileSink(), timers });
		rx.poll();
		rx.receive(zfileFrame('a.bin', 10, 0));
		rx.poll();

		const frame = dataFrame(0, ascii('0123456789'), ZCRCE);
		frame[frame.length - 1] ^= 0xff;
		rx.receive(frame);
		const zrpos = pollHeader(rx);
		expect(zrpos?.type).toBe(ZFrame.ZRPOS);
		expect(zrpos?.pos).toBe(0);
		rx.dispose();
	});

	it('aborts on five consecutive CAN bytes', () => {
		const timers = new ManualTimers();
		const rx = new ZModemReceiver({ sink: new MemoryFileSink(), timers });
		rx.poll();
		rx.receive(Uint8Array.of(0x18, 0x18, 0x18, 0x18, 0x18));
		expect(rx.done).toBe(true);
		expect(rx.state.phase).toBe('aborted');
		rx.dispose();
	});

	it('emits ZABORT when cancelled locally', () => {
		const timers = new ManualTimers();
		const rx = new ZModemReceiver({ sink: new MemoryFileSink(), timers });
		rx.poll();
		rx.abort();
		expect(decodeHexHeader(rx.poll())?.type).toBe(ZFrame.ZABORT);
		rx.dispose();
	});

	it('retries ZRINIT on timeout', () => {
		const timers = new ManualTimers();
		const rx = new ZModemReceiver({ sink: new MemoryFileSink(), timers });
		rx.poll();
		timers.advance(10000);
		expect(pollHeader(rx)?.type).toBe(ZFrame.ZRINIT);
		rx.dispose();
	});
});

describe('ZMODEM sender', () => {
	it('sends ZFILE and then seeks to the requested ZRPOS', async () => {
		const timers = new ManualTimers();
		const data = new Uint8Array(600).map((_, i) => i & 0xff);
		const source = new MemoryFileSource(data, 100);
		const seek = vi.spyOn(source, 'seek');
		const tx = new ZModemSender({
			timers,
			files: [{ name: 'up.bin', size: data.length, mtime: 0o1000000000, source }],
		});

		await tx.pump();
		expect(tx.poll().length).toBe(0);

		tx.receive(encodeHexHeader(makeHeader(ZFrame.ZRINIT, 0, canFcs32)));
		await tx.pump();
		const fileFrame = tx.poll();
		const parser = new ZFrameParser();
		parser.push(fileFrame);
		const header = parser.readHeader();
		expect(header?.header.type).toBe(ZFrame.ZFILE);
		expect(header?.header.f0).toBe(1);
		expect(header?.header.f1).toBe(2);
		const sub = parser.readSubpacket(header?.fcs32 ?? false);
		expect(sub && !('corrupt' in sub) ? sub.type : -1).toBe(ZCRCW);

		tx.receive(encodeHexHeader(makeHeader(ZFrame.ZRPOS, 100, 0)));
		await tx.pump();
		expect(seek).toHaveBeenCalledWith(100);
		const dataOut = tx.poll();
		const p2 = new ZFrameParser();
		p2.push(dataOut);
		const dataHeader = p2.readHeader();
		expect(dataHeader?.header.type).toBe(ZFrame.ZDATA);
		expect(dataHeader?.header.pos).toBe(100);
		// The sender streams the rest of the file; the subpacket starts with
		// the byte at the requested offset.
		const tail = p2.readSubpacket(dataHeader?.fcs32 ?? false);
		expect(tail && !('corrupt' in tail) ? tail.data[0] : -1).toBe(data[100]);
		tx.dispose();
	});

	it('closes the final frame with ZCRCE and sends ZEOF', async () => {
		const timers = new ManualTimers();
		const data = new Uint8Array(100).fill(0x5a);
		const tx = new ZModemSender({
			timers,
			files: [{ name: 'short.bin', size: data.length, source: new MemoryFileSource(data) }],
		});
		tx.receive(encodeHexHeader(makeHeader(ZFrame.ZRINIT, 0, canFcs32)));
		await tx.pump();
		tx.poll(); // ZFILE
		tx.receive(encodeHexHeader(makeHeader(ZFrame.ZRPOS, 0, 0)));
		await tx.pump();

		const out = tx.poll();
		const parser = new ZFrameParser();
		parser.push(out);
		const header = parser.readHeader();
		const sub = parser.readSubpacket(header?.fcs32 ?? false);
		expect(sub && !('corrupt' in sub) ? sub.type : -1).toBe(ZCRCE);
		expect(tx.progress.phase).toBe('transfer');
		// ZEOF follows the closing ZCRCE in the same pump().
		const eof = parser.readHeader();
		expect(eof?.header.type).toBe(ZFrame.ZEOF);
		expect(eof?.header.pos).toBe(100);
		tx.dispose();
	});

	it('transfers a file end to end', async () => {
		const timers = new ManualTimers();
		const data = new Uint8Array(2500).map((_, i) => (i * 13) & 0xff);
		const sink = new MemoryFileSink();
		const rx = new ZModemReceiver({ sink, timers });
		const tx = new ZModemSender({
			timers,
			files: [{ name: 'roundtrip.bin', size: data.length, source: new MemoryFileSource(data, 700) }],
		});

		for (let i = 0; i < 500 && !(tx.done && rx.done); i++) {
			const toTx = rx.poll();
			if (toTx.length) tx.receive(toTx);
			await tx.pump();
			const toRx = tx.poll();
			if (toRx.length) rx.receive(toRx);
		}

		expect(tx.done).toBe(true);
		expect(rx.done).toBe(true);
		expect(tx.result?.ok).toBe(true);
		expect(rx.result?.ok).toBe(true);
		await rx.whenIdle;
		expect(sink.data).toEqual(data);
	});

	it('handles a file that is an exact multiple of the block size', async () => {
		const timers = new ManualTimers();
		const data = new Uint8Array(2048).map((_, i) => (i * 5) & 0xff);
		const sink = new MemoryFileSink();
		const rx = new ZModemReceiver({ sink, timers });
		const tx = new ZModemSender({
			timers,
			blockSize: 1024,
			files: [{ name: 'exact.bin', size: data.length, source: new MemoryFileSource(data) }],
		});
		for (let i = 0; i < 500 && !(tx.done && rx.done); i++) {
			const toTx = rx.poll();
			if (toTx.length) tx.receive(toTx);
			await tx.pump();
			const toRx = tx.poll();
			if (toRx.length) rx.receive(toRx);
		}
		await rx.whenIdle;
		expect(tx.done).toBe(true);
		expect(rx.done).toBe(true);
		expect(sink.data).toEqual(data);
	});

	it('transfers a batch and terminates the session', async () => {		const timers = new ManualTimers();
		const files = [
			{ name: 'a.bin', data: new Uint8Array(1500).fill(0x41) },
			{ name: 'b.bin', data: new Uint8Array(37).fill(0x42) },
		];
		const sinks: Record<string, MemoryFileSink> = {};
		const rx = new ZModemReceiver({
			timers,
			sinkFactory: (info) => (sinks[info.name] = new MemoryFileSink()),
		});
		const tx = new ZModemSender({
			timers,
			files: files.map((f) => ({
				name: f.name,
				size: f.data.length,
				source: new MemoryFileSource(f.data),
			})),
		});

		for (let i = 0; i < 500 && !(tx.done && rx.done); i++) {
			const toTx = rx.poll();
			if (toTx.length) tx.receive(toTx);
			await tx.pump();
			const toRx = tx.poll();
			if (toRx.length) rx.receive(toRx);
		}
		await rx.whenIdle;

		expect(tx.done).toBe(true);
		expect(rx.done).toBe(true);
		expect(sinks['a.bin'].data).toEqual(files[0].data);
		expect(sinks['b.bin'].data).toEqual(files[1].data);
		expect(rx.result?.files).toBe(2);
	});

	it('reports a file skipped by the receiver', async () => {
		const timers = new ManualTimers();
		const skipped: string[] = [];
		const tx = new ZModemSender({
			timers,
			files: [{ name: 'skip.bin', size: 10, source: new MemoryFileSource(new Uint8Array(10)) }],
			onSkip: (name) => skipped.push(name),
		});
		tx.receive(encodeHexHeader(makeHeader(ZFrame.ZRINIT, 0, canFcs32)));
		await tx.pump();
		tx.poll();
		tx.receive(encodeHexHeader(makeHeader(ZFrame.ZSKIP, 0, 0)));
		expect(skipped).toEqual(['skip.bin']);
		tx.dispose();
	});
});
