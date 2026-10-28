// MegaNum parsing and RIPscrip command argument descriptors.
//
// RIPscrip arguments are fixed-width base-36 numbers with no separators.
// The BGI/RIPterm parser accepts 0-9, A-Z and a-z, treats '-' as digit 0,
// and terminates a field early on '|' or NUL after at least one digit.
// A '-' is intentionally *not* a minus sign.

export const BASE36_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Parse one MegaNum field.
 *
 * Returns the value, or -1 if the field is malformed.  As in RIPterm the
 * field is read for at most `width` characters; a '|' or NUL after the
 * first character ends it early.
 */
export function parseMegaNum(text: string, width: number): number {
	let ret = 0;
	for (let i = 0; i < width; i++) {
		const c = i < text.length ? text.charCodeAt(i) : 0;
		if (c >= 0x30 && c <= 0x39) {
			ret = ret * 36 + (c - 0x30);
		}
		else if (c >= 0x41 && c <= 0x5a) {
			ret = ret * 36 + (c - 0x41 + 10);
		}
		else if (c >= 0x61 && c <= 0x7a) {
			ret = ret * 36 + (c - 0x61 + 10);
		}
		else if (c === 0x2d) { // '-'
			ret = ret * 36;
		}
		else if (i > 0 && (c === 0x7c || c === 0)) {
			break;
		}
		else {
			return -1;
		}
	}
	return ret;
}

/**
 * Parse one MegaNum field and report how many characters it consumed.
 * Returns null on a malformed field.
 */
export function parseMegaNumAt(
	text: string,
	offset: number,
	width: number,
): { value: number; consumed: number } | null {
	let ret = 0;
	let i = 0;
	for (; i < width; i++) {
		const c = offset + i < text.length ? text.charCodeAt(offset + i) : 0;
		if (c >= 0x30 && c <= 0x39) {
			ret = ret * 36 + (c - 0x30);
		}
		else if (c >= 0x41 && c <= 0x5a) {
			ret = ret * 36 + (c - 0x41 + 10);
		}
		else if (c >= 0x61 && c <= 0x7a) {
			ret = ret * 36 + (c - 0x61 + 10);
		}
		else if (c === 0x2d) {
			ret = ret * 36;
		}
		else if (i > 0 && (c === 0x7c || c === 0)) {
			break;
		}
		else {
			return null;
		}
	}
	return { value: ret, consumed: i };
}

export interface ParsedRipArgs {
	values: number[];
	/** Freeform text (only for descriptors containing '++'). */
	text: string | null;
	/** Offset in the argument string where text begins, or -1. */
	textStart: number;
	hasText: boolean;
}

const MAX_PARSED = 1025;

/**
 * Parse an argument string using a BGI-style descriptor:
 *   N#   fixed-width base-36 field
 *   +N#  variable-length list of N-digit fields, to the end
 *   ++   freeform text follows (rest of the argument string)
 *
 * Returns null if the arguments do not match the descriptor, matching the
 * upstream parser's all-or-nothing behaviour.
 */
export function parseRipArgs(
	args: string,
	desc: string | null,
): ParsedRipArgs | null {
	if (desc === null) {
		return { values: [], text: null, textStart: -1, hasText: false };
	}

	const values: number[] = [];
	let offset = 0;
	let textStart = -1;
	let hasText = false;
	let d = 0;

	while (d < desc.length) {
		if (desc[d] === '+') {
			d++;
			if (desc[d] === '+') {
				d++;
				textStart = offset;
				hasText = true;
				return {
					values,
					text: offset < args.length ? args.slice(offset) : ' ',
					textStart,
					hasText,
				};
			}
			// +N# — variable-length list
			const widthChar = desc[d];
			if (widthChar === undefined || widthChar < '1' || widthChar > '9')
				return null;
			const width = widthChar.charCodeAt(0) - 0x30;
			d++;
			if (desc[d] !== '#')
				return null;
			d++;
			while (offset < args.length) {
				if (values.length >= MAX_PARSED)
					break;
				const got = parseMegaNumAt(args, offset, width);
				if (got === null || got.consumed === 0)
					break;
				values.push(got.value);
				offset += got.consumed;
			}
			// BGI rejects the whole command if anything is left over.
			if (offset < args.length)
				return null;
			continue;
		}
		const widthChar = desc[d];
		if (widthChar === undefined || widthChar < '1' || widthChar > '9')
			return null;
		const width = widthChar.charCodeAt(0) - 0x30;
		d++;
		if (desc[d] !== '#')
			return null;
		d++;

		if (values.length >= MAX_PARSED)
			return null;
		const got = parseMegaNumAt(args, offset, width);
		if (got === null)
			return null;
		values.push(got.value);
		offset += got.consumed;
	}

	return { values, text: null, textStart: offset, hasText };
}

/**
 * Command descriptor table, keyed by `${level}:${command}`.
 *
 * Note: upstream spells the line-style command `!|=`.  The WebSyncTERM
 * specification (and the RIPscrip documentation users actually have)
 * calls it `!|$`, so both are accepted here.
 */
const DESCRIPTORS: ReadonlyMap<string, string> = new Map<string, string>([
	['0:H', ''], ['0:>', ''], ['0:E', ''], ['0:e', ''],
	['0:c', '2#'], ['0:b', '2#2#2#2#2#2#1#4#'], ['0:m', '2#2#'],
	['0:g', '2#2#'], ['0:T', '++'], ['0:Y', '2#2#2#1#1#'],
	['0:y', '2#2#2#2#'], ['0:w', '2#2#2#2#1#1#'], ['0:v', '2#2#2#2#'],
	['0:L', '2#2#2#2#'], ['0:R', '2#2#2#2#'], ['0:C', '2#2#2#'],
	['0:A', '2#2#2#2#2#'], ['0:O', '2#2#2#2#2#2#'],
	['0:P', '2#2#2#+2#'], ['0:B', '2#2#2#2#'], ['0:F', '2#2#2#'],
	['0:W', '1#'], ['0:o', '2#2#2#2#'], ['0:S', '2#2#'],
	['0:s', '2#2#2#2#2#2#2#2#2#'], ['0:p', '2#2#2#+2#'],
	['0:D', '2#2#2#2#2#2#'], ['0:X', '2#2#'],
	['0:Q', '2#2#2#2#2#2#2#2#2#2#2#2#2#2#2#2#'],
	['0:@', '2#2#++'],
	['1:A', '2#2#2#2#2#2#2#'], ['1:O', '2#2#2#2#'],
	['1:I', '2#2#2#1#1#1#++'], ['1:M', '2#2#2#2#2#1#1#4#1#'],
	['1:N', '2#2#5#5#+5#'], ['1:S', '4#4#'], ['1:C', '2#2#2#2#1#'],
	['1:P', '2#2#2#1#'], ['1:W', '1#++'], ['1:K', ''], ['1:T', '2#2#2#2#1#1#'],
	['1:E', ''], ['1:t', '1#++'], ['0:*', ''], ['0:#', ''], ['0:x', ''],
	['1:B', '2#2#2#4#2#2#2#2#2#2#2#2#2#2#6#'],
	['0:Z', '2#2#2#2#2#2#2#2#2#'], ['0:V', '2#2#2#2#2#2#'],
	['0:I', '2#2#2#2#2#'], ['0:i', '2#2#2#2#2#2#'],
	['1:U', '2#2#2#2#2#1#1#++'], ['1:D', '3#2#++'],
	['1:\x1b', '1#3#++'], ['1:G', '2#2#2#2#2#2#'],
	['1:R', '2#2#2#2#++'], ['1:F', '2#4#++'], ['0:a', '2#2#'],
	['9:\x1b', ''], ['0:\x1b', ''], ['0:l', '2#2#2#+2#'], ['0:t', ''],
	['0:N', '2#'], ['0:f', '2#2#'], ['0:j', '2#2#'], ['0:K', '2#2#2#2#'],
]);

/** Line-style descriptor (`!|$` / `!|=`). */
const LINE_STYLE_DESC = '2#4#2#';

/** Look up the descriptor for a (level, command) pair, or null. */
export function findDescriptor(level: number, cmd: number): string | null {
	const ch = String.fromCharCode(cmd);
	if (level === 0 && (ch === '$' || ch === '='))
		return LINE_STYLE_DESC;
	const found = DESCRIPTORS.get(`${level}:${ch}`);
	return found === undefined ? null : found;
}
