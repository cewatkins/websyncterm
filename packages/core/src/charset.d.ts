/**
 * Character set translation tables.
 *
 * SyncTERM renders the raw byte from the wire through the current code page
 * (`enum ciolib_codepage` in src/conio/ciolib.h) to produce a glyph index for the
 * bitmap font. In the browser we keep the raw byte for font lookup and separately
 * provide the Unicode code point for clipboard/copy and for accessibility.
 */
/** Code pages understood by the engine (mirrors `enum ciolib_codepage`). */
export declare const Codepage: {
    readonly CP437: "CP437";
    readonly CP1251: "CP1251";
    readonly KOI8_R: "KOI8-R";
    readonly ISO_8859_2: "ISO-8859-2";
    readonly ISO_8859_4: "ISO-8859-4";
    readonly CP866M: "CP866";
    readonly ISO_8859_9: "ISO-8859-9";
    readonly HAIK8: "HAIK8";
    readonly ISO_8859_8: "ISO-8859-8";
    readonly CP866U: "CP866U";
    readonly ISO_8859_15: "ISO-8859-15";
    readonly ISO_8859_5: "ISO-8859-5";
    readonly ARMSCII8: "ARMSCII-8";
    readonly CP850: "CP850";
    readonly CP865: "CP865";
    readonly ISO_8859_7: "ISO-8859-7";
    readonly CP866M2: "CP866 (b)";
    readonly CP1131: "CP1131";
    readonly PETSCIIU: "PETSCII (UPPER)";
    readonly PETSCIIL: "PETSCII (Lower)";
    readonly ATASCII: "ATASCII";
    readonly PRESTEL: "Prestel";
    readonly ATARIST: "Atari ST";
};
export type CodepageName = (typeof Codepage)[keyof typeof Codepage];
/**
 * CP437 to Unicode.
 *
 * Bytes 0x00-0x7f are ASCII; 0x80-0xff map to the classic IBM PC graphics set.
 */
export declare const CP437_TO_UNICODE: readonly number[];
/**
 * The CP437 code page is the identity mapping for 0x00-0x7f.
 * The upper half is the classic IBM PC graphics set.
 */
export declare function cp437ToUnicode(byte: number): number;
/**
 * Translate a raw byte to a Unicode code point using the given code page.
 *
 * Unknown code pages fall back to CP437, which is SyncTERM's default.
 */
export declare function byteToUnicode(byte: number, codepage?: CodepageName): number;
/** All code page names in the order SyncTERM lists them. */
export declare const CODEPAGE_NAMES: CodepageName[];
//# sourceMappingURL=charset.d.ts.map