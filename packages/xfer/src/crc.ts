/**
 * CRC helpers.
 *
 * `crc16` is CRC-16/XMODEM (poly 0x1021, init 0, no reflection, no final xor)
 * exactly as Synchronet's `ucrc16()`.  ZMODEM carries it big-endian;
 * XMODEM carries it big-endian too.
 *
 * `crc32Update`/`crc32` are the reflected IEEE 802.3 CRC used by ZMODEM's
 * 32-bit frame check: init 0xFFFFFFFF, final complement, transmitted
 * little-endian.
 */

/** Update a running CRC-16/XMODEM value with one byte. */
export function crc16Update(crc: number, byte: number): number {
	crc &= 0xffff;
	crc ^= (byte & 0xff) << 8;
	for (let bit = 0; bit < 8; bit++) {
		crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
	}
	return crc;
}

/** CRC-16/XMODEM of a byte string. */
export function crc16(data: Uint8Array, initial = 0): number {
	let crc = initial & 0xffff;
	for (let i = 0; i < data.length; i++) crc = crc16Update(crc, data[i]);
	return crc;
}

/** Update a running reflected CRC-32 (no final complement). */
export function crc32Update(crc: number, byte: number): number {
	crc = (crc ^ (byte & 0xff)) >>> 0;
	for (let bit = 0; bit < 8; bit++) {
		crc = crc & 1 ? ((crc >>> 1) ^ 0xedb88320) >>> 0 : (crc >>> 1) >>> 0;
	}
	return crc >>> 0;
}

/** Update a running reflected CRC-32 with a whole buffer. */
export function crc32UpdateBytes(crc: number, data: Uint8Array): number {
	let c = crc >>> 0;
	for (let i = 0; i < data.length; i++) c = crc32Update(c, data[i]);
	return c >>> 0;
}

/** Reflected CRC-32 (zlib compatible) of a byte string. */
export function crc32(data: Uint8Array, initial = 0xffffffff): number {
	return ~crc32UpdateBytes(initial >>> 0, data) >>> 0;
}
