import { describe, expect, it } from 'vitest';
import { MemoryFileSink, MemoryFileSource, SinkWriter } from '../src/files.js';
import { PassthroughEngine } from '../src/passthrough.js';
import { ManualTimers } from '../src/timers.js';
import type { FileSink } from '../src/types.js';

describe('in-memory files', () => {
	it('accumulates writes and reports size/text', () => {
		const sink = new MemoryFileSink();
		sink.write(Uint8Array.of(0x68, 0x69));
		sink.write(Uint8Array.of(0x21));
		expect(sink.size).toBe(3);
		expect(sink.text).toBe('hi!');
		expect(sink.closed).toBe(false);
		sink.close();
		expect(sink.closed).toBe(true);
	});

	it('copies chunks so callers may reuse their buffers', () => {
		const sink = new MemoryFileSink();
		const buf = Uint8Array.of(1, 2, 3);
		sink.write(buf);
		buf[0] = 9;
		expect([...sink.data]).toEqual([1, 2, 3]);
	});

	it('reads in chunks and seeks', async () => {
		const src = new MemoryFileSource(Uint8Array.of(1, 2, 3, 4, 5), 2);
		expect([...(await src.read())!]).toEqual([1, 2]);
		expect([...(await src.read())!]).toEqual([3, 4]);
		expect([...(await src.read())!]).toEqual([5]);
		expect(await src.read()).toBeNull();
		src.seek(1);
		expect([...(await src.read())!]).toEqual([2, 3]);
		src.seek(99);
		expect(await src.read()).toBeNull();
	});

	it('serialises asynchronous sink writes', async () => {
		const seen: number[] = [];
		const slow: FileSink = {
			async write(chunk) {
				await new Promise((r) => setTimeout(r, 1));
				seen.push(chunk[0]);
			},
			async close() {
				seen.push(99);
			},
		};
		const writer = new SinkWriter(slow);
		writer.write(Uint8Array.of(1));
		writer.write(Uint8Array.of(2));
		writer.write(Uint8Array.of(3));
		writer.close();
		await writer.idle;
		expect(seen).toEqual([1, 2, 3, 99]);
	});
});

describe('PassthroughEngine', () => {
	it('writes received bytes straight to the sink', () => {
		const sink = new MemoryFileSink();
		const rx = new PassthroughEngine({ direction: 'receive', sink, timers: new ManualTimers() });
		rx.receive(Uint8Array.of(0x41, 0x42));
		expect(sink.text).toBe('AB');
		expect(rx.progress.bytesTransferred).toBe(2);
		rx.end();
		expect(rx.done).toBe(true);
	});

	it('sends every source byte verbatim', async () => {
		const data = Uint8Array.of(0x41, 0x0a, 0x42);
		const tx = new PassthroughEngine({
			direction: 'send',
			protocol: 'raw',
			timers: new ManualTimers(),
			files: [{ name: 'a.bin', size: data.length, source: new MemoryFileSource(data) }],
		});
		await tx.pump();
		expect([...tx.poll()]).toEqual([0x41, 0x0a, 0x42]);
		expect(tx.done).toBe(true);
	});

	it('translates newlines for ASCII sends', async () => {
		const tx = new PassthroughEngine({
			direction: 'send',
			protocol: 'ascii',
			translateNewlines: true,
			timers: new ManualTimers(),
			files: [
				{ name: 'a.txt', size: 2, source: new MemoryFileSource(Uint8Array.of(0x41, 0x0a)) },
			],
		});
		await tx.pump();
		expect([...tx.poll()]).toEqual([0x41, 0x0d, 0x0a]);
	});
});
