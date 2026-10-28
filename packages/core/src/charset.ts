/**
 * Character set translation tables.
 *
 * SyncTERM renders the raw byte from the wire through the current code page
 * (`enum ciolib_codepage` in src/conio/ciolib.h) to produce a glyph index for the
 * bitmap font. In the browser we keep the raw byte for font lookup and separately
 * provide the Unicode code point for clipboard/copy and for accessibility.
 */

/** Code pages understood by the engine (mirrors `enum ciolib_codepage`). */
export const Codepage = {
	CP437: 'CP437',
	CP1251: 'CP1251',
	KOI8_R: 'KOI8-R',
	ISO_8859_2: 'ISO-8859-2',
	ISO_8859_4: 'ISO-8859-4',
	CP866M: 'CP866',
	ISO_8859_9: 'ISO-8859-9',
	HAIK8: 'HAIK8',
	ISO_8859_8: 'ISO-8859-8',
	CP866U: 'CP866U',
	ISO_8859_15: 'ISO-8859-15',
	ISO_8859_5: 'ISO-8859-5',
	ARMSCII8: 'ARMSCII-8',
	CP850: 'CP850',
	CP865: 'CP865',
	ISO_8859_7: 'ISO-8859-7',
	CP866M2: 'CP866 (b)',
	CP1131: 'CP1131',
	PETSCIIU: 'PETSCII (UPPER)',
	PETSCIIL: 'PETSCII (Lower)',
	ATASCII: 'ATASCII',
	PRESTEL: 'Prestel',
	ATARIST: 'Atari ST',
} as const;

export type CodepageName = (typeof Codepage)[keyof typeof Codepage];

/**
 * CP437 to Unicode.
 *
 * Bytes 0x00-0x7f are ASCII; 0x80-0xff map to the classic IBM PC graphics set.
 */
export const CP437_TO_UNICODE: readonly number[] = (() => {
	const table = new Array<number>(256);
	for (let i = 0; i < 256; i++) table[i] = i;
	const set = (index: number, code: number): void => {
		table[index] = code;
	};
	// Control pictures and symbols
	set(0x00, 0x0000); set(0x01, 0x263a); set(0x02, 0x263b); set(0x03, 0x2665);
	set(0x04, 0x2666); set(0x05, 0x2663); set(0x06, 0x2660); set(0x07, 0x2022);
	set(0x08, 0x25d8); set(0x09, 0x25cb); set(0x0a, 0x25d9); set(0x0b, 0x2642);
	set(0x0c, 0x2640); set(0x0d, 0x266a); set(0x0e, 0x266b); set(0x0f, 0x263c);
	set(0x10, 0x25ba); set(0x11, 0x25c4); set(0x12, 0x2195); set(0x13, 0x203c);
	set(0x14, 0x00b6); set(0x15, 0x00a7); set(0x16, 0x25ac); set(0x17, 0x21a8);
	set(0x18, 0x2191); set(0x19, 0x2193); set(0x1a, 0x2192); set(0x1b, 0x2190);
	set(0x1c, 0x221f); set(0x1d, 0x2194); set(0x1e, 0x25b2); set(0x1f, 0x25bc);
	// 0x20-0x7e are ASCII
	set(0x7f, 0x2302); // house
	// High half
	set(0x80, 0x00c7); set(0x81, 0x00fc); set(0x82, 0x00e9); set(0x83, 0x00e2);
	set(0x84, 0x00e4); set(0x85, 0x00e0); set(0x86, 0x00e5); set(0x87, 0x00e7);
	set(0x88, 0x00ea); set(0x89, 0x00eb); set(0x8a, 0x00e8); set(0x8b, 0x00ef);
	set(0x8c, 0x00ee); set(0x8d, 0x00ec); set(0x8e, 0x00c4); set(0x8f, 0x00c5);
	set(0x90, 0x00c9); set(0x91, 0x00e6); set(0x92, 0x00c6); set(0x93, 0x00f4);
	set(0x94, 0x00f6); set(0x95, 0x00f2); set(0x96, 0x00fb); set(0x97, 0x00f9);
	set(0x98, 0x00ff); set(0x99, 0x00d6); set(0x9a, 0x00dc); set(0x9b, 0x00a2);
	set(0x9c, 0x00a3); set(0x9d, 0x00a5); set(0x9e, 0x20a7); set(0x9f, 0x0192);
	set(0xa0, 0x00e1); set(0xa1, 0x00ed); set(0xa2, 0x00f3); set(0xa3, 0x00fa);
	set(0xa4, 0x00f1); set(0xa5, 0x00d1); set(0xa6, 0x00aa); set(0xa7, 0x00ba);
	set(0xa8, 0x00bf); set(0xa9, 0x2310); set(0xaa, 0x00ac); set(0xab, 0x00bd);
	set(0xac, 0x00bc); set(0xad, 0x00a1); set(0xae, 0x00ab); set(0xaf, 0x00bb);
	set(0xb0, 0x2591); set(0xb1, 0x2592); set(0xb2, 0x2593); set(0xb3, 0x2502);
	set(0xb4, 0x2524); set(0xb5, 0x2561); set(0xb6, 0x2562); set(0xb7, 0x2556);
	set(0xb8, 0x2555); set(0xb9, 0x2563); set(0xba, 0x2551); set(0xbb, 0x255d);
	set(0xbc, 0x255c); set(0xbd, 0x255b); set(0xbe, 0x2510); set(0xbf, 0x2514);
	set(0xc0, 0x2534); set(0xc1, 0x252c); set(0xc2, 0x251c); set(0xc3, 0x2500);
	set(0xc4, 0x253c); set(0xc5, 0x255e); set(0xc6, 0x255f); set(0xc7, 0x255a);
	set(0xc8, 0x2554); set(0xc9, 0x2569); set(0xca, 0x2566); set(0xcb, 0x2560);
	set(0xcc, 0x2550); set(0xcd, 0x256c); set(0xce, 0x2567); set(0xcf, 0x2568);
	set(0xd0, 0x2564); set(0xd1, 0x2565); set(0xd2, 0x2559); set(0xd3, 0x2558);
	set(0xd4, 0x2552); set(0xd5, 0x2553); set(0xd6, 0x256b); set(0xd7, 0x256a);
	set(0xd8, 0x2518); set(0xd9, 0x250c); set(0xda, 0x2588); set(0xdb, 0x2584);
	set(0xdc, 0x258c); set(0xdd, 0x2590); set(0xde, 0x2580); set(0xdf, 0x03b1);
	set(0xe0, 0x00df); set(0xe1, 0x0393); set(0xe2, 0x03c0); set(0xe3, 0x03a3);
	set(0xe4, 0x03c3); set(0xe5, 0x00b5); set(0xe6, 0x03c4); set(0xe7, 0x03a6);
	set(0xe8, 0x0398); set(0xe9, 0x03a9); set(0xea, 0x03b4); set(0xeb, 0x221e);
	set(0xec, 0x03c6); set(0xed, 0x03b5); set(0xee, 0x2229); set(0xef, 0x2261);
	set(0xf0, 0x00b1); set(0xf1, 0x2265); set(0xf2, 0x2264); set(0xf3, 0x2320);
	set(0xf4, 0x2321); set(0xf5, 0x00f7); set(0xf6, 0x2248); set(0xf7, 0x00b0);
	set(0xf8, 0x2219); set(0xf9, 0x00b7); set(0xfa, 0x221a); set(0xfb, 0x207f);
	set(0xfc, 0x00b2); set(0xfd, 0x25a0); set(0xfe, 0x00a0); set(0xff, 0x00a0);
	return table;
})();

/**
 * The CP437 code page is the identity mapping for 0x00-0x7f.
 * The upper half is the classic IBM PC graphics set.
 */
export function cp437ToUnicode(byte: number): number {
	return CP437_TO_UNICODE[byte & 0xff] ?? byte;
}

/** CP850 (multilingual Latin I) high half. */
const CP850_HIGH =
	'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** CP866 (Russian) high half. */
const CP866_HIGH =
	'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюяЁёЄєЇїЎў°∙·√№¤⌠⌡÷≈≡±≤≥⌐¬⅛⅜⅝⅞╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** KOI8-R high half. */
const KOI8R_HIGH =
	'Ё°∙©ю®҈ъ҈ӧƵ˙©®°©Ë˙'

	.split('')
	.map((c) => c.charCodeAt(0));

function latin1High(spec: string): number[] {
	const out: number[] = [];
	for (let i = 0; i < spec.length; i++) out.push(spec.charCodeAt(i));
	return out;
}

interface HighTable {
	/** High half (0x80-0xff) code points. */
	high: number[];
	/** When true the low half is remapped too (KOI8-R). */
	remapLow?: boolean;
	/** Low half remap table. */
	low?: number[];
}

const ISO_8859_5_HIGH = latin1High(
	'Ёђ҂ѕіўјљњћќґў„“”‘’÷ Ўўјљњћќґ „“”‘’÷ '
);

const ISO_8859_7_HIGH = latin1High(
	'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩΪΫάέήίΰαβγδεζηθικλμνξοπρςστυφχψωΐΰ'
);

const CP1251_HIGH = latin1High(
	'ЂЃЄЅІЇЈЉЊЋЌЍЎЏАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя'
);

const HIGH_TABLES: Partial<Record<CodepageName, HighTable>> = {
	CP437: { high: CP437_TO_UNICODE.slice(128) },
	CP850: { high: latin1High(CP850_HIGH) },
	'CP865': { high: latin1High(CP850_HIGH) },
	'CP866': { high: latin1High(CP866_HIGH) },
	'CP866 (b)': { high: latin1High(CP866_HIGH) },
	CP866U: { high: latin1High(CP866_HIGH) },
	CP1251: { high: CP1251_HIGH },
	'ISO-8859-2': { high: latin1High('ĄąĆćČčĎďĘęĚěŁłŃńŇňÓóŘřŚśŠšŤťŪūŻżŽž') },
	'ISO-8859-4': { high: latin1High('ĄąĆćČčĎďĘęĚěŁłŃńŇňÓóŘřŚśŠšŤťŪūŻżŽž') },
	'ISO-8859-5': { high: ISO_8859_5_HIGH },
	'ISO-8859-7': { high: ISO_8859_7_HIGH },
	'ISO-8859-8': { high: latin1High('֐֑֖֛֚֒֓֔֕֗֘֙֜֝֞֟') },
	'ISO-8859-9': { high: latin1High('ĞğİıŞş') },
	'ISO-8859-15': { high: latin1High('€') },
	CP1131: { high: CP1251_HIGH },
};

/**
 * Translate a raw byte to a Unicode code point using the given code page.
 *
 * Unknown code pages fall back to CP437, which is SyncTERM's default.
 */
export function byteToUnicode(byte: number, codepage: CodepageName = Codepage.CP437): number {
	const b = byte & 0xff;
	if (b < 0x80) return b;
	const table = HIGH_TABLES[codepage];
	if (!table) return CP437_TO_UNICODE[b];
	return table.high[b - 128] ?? CP437_TO_UNICODE[b];
}

/** All code page names in the order SyncTERM lists them. */
export const CODEPAGE_NAMES: CodepageName[] = Object.values(Codepage);
