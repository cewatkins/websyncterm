/** Small byte helpers shared by the engines. */

/** Concatenate byte chunks into a fresh array. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const c of chunks) length += c.length;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

/** Build a Uint8Array from a list of byte values. */
export function bytes(...values: number[]): Uint8Array {
	return new Uint8Array(values);
}

/** ASCII/UTF-8 encoding of a string. */
export function ascii(text: string): Uint8Array {
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
	return out;
}

/** Decode a NUL-free ASCII prefix of a byte array. */
export function asciiString(data: Uint8Array, start = 0, end = data.length): string {
	let s = '';
	for (let i = start; i < end; i++) {
		if (data[i] === 0) break;
		s += String.fromCharCode(data[i]);
	}
	return s;
}

/** A growable FIFO of bytes with cheap append and drain. */
export class ByteQueue {
	private buf = new Uint8Array(1024);
	private start = 0;
	private end = 0;

	get length(): number {
		return this.end - this.start;
	}

	push(data: Uint8Array): void {
		this.reserve(this.length + data.length);
		this.buf.set(data, this.end);
		this.end += data.length;
	}

	private reserve(capacity: number): void {
		if (capacity <= this.buf.length) return;
		let size = this.buf.length;
		while (size < capacity) size *= 2;
		const next = new Uint8Array(size);
		next.set(this.buf.subarray(this.start, this.end));
		this.buf = next;
		this.end -= this.start;
		this.start = 0;
	}

	/** A view of the readable bytes. Do not mutate. */
	get view(): Uint8Array {
		return this.buf.subarray(this.start, this.end);
	}

	/** Drop `count` bytes from the head. */
	consume(count: number): void {
		if (count <= 0) return;
		this.start = Math.min(this.end, this.start + count);
		if (this.start === this.end) {
			this.start = 0;
			this.end = 0;
		} else if (this.start > 4096 && this.start * 2 > this.buf.length) {
			this.buf.copyWithin(0, this.start, this.end);
			this.end -= this.start;
			this.start = 0;
		}
	}

	clear(): void {
		this.start = 0;
		this.end = 0;
	}
}
