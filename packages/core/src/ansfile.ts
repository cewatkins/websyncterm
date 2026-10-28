/**
 * ANSI file (`.ANS`) support.
 *
 * An `.ANS` file is simply a recording of the byte stream that produced a
 * screen, optionally followed by a SAUCE metadata record. Replaying the bytes
 * into the terminal reproduces the screen exactly.
 *
 * The SAUCE record is 128 bytes at the end of the file:
 *
 *   "SAUCE00" (7) + version (2) + title (35) + author (20) + group (20)
 *   + date (8) + filesize (4) + datatype (1) + datatype2 (1)
 *   + tinfo1..tinfo4 (8) + comments (1) + tflags (1) + tinfos (22)
 *
 * Optionally a COMNT block follows, terminated by a 0x1A EOF byte.
 */

/** The SAUCE metadata. */
export interface Sauce {
	version: string;
	title: string;
	author: string;
	group: string;
	date: string;
	fileSize: number;
	dataType: number;
	dataType2: number;
	tinfo1: number;
	tinfo2: number;
	tinfo3: number;
	tinfo4: number;
	comments: number;
	tflags: number;
	tinfos: string;
	/** The raw comment text, when a COMNT block is present. */
	comment?: string;
}

/** The ANSI data types. */
export const SAUCE_DATA_TYPE = {
	None: 0,
	Character: 1,
	Bitmap: 2,
	Vector: 3,
	Audio: 4,
	BinaryText: 5,
	XBin: 6,
	Archive: 7,
	Executable: 8,
} as const;

const SAUCE_SIZE = 128;
const SAUCE_ID = 'SAUCE00';

/**
 * Parse the SAUCE record from the end of a file.
 *
 * Returns `null` when the file has no SAUCE record.
 */
export function parseSauce(data: Uint8Array): Sauce | null {
	if (data.length < SAUCE_SIZE) return null;
	const start = data.length - SAUCE_SIZE;
	let id = '';
	for (let i = 0; i < 7; i++) id += String.fromCharCode(data[start + i]);
	if (id !== SAUCE_ID) return null;

	const text = (offset: number, length: number): string => {
		let out = '';
		for (let i = 0; i < length; i++) {
			const c = data[start + offset + i];
			if (c === 0) break;
			out += String.fromCharCode(c);
		}
		return out.trim();
	};
	const u16 = (offset: number): number => data[start + offset] | (data[start + offset + 1] << 8);
	const u32 = (offset: number): number =>
		(data[start + offset] |
			(data[start + offset + 1] << 8) |
			(data[start + offset + 2] << 16) |
			(data[start + offset + 3] << 24)) >>>
		0;

	const sauce: Sauce = {
		version: text(7, 2),
		title: text(9, 35),
		author: text(44, 20),
		group: text(64, 20),
		date: text(84, 8),
		fileSize: u32(92),
		dataType: data[start + 96],
		dataType2: data[start + 97],
		tinfo1: u16(98),
		tinfo2: u16(100),
		tinfo3: u16(102),
		tinfo4: u16(104),
		comments: data[start + 106],
		tflags: data[start + 107],
		tinfos: text(108, 22),
	};

	// The COMNT block sits before the SAUCE record.
	if (sauce.comments > 0) {
		const commentStart = start - sauce.comments * 64;
		if (commentStart >= 0) {
			let comment = '';
			for (let i = commentStart; i < start; i++) {
				const c = data[i];
				if (c === 0x1a) break;
				comment += String.fromCharCode(c);
			}
			sauce.comment = comment.replace(/[\r\n]+/g, '\n').trim();
		}
	}
	return sauce;
}

/**
 * Strip the SAUCE record (and the COMNT block) from a file.
 */
export function stripSauce(data: Uint8Array): Uint8Array {
	const sauce = parseSauce(data);
	if (!sauce) return data;
	let end = data.length - SAUCE_SIZE;
	if (sauce.comments > 0) {
		const commentStart = end - sauce.comments * 64;
		if (commentStart >= 0) {
			// Skip back over the 0x1A EOF byte if present.
			let start = commentStart;
			while (start > 0 && data[start - 1] !== 0x1a) start--;
			end = start > 0 ? start - 1 : commentStart;
		}
	}
	return data.subarray(0, end);
}

/**
 * Build a SAUCE record.
 */
export function buildSauce(sauce: Partial<Sauce>): Uint8Array {
	const out = new Uint8Array(SAUCE_SIZE);
	const enc = new TextEncoder();
	const write = (offset: number, text: string, length: number): void => {
		const bytes = enc.encode(text.slice(0, length));
		out.set(bytes.subarray(0, length), offset);
	};
	write(0, SAUCE_ID, 7);
	write(7, sauce.version ?? '00', 2);
	write(9, sauce.title ?? '', 35);
	write(44, sauce.author ?? '', 20);
	write(64, sauce.group ?? '', 20);
	write(84, sauce.date ?? '', 8);
	const fileSize = sauce.fileSize ?? 0;
	out[92] = fileSize & 0xff;
	out[93] = (fileSize >> 8) & 0xff;
	out[94] = (fileSize >> 16) & 0xff;
	out[95] = (fileSize >> 24) & 0xff;
	out[96] = sauce.dataType ?? SAUCE_DATA_TYPE.Character;
	out[97] = sauce.dataType2 ?? 1;
	const t1 = sauce.tinfo1 ?? 80;
	const t2 = sauce.tinfo2 ?? 25;
	out[98] = t1 & 0xff;
	out[99] = (t1 >> 8) & 0xff;
	out[100] = t2 & 0xff;
	out[101] = (t2 >> 8) & 0xff;
	out[106] = sauce.comments ?? 0;
	out[107] = sauce.tflags ?? 0;
	write(108, sauce.tinfos ?? '', 22);
	return out;
}

/**
 * Append a SAUCE record to an ANSI file.
 */
export function withSauce(ansi: Uint8Array, sauce: Partial<Sauce>): Uint8Array {
	const record = buildSauce({ ...sauce, fileSize: ansi.length });
	const out = new Uint8Array(ansi.length + record.length);
	out.set(ansi, 0);
	out.set(record, ansi.length);
	return out;
}
