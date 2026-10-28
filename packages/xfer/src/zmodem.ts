/**
 * ZMODEM, mirroring `src/sbbs3/zmodem.c` / `zmodem.h`.
 *
 * Header bytes on the wire are `[FTYPE, ZP0, ZP1, ZP2, ZP3]` where ZP0 is the
 * *low* byte of the 32-bit file position and ZP3 (byte 4) is the high byte.
 * The flag bytes overlay those same slots:
 *
 *   header[1] = position bits 0-7   | ZF3
 *   header[2] = position bits 8-15  | ZF2
 *   header[3] = position bits 16-23 | ZF1
 *   header[4] = position bits 24-31 | ZF0
 *
 * Frame types and flag bits are taken verbatim from `zmodem.h`.
 */

import { ascii, asciiString, concatBytes } from './bytes.js';
import { crc16, crc16Update, crc32Update } from './crc.js';
import { TransferEngine } from './engine.js';
import { SinkWriter } from './files.js';
import type { EngineOptions, FileSink, TransferFile } from './types.js';

/* ------------------------------------------------------------------ */
/* Wire constants                                                      */
/* ------------------------------------------------------------------ */

export const ZPAD = 0x2a;
export const ZDLE = 0x18;
export const ZDLEE = 0x58;
export const ZBIN = 0x41;
export const ZHEX = 0x42;
export const ZBIN32 = 0x43;
export const ZRESC = 0x7e;

export const ZCRCE = 0x68;
export const ZCRCG = 0x69;
export const ZCRCQ = 0x6a;
export const ZCRCW = 0x6b;
export const ZRUB0 = 0x6c;
export const ZRUB1 = 0x6d;

/** ZMODEM frame types (`zmodem.h`). */
export const ZFrame = {
	ZRQINIT: 0x00,
	ZRINIT: 0x01,
	ZSINIT: 0x02,
	ZACK: 0x03,
	ZFILE: 0x04,
	ZSKIP: 0x05,
	ZNAK: 0x06,
	ZABORT: 0x07,
	ZFIN: 0x08,
	ZRPOS: 0x09,
	ZDATA: 0x0a,
	ZEOF: 0x0b,
	ZFERR: 0x0c,
	ZCRC: 0x0d,
	ZCHALLENGE: 0x0e,
	ZCOMPL: 0x0f,
	ZCAN: 0x10,
	ZFREECNT: 0x11,
	ZCOMMAND: 0x12,
	ZSTDERR: 0x13,
} as const;

/** ZF0 receiver flags. */
export const ZF0 = {
	CANFDX: 0x01,
	CANOVIO: 0x02,
	CANBRK: 0x04,
	CANFC32: 0x20,
	ESCCTL: 0x40,
	ESC8: 0x80,
} as const;

/** ZF1 flags. */
export const ZF1 = {
	CANVHDR: 0x01,
	ZMSKNOLOC: 0x80,
	ZMCRC: 0x02,
	ZMCLOB: 0x04,
	ZMNEW: 0x05,
} as const;

/** ZFILE ZF0 conversion option: binary. */
export const ZCBIN = 1;

/**
 * A decoded ZMODEM header.
 *
 * `f0`..`f3` are the raw flag bytes; `pos` is the 32-bit position assembled
 * from the same slots.
 */
export interface ZHeader {
	type: number;
	pos: number;
	f0: number;
	f1: number;
	f2: number;
	f3: number;
}

export function headerFromBytes(bytes: Uint8Array): ZHeader {
	return {
		type: bytes[0],
		pos: (bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24)) >>> 0,
		f3: bytes[1],
		f2: bytes[2],
		f1: bytes[3],
		f0: bytes[4],
	};
}

export function headerToBytes(header: ZHeader): Uint8Array {
	const pos = header.pos >>> 0;
	return new Uint8Array([
		header.type & 0xff,
		((pos & 0xff) | header.f3) & 0xff,
		(((pos >>> 8) & 0xff) | header.f2) & 0xff,
		(((pos >>> 16) & 0xff) | header.f1) & 0xff,
		(((pos >>> 24) & 0xff) | header.f0) & 0xff,
	]);
}

/** Convenience constructor for a 5-byte header. */
export function makeHeader(type: number, pos = 0, f0 = 0, f1 = 0, f2 = 0, f3 = 0): Uint8Array {
	return headerToBytes({ type, pos, f0, f1, f2, f3 });
}

/* ------------------------------------------------------------------ */
/* Escaping                                                            */
/* ------------------------------------------------------------------ */

/** Bytes that are always ZDLE-escaped. */
const ALWAYS_ESCAPE = new Set([0x10, 0x11, 0x13, 0x18, 0x90, 0x91, 0x93, 0x98]);
const FLOW = new Set([0x11, 0x13, 0x91, 0x93]);

export interface ZEscapeOptions {
	/** Escape all control characters (ZF0_ESCCTL). */
	escapeCtrl?: boolean;
	/** Escape 0xFF as ZDLE ZRUB1 (telnet IAC safety). */
	escapeTelnetIac?: boolean;
}

export function needsEscape(byte: number, opts: ZEscapeOptions = {}): boolean {
	if (ALWAYS_ESCAPE.has(byte)) return true;
	if (byte === 0xff && opts.escapeTelnetIac) return true;
	if (opts.escapeCtrl && (byte & 0x60) === 0) return true;
	return false;
}

/** ZDLE-escape one byte, appending to `out`. */
export function escapeByte(byte: number, out: number[], opts: ZEscapeOptions = {}): void {
	if (!needsEscape(byte, opts)) {
		out.push(byte);
		return;
	}
	out.push(ZDLE);
	out.push(byte === 0xff && opts.escapeTelnetIac ? ZRUB1 : byte ^ 0x40);
}

export function escapeBytes(data: Uint8Array, opts: ZEscapeOptions = {}): Uint8Array {
	const out: number[] = [];
	for (let i = 0; i < data.length; i++) escapeByte(data[i], out, opts);
	return new Uint8Array(out);
}

/**
 * Decode a ZDLE-escaped byte stream (`zmodem_rx()` rules).
 *
 * Bare XON/XOFF bytes are dropped; `ZDLE` + `ZRUB0/ZRUB1` map to 0x7F/0xFF;
 * other `ZDLE x` pairs encode `x ^ 0x40`.  ZDLE + a 0x68..0x6B byte is a
 * subpacket terminator, not data, and is dropped here.
 */
export function decodeEscaped(data: Uint8Array): Uint8Array {
	const out: number[] = [];
	for (let i = 0; i < data.length; i++) {
		const c = data[i];
		if (FLOW.has(c)) continue;
		if (c !== ZDLE) {
			out.push(c);
			continue;
		}
		const next = data[++i];
		if (next === undefined) break;
		if (FLOW.has(next) || next === ZDLE) continue;
		if (next >= ZCRCE && next <= ZCRCW) continue;
		if (next === ZRUB0) out.push(0x7f);
		else if (next === ZRUB1) out.push(0xff);
		else if ((next & 0x60) === 0x40) out.push(next ^ 0x40);
		// Anything else is an illegal sequence and is dropped.
	}
	return new Uint8Array(out);
}

/* ------------------------------------------------------------------ */
/* Frame encoding                                                      */
/* ------------------------------------------------------------------ */

const HEX_DIGITS = '0123456789abcdef';

/** Encode a hex header (`ZPAD ZPAD ZDLE ZHEX` + 14 hex digits + CR LF + XON). */
export function encodeHexHeader(header: Uint8Array, options: { xon?: boolean } = {}): Uint8Array {
	if (header.length !== 5) throw new Error('a ZMODEM header is exactly 5 bytes');
	const crc = crc16(header);
	const out: number[] = [ZPAD, ZPAD, ZDLE, ZHEX];
	for (let i = 0; i < 5; i++) {
		out.push(HEX_DIGITS.charCodeAt(header[i] >> 4), HEX_DIGITS.charCodeAt(header[i] & 0xf));
	}
	out.push(
		HEX_DIGITS.charCodeAt((crc >> 12) & 0xf),
		HEX_DIGITS.charCodeAt((crc >> 8) & 0xf),
		HEX_DIGITS.charCodeAt((crc >> 4) & 0xf),
		HEX_DIGITS.charCodeAt(crc & 0xf),
	);
	out.push(0x0d, 0x0a);
	// SyncTERM omits the trailing XON for ZACK and ZFIN.
	const omitXon = header[0] === ZFrame.ZACK || header[0] === ZFrame.ZFIN;
	if (!omitXon && options.xon !== false) out.push(0x11);
	return new Uint8Array(out);
}

/** Encode a binary-16 header (`ZPAD ZPAD ZDLE ZBIN` + escaped header + CRC-16). */
export function encodeBin16Header(header: Uint8Array, opts: ZEscapeOptions = {}): Uint8Array {
	if (header.length !== 5) throw new Error('a ZMODEM header is exactly 5 bytes');
	const crc = crc16(header);
	const out: number[] = [ZPAD, ZPAD, ZDLE, ZBIN];
	for (let i = 0; i < 5; i++) escapeByte(header[i], out, opts);
	escapeByte((crc >> 8) & 0xff, out, opts);
	escapeByte(crc & 0xff, out, opts);
	return new Uint8Array(out);
}

/** Encode a binary-32 header (`ZPAD ZPAD ZDLE ZBIN32` + escaped header + CRC-32 LE). */
export function encodeBin32Header(header: Uint8Array, opts: ZEscapeOptions = {}): Uint8Array {
	if (header.length !== 5) throw new Error('a ZMODEM header is exactly 5 bytes');
	let crc = 0xffffffff;
	for (let i = 0; i < 5; i++) crc = crc32Update(crc, header[i]);
	crc = ~crc >>> 0;
	const out: number[] = [ZPAD, ZPAD, ZDLE, ZBIN32];
	for (let i = 0; i < 5; i++) escapeByte(header[i], out, opts);
	for (let i = 0; i < 4; i++) escapeByte((crc >>> (8 * i)) & 0xff, out, opts);
	return new Uint8Array(out);
}

/** Encode a header in the requested style. */
export function encodeBinaryHeader(
	header: Uint8Array,
	fcs32: boolean,
	opts: ZEscapeOptions = {},
): Uint8Array {
	return fcs32 ? encodeBin32Header(header, opts) : encodeBin16Header(header, opts);
}

/**
 * Encode one data subpacket: escaped data, `ZDLE <type>`, then the frame check
 * (CRC-16 big-endian, or complemented CRC-32 little-endian).
 */
export function encodeDataSubpacket(
	type: number,
	data: Uint8Array,
	fcs32: boolean,
	opts: ZEscapeOptions = {},
	xon = false,
): Uint8Array {
	const out: number[] = [];
	let crc16v = 0;
	let crc32v = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc16v = crc16Update(crc16v, data[i]);
		crc32v = crc32Update(crc32v, data[i]);
		escapeByte(data[i], out, opts);
	}
	crc16v = crc16Update(crc16v, type);
	crc32v = crc32Update(crc32v, type);
	out.push(ZDLE, type);
	if (fcs32) {
		const crc = ~crc32v >>> 0;
		for (let i = 0; i < 4; i++) escapeByte((crc >>> (8 * i)) & 0xff, out, opts);
	} else {
		escapeByte((crc16v >> 8) & 0xff, out, opts);
		escapeByte(crc16v & 0xff, out, opts);
	}
	if (xon || type === ZCRCW) out.push(0x11);
	return new Uint8Array(out);
}

/** A parsed ZMODEM header frame. */
export interface ParsedZHeader {
	header: ZHeader;
	bytes: Uint8Array;
	hex: boolean;
	fcs32: boolean;
}

export interface ParsedZSubpacket {
	type: number;
	data: Uint8Array;
}

function hexValue(byte: number): number {
	if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
	if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
	if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
	return -1;
}

/** Decode a complete hex header (with or without the ZPAD prefix). */
export function decodeHexHeader(frame: Uint8Array): ZHeader | null {
	let start = 0;
	if (frame[0] === ZPAD) {
		start = 1;
		if (frame[start] === ZPAD) start++;
		if (frame[start] === ZDLE) start++;
		if (frame[start] === ZHEX) start++;
	}
	const digits = frame.subarray(start, start + 14);
	if (digits.length < 14) return null;
	const bytes = new Uint8Array(7);
	for (let i = 0; i < 7; i++) {
		const hi = hexValue(digits[i * 2]);
		const lo = hexValue(digits[i * 2 + 1]);
		if (hi < 0 || lo < 0) return null;
		bytes[i] = (hi << 4) | lo;
	}
	const header = bytes.subarray(0, 5);
	if (crc16(header) !== ((bytes[5] << 8) | bytes[6])) return null;
	return headerFromBytes(header);
}

/* ------------------------------------------------------------------ */
/* Incremental frame parser                                            */
/* ------------------------------------------------------------------ */

/** Sentinel: a malformed frame was consumed; keep looking. */
const SKIP = Symbol('skip');

/**
 * Incremental ZMODEM frame reader.  Bytes can arrive in arbitrarily small
 * pieces; an incomplete frame is retained until more data arrives.
 */
export class ZFrameParser {
	private buf: Uint8Array = new Uint8Array(0);

	/**
	 * @param escapeCtrl drop unescaped control bytes, matching the
	 *   `escape_ctrl_chars` filter in `zmodem_rx()`.
	 */
	constructor(private readonly escapeCtrl = false) {}

	push(data: Uint8Array): void {
		this.buf = concatBytes([this.buf, data]);
	}

	get pending(): number {
		return this.buf.length;
	}

	/**
	 * Consume the next complete header.  Returns `null` when more bytes are
	 * needed.  Garbage before a header is skipped silently.
	 */
	readHeader(): ParsedZHeader | null {
		for (;;) {
			if (this.buf.length === 0) return null;
			const pad = this.buf.indexOf(ZPAD);
			if (pad < 0) {
				this.buf = new Uint8Array(0);
				return null;
			}
			if (pad > 0) this.buf = this.buf.subarray(pad);

			let i = 1;
			if (this.buf.length <= i) return null;
			if (this.buf[i] === ZPAD) i++;
			if (this.buf.length <= i) return null;
			if (this.buf[i] !== ZDLE) {
				this.buf = this.buf.subarray(1);
				continue;
			}
			i++;
			if (this.buf.length <= i) return null;
			const style = this.buf[i];
			const start = i + 1;
			if (style === ZHEX) {
				const parsed = this.parseHex(start);
				if (parsed === null) return null;
				if (parsed === SKIP) continue;
				return parsed;
			}
			if (style === ZBIN || style === ZBIN32) {
				const parsed = this.parseBin(start, style === ZBIN32);
				if (parsed === null) return null;
				if (parsed === SKIP) continue;
				return parsed;
			}
			// Unknown/variable header style: drop one byte and resynchronise.
			this.buf = this.buf.subarray(1);
		}
	}

	private parseHex(start: number): ParsedZHeader | null | typeof SKIP {
		if (this.buf.length < start + 14) return null;
		const digits = this.buf.subarray(start, start + 14);
		const bytes = new Uint8Array(7);
		for (let i = 0; i < 7; i++) {
			const hi = hexValue(digits[i * 2]);
			const lo = hexValue(digits[i * 2 + 1]);
			if (hi < 0 || lo < 0) {
				this.buf = this.buf.subarray(start);
				return SKIP;
			}
			bytes[i] = (hi << 4) | lo;
		}
		let i = start + 14;
		// Hex headers are terminated by CR LF (LF alone is tolerated).
		while (i < this.buf.length && FLOW.has(this.buf[i])) i++;
		if (i >= this.buf.length) return null;
		if (this.buf[i] === 0x0d) {
			i++;
			while (i < this.buf.length && FLOW.has(this.buf[i])) i++;
			if (i >= this.buf.length) return null;
		}
		if (this.buf[i] !== 0x0a) {
			this.buf = this.buf.subarray(1);
			return SKIP;
		}
		i++;
		const headerBytes = bytes.subarray(0, 5);
		if (crc16(headerBytes) !== ((bytes[5] << 8) | bytes[6])) {
			this.buf = this.buf.subarray(i);
			return SKIP;
		}
		this.buf = this.buf.subarray(i);
		return { header: headerFromBytes(headerBytes), bytes: headerBytes.slice(), hex: true, fcs32: false };
	}

	private parseBin(start: number, fcs32: boolean): ParsedZHeader | null | typeof SKIP {
		const cursor = new Cursor(this.buf, start, this.escapeCtrl);
		const bytes = new Uint8Array(5);
		let crc16v = 0;
		let crc32v = 0xffffffff;
		for (let i = 0; i < 5; i++) {
			const v = cursor.rx();
			if (v === null) return null;
			if ('special' in v) return SKIP;
			bytes[i] = v.value;
			crc16v = crc16Update(crc16v, v.value);
			crc32v = crc32Update(crc32v, v.value);
		}
		if (fcs32) {
			let rxd = 0;
			for (let i = 0; i < 4; i++) {
				const v = cursor.rx();
				if (v === null) return null;
				if ('special' in v) return SKIP;
				rxd = (rxd | (v.value << (8 * i))) >>> 0;
			}
			if ((~crc32v >>> 0) !== rxd) {
				this.buf = this.buf.subarray(cursor.pos);
				return SKIP;
			}
		} else {
			const hi = cursor.rx();
			const lo = cursor.rx();
			if (hi === null || lo === null) return null;
			if ('special' in hi || 'special' in lo) return SKIP;
			if (((hi.value << 8) | lo.value) !== crc16v) {
				this.buf = this.buf.subarray(cursor.pos);
				return SKIP;
			}
		}
		this.buf = this.buf.subarray(cursor.pos);
		return { header: headerFromBytes(bytes), bytes: bytes.slice(), hex: false, fcs32 };
	}

	/**
	 * Consume the next data subpacket.  Returns `null` when incomplete and
	 * `{ corrupt: true }` when the frame check fails (the bytes are consumed).
	 */
	readSubpacket(fcs32: boolean): ParsedZSubpacket | { corrupt: true } | null {
		const cursor = new Cursor(this.buf, 0, this.escapeCtrl);
		const data: number[] = [];
		let type = -1;
		for (;;) {
			const v = cursor.rx();
			if (v === null) return null;
			if ('special' in v) {
				type = v.special;
				break;
			}
			data.push(v.value);
		}

		let crc16v = 0;
		let crc32v = 0xffffffff;
		for (const b of data) {
			crc16v = crc16Update(crc16v, b);
			crc32v = crc32Update(crc32v, b);
		}
		crc16v = crc16Update(crc16v, type);
		crc32v = crc32Update(crc32v, type);

		let ok: boolean;
		if (fcs32) {
			let rxd = 0;
			for (let i = 0; i < 4; i++) {
				const v = cursor.rx();
				if (v === null) return null;
				if ('special' in v) return null;
				rxd = (rxd | (v.value << (8 * i))) >>> 0;
			}
			ok = (~crc32v >>> 0) === rxd;
		} else {
			const hi = cursor.rx();
			const lo = cursor.rx();
			if (hi === null || lo === null) return null;
			if ('special' in hi || 'special' in lo) return null;
			ok = ((hi.value << 8) | lo.value) === crc16v;
		}
		// Swallow the optional trailing XON that follows a ZCRCW.
		if (cursor.pos < this.buf.length && this.buf[cursor.pos] === 0x11) cursor.pos++;
		this.buf = this.buf.subarray(cursor.pos);
		if (!ok) return { corrupt: true };
		return { type, data: new Uint8Array(data) };
	}

	/** Drop all buffered bytes. */
	clear(): void {
		this.buf = new Uint8Array(0);
	}
}

/** Cursor implementing the `zmodem_rx()` escape rules. */
class Cursor {
	pos = 0;

	constructor(
		private readonly buf: Uint8Array,
		start = 0,
		private readonly escapeCtrl = false,
	) {
		this.pos = start;
	}

	raw(): number | null {
		if (this.pos >= this.buf.length) return null;
		return this.buf[this.pos++];
	}

	rx(): { value: number } | { special: number } | null {
		for (;;) {
			const c = this.raw();
			if (c === null) return null;
			if (FLOW.has(c)) continue;
			if (c !== ZDLE) {
				if (this.escapeCtrl && (c & 0x60) === 0) continue;
				return { value: c };
			}
			const next = this.raw();
			if (next === null) return null;
			if (FLOW.has(next) || next === ZDLE) continue;
			if (next >= ZCRCE && next <= ZCRCW) return { special: next };
			if (next === ZRUB0) return { value: 0x7f };
			if (next === ZRUB1) return { value: 0xff };
			if ((next & 0x60) === 0x40) return { value: next ^ 0x40 };
			// Illegal escape: drop it and keep scanning.
		}
	}
}

/* ------------------------------------------------------------------ */
/* ZMODEM file metadata                                                */
/* ------------------------------------------------------------------ */

export interface ZModemFileInfo {
	name: string;
	size: number;
	mtime: number;
	mode: number;
	serial: number;
	filesRemaining: number;
	bytesRemaining: number;
	/** 0-based index of this file within a batch. */
	index: number;
}

/** Build the ZFILE subpacket payload. */
export function zmodemFileInfoPayload(
	name: string,
	size: number,
	mtime: number,
	filesRemaining: number,
	bytesRemaining: number,
): Uint8Array {
	let base = name;
	const slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
	if (slash >= 0) base = base.slice(slash + 1);
	return ascii(
		`${base}\0${size} ${Math.floor(mtime).toString(8)} 0 0 ${filesRemaining} ${bytesRemaining} 0`,
	);
}

/** Parse the ZFILE subpacket payload. */
export function parseZModemFileInfo(payload: Uint8Array, index = 0): ZModemFileInfo {
	const name = asciiString(payload);
	const rest = asciiString(payload, Math.min(name.length + 1, payload.length));
	const fields = rest.trim().split(/\s+/);
	const decimal = (v: string | undefined) => {
		const n = parseInt(v ?? '0', 10);
		return Number.isFinite(n) ? n : 0;
	};
	const octal = (v: string | undefined) => {
		const n = parseInt(v ?? '0', 8);
		return Number.isFinite(n) ? n : 0;
	};
	let base = name;
	const slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
	if (slash >= 0) base = base.slice(slash + 1);
	return {
		name: base,
		size: decimal(fields[0]),
		mtime: octal(fields[1]),
		mode: octal(fields[2]),
		serial: octal(fields[3]),
		filesRemaining: decimal(fields[4]),
		bytesRemaining: decimal(fields[5]),
		index,
	};
}

/* ------------------------------------------------------------------ */
/* Receiver                                                            */
/* ------------------------------------------------------------------ */

export interface ZModemReceiverOptions extends EngineOptions {
	sink?: FileSink;
	sinkFactory?: (info: ZModemFileInfo) => FileSink;
	/**
	 * Existing bytes of the first file, for ZMODEM crash recovery.  The sink
	 * supplied for that file must already contain those bytes; the receiver
	 * asks the sender to resume at this offset (ZRPOS).
	 */
	resumeFrom?: number;
	/** Advertise ZF0_ESCCTL in ZRINIT. */
	escapeCtrl?: boolean;
	/** Disable the CANFC32 capability. */
	noFcs32?: boolean;
	noStreaming?: boolean;
}

/**
 * ZMODEM receiver.
 *
 * The constructor queues a ZRINIT, so the caller can `poll()` and send it
 * immediately (the usual "download" direction).
 */
export class ZModemReceiver extends TransferEngine {
	private readonly parser: ZFrameParser;
	private readonly sinkFactory?: (info: ZModemFileInfo) => FileSink;
	private readonly singleSink?: FileSink;
	private readonly escapeCtrl: boolean;
	private readonly noFcs32: boolean;
	private readonly initialResume: number;

	private writer: SinkWriter | null = null;
	private needSubpacket = false;
	private purpose: 'file' | 'sinit' | 'data' | null = null;
	private discarding = false;
	private fcs32 = false;
	private localPos = 0;
	private fileSize = 0;
	private fileName = '';
	private fileIndex = 0;
	private cans = 0;
	private attempts = 0;
	private fileCount = 1;

	constructor(options: ZModemReceiverOptions = {}) {
		super('zmodem', 'receive', options);
		this.sinkFactory = options.sinkFactory;
		this.singleSink = options.sink;
		this.escapeCtrl = options.escapeCtrl ?? false;
		this.noFcs32 = options.noFcs32 ?? false;
		this.parser = new ZFrameParser(this.escapeCtrl);
		this.initialResume = options.resumeFrom ?? 0;
		this.localPos = this.initialResume;
		this.updateProgress({ phase: 'handshake', fileName: '' });
		this.setState({ phase: 'handshake', waitingFor: 'ZFILE' });
		this.sendZrinit();
	}

	/** Queue a fresh ZRINIT and restart the init timeout. */
	private sendZrinit(): void {
		let f0 = ZF0.CANFDX | ZF0.CANOVIO;
		if (!this.noFcs32) f0 |= ZF0.CANFC32;
		if (this.escapeCtrl) f0 |= ZF0.ESCCTL;
		this.emit(encodeHexHeader(makeHeader(ZFrame.ZRINIT, 0, f0)));
		this.arm(10000);
	}

	receive(data: Uint8Array): void {
		if (this.done) return;
		if (this.countCans(data)) return;
		this.parser.push(data);
		this.process();
	}

	/** Await any queued sink writes. */
	get whenIdle(): Promise<void> {
		return this.writer?.idle ?? Promise.resolve();
	}

	/** Track runs of CAN; five in a row abort the session. */
	private countCans(data: Uint8Array): boolean {
		for (let i = 0; i < data.length; i++) {
			if (data[i] === 0x18) {
				if (++this.cans >= 5) {
					this.closeFile();
					this.finishAborted();
					return true;
				}
			} else {
				this.cans = 0;
			}
		}
		return this.done;
	}

	private process(): void {
		for (;;) {
			if (this.done) return;
			if (this.needSubpacket) {
				const sp = this.parser.readSubpacket(this.fcs32);
				if (sp === null) return;
				this.needSubpacket = false;
				const purpose = this.purpose;
				this.purpose = null;
				this.handleSubpacket(sp, purpose);
				continue;
			}
			const parsed = this.parser.readHeader();
			if (parsed === null) return;
			this.handleHeader(parsed);
		}
	}

	private handleHeader(parsed: ParsedZHeader): void {
		const { header } = parsed;
		this.fcs32 = parsed.fcs32;
		this.attempts = 0;
		this.arm(10000);

		switch (header.type) {
			case ZFrame.ZRQINIT:
				// We are the receiver: answer with a fresh ZRINIT.
				this.sendZrinit();
				return;
			case ZFrame.ZFILE:
				this.needSubpacket = true;
				this.purpose = 'file';
				return;
			case ZFrame.ZSINIT:
				this.needSubpacket = true;
				this.purpose = 'sinit';
				return;
			case ZFrame.ZDATA:
				this.discarding = header.pos !== this.localPos;
				this.needSubpacket = true;
				this.purpose = 'data';
				return;
			case ZFrame.ZEOF:
				if (header.pos === this.localPos) this.finishFile();
				else this.sendZrpos(this.localPos);
				return;
			case ZFrame.ZFIN:
				this.emit(encodeHexHeader(makeHeader(ZFrame.ZFIN, 0, 0)));
				this.closeFile();
				this.finish();
				return;
			case ZFrame.ZSKIP:
			case ZFrame.ZABORT:
			case ZFrame.ZFERR:
				this.emit(encodeHexHeader(makeHeader(ZFrame.ZABORT, 0, 0)));
				this.closeFile();
				this.finishAborted();
				return;
			case ZFrame.ZCAN:
				this.closeFile();
				this.finishAborted();
				return;
			default:
				return;
		}
	}

	private handleSubpacket(
		sp: ParsedZSubpacket | { corrupt: true },
		purpose: 'file' | 'sinit' | 'data' | null,
	): void {
		if ('corrupt' in sp) {
			this.discarding = false;
			this.sendZrpos(this.localPos);
			return;
		}

		if (purpose === 'sinit') {
			this.emit(encodeHexHeader(makeHeader(ZFrame.ZACK, 0, 0)));
			return;
		}

		if (purpose === 'file') {
			this.handleFileInfo(sp.data);
			return;
		}

		if (this.discarding) {
			if (sp.type === ZCRCE || sp.type === ZCRCW) {
				this.discarding = false;
				this.sendZrpos(this.localPos);
			} else {
				this.needSubpacket = true;
				this.purpose = 'data';
			}
			return;
		}

		this.writeData(sp.data);
		switch (sp.type) {
			case ZCRCG:
				this.needSubpacket = true;
				this.purpose = 'data';
				break;
			case ZCRCQ:
				this.emit(encodeHexHeader(makeHeader(ZFrame.ZACK, this.localPos, 0)));
				this.needSubpacket = true;
				this.purpose = 'data';
				break;
			case ZCRCW:
				this.emit(encodeHexHeader(makeHeader(ZFrame.ZACK, this.localPos, 0)));
				break;
			case ZCRCE:
				break;
			default:
				// Not a data subpacket; nothing to acknowledge.
				break;
		}
	}

	private handleFileInfo(payload: Uint8Array): void {
		const info = parseZModemFileInfo(payload, this.fileIndex);
		if (!info.name) {
			this.emit(encodeHexHeader(makeHeader(ZFrame.ZNAK, 0, 0)));
			return;
		}
		this.fileName = info.name;
		this.fileSize = info.size || 0;
		this.fileCount = info.filesRemaining || 1;
		this.localPos = this.fileIndex === 0 ? this.initialResume : 0;

		const sink = this.sinkFactory ? this.sinkFactory(info) : this.singleSink;
		if (!sink) {
			this.fail('no-sink', 'no file sink was supplied for the incoming file');
			return;
		}
		this.writer = new SinkWriter(sink);
		this.updateProgress({
			fileName: info.name,
			bytesTotal: this.fileSize,
			bytesTransferred: this.localPos,
			blockNumber: 0,
			fileIndex: this.fileIndex,
			fileCount: this.fileCount,
			phase: 'transfer',
		});
		this.setState({ phase: 'transfer', direction: 'receive', fileName: info.name, blockNumber: 0 });
		this.sendZrpos(this.localPos);
	}

	private writeData(data: Uint8Array): void {
		if (data.length === 0) return;
		this.writer?.write(data);
		this.localPos += data.length;
		this.addBytes(data.length);
		this.updateProgress({ bytesTransferred: this.localPos });
	}

	private sendZrpos(pos: number): void {
		this.emit(encodeHexHeader(makeHeader(ZFrame.ZRPOS, pos >>> 0, 0)));
		this.arm(10000);
	}

	private finishFile(): void {
		this.closeFile();
		this.completeFile(this.fileName);
		this.fileIndex++;
		this.setPhase('handshake');
		this.setState({ phase: 'handshake', waitingFor: 'next ZFILE' });
		this.sendZrinit();
	}

	private closeFile(): void {
		if (!this.writer) return;
		this.writer.close();
		this.writer = null;
	}

	protected override onTimeout(): void {
		if (this.done) return;
		this.attempts++;
		if (this.attempts > this.maxErrors) {
			this.closeFile();
			this.emit(encodeHexHeader(makeHeader(ZFrame.ZABORT, 0, 0)));
			this.fail('timeout', 'timed out waiting for the sender');
			return;
		}
		if (this.writer) this.sendZrpos(this.localPos);
		else this.sendZrinit();
	}

	protected override doAbort(): void {
		this.emit(encodeHexHeader(makeHeader(ZFrame.ZABORT, 0, 0)));
		this.closeFile();
		this.finishAborted();
	}
}

/* ------------------------------------------------------------------ */
/* Sender                                                              */
/* ------------------------------------------------------------------ */

export interface ZModemSenderOptions extends EngineOptions {
	files: TransferFile[];
	/** Send ZRQINIT first (the usual upload direction). */
	requestInit?: boolean;
	escapeCtrl?: boolean;
	escapeTelnetIac?: boolean;
	/** Refuse 32-bit frame checks even if the receiver offers them. */
	noFcs32?: boolean;
	blockSize?: number;
	onSkip?: (name: string) => void;
}

/**
 * ZMODEM sender.
 *
 * Streaming is cooperative: `receive()` records the peer's headers and
 * `pump()` emits everything the current state allows.  Awaiting a later
 * `pump()` also waits for an earlier one still reading from the source.
 */
export class ZModemSender extends TransferEngine {
	private readonly files: TransferFile[];
	private readonly requestInit: boolean;
	private readonly escapeTelnetIac: boolean;
	private readonly allowFcs32: boolean;
	private readonly blockSize: number;
	private readonly onSkip?: (name: string) => void;

	private readonly parser = new ZFrameParser();
	private phase: 'init' | 'file' | 'data' | 'eof' | 'finish' | 'done' = 'init';
	private awaiting: 'init' | 'zrinit' | 'zrpos' | 'zack' | 'eof' | 'zfin' | null = null;
	private initSent = false;
	private initAttempts = 0;
	private fileIndex = 0;
	private carry: Uint8Array = new Uint8Array(0);
	private currentPos = 0;
	private sentSubpackets = 0;
	private frameOpen = false;
	private pending: { data: Uint8Array; size: number } | null = null;
	private lastBlock: { data: Uint8Array; size: number; start: number } | null = null;
	private forceCrcw = true;
	private pumping: Promise<void> = Promise.resolve();

	private canFcs32 = false;
	private peerEscapeCtrl = false;
	private useFcs32 = false;

	constructor(options: ZModemSenderOptions) {
		super('zmodem', 'send', options);
		this.files = options.files;
		this.requestInit = options.requestInit ?? false;
		this.escapeTelnetIac = options.escapeTelnetIac ?? false;
		this.peerEscapeCtrl = options.escapeCtrl ?? false;
		this.allowFcs32 = !options.noFcs32;
		this.blockSize = Math.max(128, options.blockSize ?? 1024);
		this.onSkip = options.onSkip;
		this.updateProgress({
			fileName: this.files[0]?.name ?? '',
			bytesTotal: this.files[0]?.size ?? 0,
			fileCount: this.files.length,
			phase: 'handshake',
		});
		this.setState({ phase: 'handshake', waitingFor: 'ZRINIT' });
		this.arm(10000);
	}

	receive(data: Uint8Array): void {
		if (this.done) return;
		this.parser.push(data);
		for (;;) {
			const parsed = this.parser.readHeader();
			if (parsed === null) break;
			this.handleHeader(parsed.header);
			if (this.done) return;
		}
	}

	private get escapeOptions(): { escapeCtrl: boolean; escapeTelnetIac: boolean } {
		return { escapeCtrl: this.peerEscapeCtrl, escapeTelnetIac: this.escapeTelnetIac };
	}

	private handleHeader(header: ZHeader): void {
		switch (header.type) {
			case ZFrame.ZRINIT:
				this.canFcs32 = (header.f0 & ZF0.CANFC32) !== 0;
				this.peerEscapeCtrl = this.peerEscapeCtrl || (header.f0 & ZF0.ESCCTL) !== 0;
				this.useFcs32 = this.allowFcs32 && this.canFcs32;
				this.attemptsReset();
				if (this.phase === 'init') {
					this.phase = 'file';
					this.awaiting = null;
					this.setPhase('transfer');
				} else if (this.phase === 'eof') {
					// Receiver acknowledged EOF and is ready for the next file.
					this.finishFile();
				}
				return;
			case ZFrame.ZRPOS:
				this.attemptsReset();
				this.currentPos = header.pos;
				this.phase = 'data';
				this.awaiting = null;
				this.frameOpen = false;
				this.forceCrcw = true;
				this.sentSubpackets = 0;
				this.pending = null;
				this.lastBlock = null;
				this.updateProgress({ bytesTransferred: this.currentPos });
				return;
			case ZFrame.ZACK:
				if (this.awaiting === 'zack' && header.pos === this.currentPos) {
					this.awaiting = null;
					this.lastBlock = null;
					this.attemptsReset();
				}
				return;
			case ZFrame.ZSKIP:
				this.onSkip?.(this.files[this.fileIndex]?.name ?? '');
				this.phase = 'eof';
				this.awaiting = null;
				return;
			case ZFrame.ZFIN:
				if (this.awaiting === 'zfin') {
					this.emit(ascii('OO'), ascii('OO'));
					this.finish();
				} else {
					this.emit(encodeHexHeader(makeHeader(ZFrame.ZFIN, 0, 0)), ascii('OO'), ascii('OO'));
					this.finish();
				}
				return;
			case ZFrame.ZABORT:
			case ZFrame.ZFERR:
				this.emit(encodeHexHeader(makeHeader(ZFrame.ZABORT, 0, 0)));
				this.finishAborted();
				return;
			default:
				return;
		}
	}

	private attemptsReset(): void {
		this.initAttempts = 0;
	}

	pump(): Promise<void> {
		this.pumping = this.pumping.then(() => this.pumpInternal());
		return this.pumping;
	}

	private async pumpInternal(): Promise<void> {
		if (this.done) return;
		for (;;) {
			if (this.awaiting !== null) return;
			switch (this.phase) {
				case 'init': {
					if (this.requestInit && !this.initSent) {
						this.emit(encodeHexHeader(makeHeader(ZFrame.ZRQINIT, 0, 0)));
						this.initSent = true;
						this.awaiting = 'zrinit';
						this.arm(10000);
						return;
					}
					this.awaiting = 'zrinit';
					this.arm(10000);
					return;
				}
				case 'file': {
					const file = this.files[this.fileIndex];
					if (!file) {
						this.phase = 'finish';
						continue;
					}
					if (this.fileIndex === 0) this.currentPos = 0;
					this.emitFileHeader(file);
					this.awaiting = 'zrpos';
					this.arm(10000);
					return;
				}
				case 'data': {
					if (this.forceCrcw && !this.frameOpen) {
						if (!this.seekTo(this.currentPos)) return;
						this.forceCrcw = false;
						this.sentSubpackets = 0;
					}
					if (this.pending === null) {
						const block = await this.readBlock();
						if (block === null) {
							if (this.frameOpen) {
								// Exact multiple of the block size: close the frame.
								this.emitData(ZCRCE, new Uint8Array(0));
								this.frameOpen = false;
							}
							this.sendZeof();
							return;
						}
						this.pending = block;
					}
					const { data, size } = this.pending;
					let type: number;
					if (this.sentSubpackets === 0 || size < this.blockSize) {
						type = size < this.blockSize ? ZCRCE : ZCRCW;
					} else {
						type = ZCRCG;
					}
					if (!this.frameOpen) {
						this.emit(
							encodeBinaryHeader(
								makeHeader(ZFrame.ZDATA, this.currentPos, 0),
								this.useFcs32,
								this.escapeOptions,
							),
						);
						this.frameOpen = true;
					}
					const start = this.currentPos;
					this.emitData(type, data);
					this.currentPos += size;
					this.sentSubpackets++;
					this.updateProgress({ bytesTransferred: this.currentPos, blockNumber: this.sentSubpackets });
					this.lastBlock = { data, size, start };
					this.pending = null;
					if (type === ZCRCW) {
						this.frameOpen = false;
						this.awaiting = 'zack';
						this.arm(10000);
						return;
					}
					if (type === ZCRCE) {
						this.frameOpen = false;
						this.phase = 'eof';
						continue;
					}
					continue;
				}
				case 'eof': {
					this.sendZeof();
					return;
				}
				case 'finish': {
					this.emit(encodeHexHeader(makeHeader(ZFrame.ZFIN, 0, 0)));
					this.awaiting = 'zfin';
					this.arm(10000);
					return;
				}
				case 'done':
					return;
			}
		}
	}

	private emitData(type: number, data: Uint8Array): void {
		this.emit(encodeDataSubpacket(type, data, this.useFcs32, this.escapeOptions));
	}

	private emitFileHeader(file: TransferFile): void {
		const header = makeHeader(ZFrame.ZFILE, 0, ZCBIN, ZF1.ZMCRC);
		this.emit(encodeBinaryHeader(header, this.useFcs32, this.escapeOptions));
		let bytesRemaining = 0;
		for (let i = this.fileIndex; i < this.files.length; i++) bytesRemaining += this.files[i].size;
		const payload = zmodemFileInfoPayload(
			file.name,
			file.size,
			file.mtime ?? 0,
			this.files.length - this.fileIndex,
			bytesRemaining,
		);
		this.emit(encodeDataSubpacket(ZCRCW, payload, this.useFcs32, this.escapeOptions));
		this.updateProgress({
			fileName: file.name,
			bytesTotal: file.size,
			bytesTransferred: 0,
			blockNumber: 0,
			fileIndex: this.fileIndex,
			fileCount: this.files.length,
			phase: 'transfer',
		});
	}

	private sendZeof(): void {
		this.emit(encodeHexHeader(makeHeader(ZFrame.ZEOF, this.currentPos >>> 0, 0)));
		this.phase = 'eof';
		this.awaiting = 'eof';
		this.arm(10000);
	}

	private finishFile(): void {
		this.completeFile(this.progress.fileName);
		this.fileIndex++;
		this.carry = new Uint8Array(0);
		this.pending = null;
		this.lastBlock = null;
		this.frameOpen = false;
		this.sentSubpackets = 0;
		this.currentPos = 0;
		if (this.fileIndex >= this.files.length) {
			this.phase = 'finish';
			this.awaiting = null;
			return;
		}
		this.phase = 'file';
		this.awaiting = null;
	}

	private seekTo(pos: number): boolean {
		const file = this.files[this.fileIndex];
		if (!file) return false;
		if (pos === 0) {
			file.source.seek?.(0);
			this.carry = new Uint8Array(0);
			return true;
		}
		if (!file.source.seek) {
			this.fail('seek', 'the file source cannot seek for ZMODEM resume');
			return false;
		}
		file.source.seek(pos);
		this.carry = new Uint8Array(0);
		return true;
	}

	private async readBlock(): Promise<{ data: Uint8Array; size: number } | null> {
		const file = this.files[this.fileIndex];
		if (!file) return null;
		while (this.carry.length < this.blockSize) {
			const chunk = await file.source.read();
			if (chunk === null) break;
			this.carry = concatBytes([this.carry, chunk]);
		}
		if (this.carry.length === 0) return null;
		const size = Math.min(this.blockSize, this.carry.length);
		const data = this.carry.slice(0, size);
		this.carry = this.carry.slice(size);
		return { data, size };
	}

	protected override onTimeout(): void {
		if (this.done) return;
		switch (this.awaiting) {
			case 'init':
			case 'zrinit':
				if (this.requestInit && ++this.initAttempts <= this.maxErrors) {
					this.initSent = false;
					this.phase = 'init';
					this.awaiting = null;
					void this.pump();
					return;
				}
				this.fail('timeout', 'timed out waiting for ZRINIT');
				return;
			case 'zrpos':
				// Re-send the ZFILE header.
				this.phase = 'file';
				this.awaiting = null;
				void this.pump();
				return;
			case 'zack':
				// The last ZCRCW was not acknowledged: rewind and retry it.
				if (this.lastBlock) {
					this.currentPos = this.lastBlock.start;
					this.pending = this.lastBlock.data.length
						? { data: this.lastBlock.data, size: this.lastBlock.size }
						: null;
					this.lastBlock = null;
				}
				this.frameOpen = false;
				this.phase = 'data';
				this.awaiting = null;
				void this.pump();
				return;
			case 'eof':
				this.awaiting = null;
				this.sendZeof();
				return;
			case 'zfin':
				this.emit(encodeHexHeader(makeHeader(ZFrame.ZFIN, 0, 0)));
				this.arm(10000);
				return;
			default:
				return;
		}
	}

	protected override doAbort(): void {
		this.emit(encodeHexHeader(makeHeader(ZFrame.ZABORT, 0, 0)));
		this.finishAborted();
	}
}
