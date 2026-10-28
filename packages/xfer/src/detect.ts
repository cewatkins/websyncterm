/**
 * Transfer auto-detection, mirroring `feed_zmodem_detect()` in SyncTERM's
 * `term.c` plus the two-identical-bytes rule for the X/YMODEM variants.
 *
 * A remote-initiated ZMODEM download begins with the first four bytes of a
 * hex ZRQINIT header (`ZDLE ZHEX '0' '0'`); an upload begins with the first
 * four bytes of ZRINIT (`ZDLE ZHEX '0' '1'`).  Only the prefix is matched —
 * the rest of the header (and its CRC) is not consulted.
 */

import { ZDLE, ZHEX } from './zmodem.js';

/** What the detector recognised. */
export type DetectedTransfer =
	| 'zmodem-download'
	| 'zmodem-upload'
	| 'xmodem-crc'
	| 'xmodem-chksum'
	| 'ymodem-g';

const DOWNLOAD_PREFIX = Uint8Array.of(ZDLE, ZHEX, 0x30, 0x30);
const UPLOAD_PREFIX = Uint8Array.of(ZDLE, ZHEX, 0x30, 0x31);

/**
 * Match the 4-byte ZMODEM prefix at the start of `bytes`.
 *
 * Returns `null` when `bytes` is shorter than the prefix or does not match.
 */
export function detectTransfer(bytes: Uint8Array): 'zmodem-download' | 'zmodem-upload' | null {
	if (bytes.length < 4) return null;
	for (let i = 0; i < 4; i++) {
		if (bytes[i] !== DOWNLOAD_PREFIX[i] && bytes[i] !== UPLOAD_PREFIX[i]) return null;
	}
	return bytes[3] === 0x31 ? 'zmodem-upload' : 'zmodem-download';
}

/**
 * Match an X/YMODEM mode request: two identical consecutive `NAK`, `C` or `G`
 * bytes.  Requires at least two bytes.
 */
export function detectXModem(bytes: Uint8Array): 'xmodem-crc' | 'xmodem-chksum' | 'ymodem-g' | null {
	if (bytes.length < 2) return null;
	const last = bytes[bytes.length - 1];
	if (last !== bytes[bytes.length - 2]) return null;
	if (last === 0x43) return 'xmodem-crc';
	if (last === 0x15) return 'xmodem-chksum';
	if (last === 0x47) return 'ymodem-g';
	return null;
}

/**
 * Streaming detector.  Feed it one byte at a time (or use `pushBytes`);
 * it returns the recognised transfer as soon as a prefix completes.
 *
 * Every byte fed before detection is retained in {@link bytes} so the caller
 * can replay it into the protocol engine without losing the handshake.
 */
export class TransferDetector {
	private zmodemIndex = 0;
	private last: number | null = null;
	private detected: DetectedTransfer | null = null;
	private buffered: number[] = [];

	/** Bytes seen so far (including the detected prefix). */
	get bytes(): Uint8Array {
		return new Uint8Array(this.buffered);
	}

	/** The detection result, or `null`. */
	get result(): DetectedTransfer | null {
		return this.detected;
	}

	/** Feed one byte.  Returns the detected transfer on the completing byte. */
	push(byte: number): DetectedTransfer | null {
		if (this.detected) return null;
		this.buffered.push(byte);

		// ZMODEM prefix: either pattern may match at each index.
		if (byte === DOWNLOAD_PREFIX[this.zmodemIndex] || byte === UPLOAD_PREFIX[this.zmodemIndex]) {
			this.zmodemIndex++;
			if (this.zmodemIndex === 4) {
				this.detected = byte === 0x31 ? 'zmodem-upload' : 'zmodem-download';
				return this.detected;
			}
		} else {
			this.zmodemIndex = 0;
		}

		// X/YMODEM: two identical request bytes in a row.
		if (this.last !== null && this.last === byte) {
			if (byte === 0x43) return (this.detected = 'xmodem-crc');
			if (byte === 0x15) return (this.detected = 'xmodem-chksum');
			if (byte === 0x47) return (this.detected = 'ymodem-g');
		}
		this.last = byte;
		return null;
	}

	/** Feed a chunk.  Returns the detection when it happens within the chunk. */
	pushBytes(data: Uint8Array): DetectedTransfer | null {
		for (let i = 0; i < data.length; i++) {
			const found = this.push(data[i]);
			if (found) return found;
		}
		return null;
	}

	reset(): void {
		this.zmodemIndex = 0;
		this.last = null;
		this.detected = null;
		this.buffered = [];
	}
}
