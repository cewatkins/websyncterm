import { concatBytes } from './bytes.js';
import type { FileSink, FileSource } from './types.js';

/**
 * An in-memory {@link FileSink}.  Useful for tests and for small transfers
 * the caller wants to hold in memory before persisting.
 */
export class MemoryFileSink implements FileSink {
	private chunks: Uint8Array[] = [];
	private length = 0;
	closed = false;

	/** Bytes written so far. */
	get size(): number {
		return this.length;
	}

	write(chunk: Uint8Array): void {
		if (this.closed) throw new Error('write after close');
		// Copy: callers are free to reuse their buffers.
		this.chunks.push(chunk.slice());
		this.length += chunk.length;
	}

	close(): void {
		this.closed = true;
	}

	/** All bytes written so far, as one array. */
	get data(): Uint8Array {
		return concatBytes(this.chunks);
	}

	/** All bytes written so far, decoded as latin1 (handy in assertions). */
	get text(): string {
		let s = '';
		for (const c of this.data) s += String.fromCharCode(c);
		return s;
	}
}

/**
 * An in-memory {@link FileSource}.  `seek()` makes it usable for ZMODEM
 * resume tests (and for real ZRPOS handling).
 */
export class MemoryFileSource implements FileSource {
	private pos = 0;
	closed = false;

	constructor(
		readonly data: Uint8Array,
		/** Largest chunk returned by a single read(). */
		private readonly chunkSize = 4096,
	) {}

	get position(): number {
		return this.pos;
	}

	get size(): number {
		return this.data.length;
	}

	async read(): Promise<Uint8Array | null> {
		if (this.pos >= this.data.length) return null;
		const end = Math.min(this.data.length, this.pos + this.chunkSize);
		const chunk = this.data.slice(this.pos, end);
		this.pos = end;
		return chunk;
	}

	seek(offset: number): void {
		this.pos = Math.max(0, Math.min(this.data.length, offset));
	}

	close(): void {
		this.closed = true;
	}
}

/**
 * Serialises writes to a {@link FileSink} so a synchronous protocol engine can
 * hand work to an asynchronous sink (IndexedDB) without reordering bytes.
 */
export class SinkWriter {
	private chain: Promise<void> = Promise.resolve();
	private asyncWrites = false;

	constructor(readonly sink: FileSink) {}

	write(chunk: Uint8Array): void {
		if (!this.asyncWrites) {
			// Synchronous sinks (MemoryFileSink, and most IndexedDB wrappers
			// that pre-allocate) see the write immediately.
			const result = this.sink.write(chunk);
			if (result && typeof (result as Promise<void>).then === 'function') {
				this.asyncWrites = true;
				this.chain = (result as Promise<void>).then(() => undefined);
			}
			return;
		}
		this.chain = this.chain.then(() => this.sink.write(chunk)).then(() => undefined);
	}

	close(): void {
		if (!this.asyncWrites) {
			const result = this.sink.close();
			if (result && typeof (result as Promise<void>).then === 'function') {
				this.asyncWrites = true;
				this.chain = (result as Promise<void>).then(() => undefined);
			}
			return;
		}
		this.chain = this.chain.then(() => this.sink.close()).then(() => undefined);
	}

	/** Resolve once every queued write and the close have settled. */
	get idle(): Promise<void> {
		return this.chain;
	}
}

/** Slice a chunk to at most `max` bytes. */
export function take(chunk: Uint8Array, max: number): Uint8Array {
	return chunk.length <= max ? chunk : chunk.subarray(0, max);
}
