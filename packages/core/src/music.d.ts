/**
 * ANSI/BANSI music parser.
 *
 * Implements the "ANSI music" language described in `src/conio/cterm.txt`
 * (the "ANSI" MUSIC section) and in the upstream BANSI documentation:
 *
 *  - The music string is introduced by `CSI |`, `CSI N` or `CSI M` depending on
 *    the `CSI = Ps M` setting, and terminated by SO (0x0e).
 *  - Only the characters `aAbBcCdDeEfFgGlLmMnNoOpPsStT0123456789.-+#<> ` are
 *    allowed; anything else aborts the string.
 *  - `MF`/`MB`/`ML`/`MN`/`MS`/`MT`/`MO` set the mode, tempo and octave.
 *  - Notes are `A`-`G` (or `P` for a pause) optionally followed by modifiers:
 *    `+`/`#` sharp, `-` flat, `.` dotted (1.5x) and a digit or digits giving
 *    the note length as the reciprocal of a whole note.
 */
import { type MusicModeName } from './cterm.js';
/** A parsed note. */
export interface MusicNote {
    /** MIDI-style note number (0 = C in octave 0), or -1 for a rest. */
    note: number;
    /** Duration in whole-note fractions (1 = a whole note, 4 = a quarter). */
    duration: number;
}
/** The tempo in quarter notes per minute. */
export declare const DEFAULT_TEMPO = 120;
/** The default octave. */
export declare const DEFAULT_OCTAVE = 4;
/** The default note length (a quarter note). */
export declare const DEFAULT_NOTE_LENGTH = 4;
/** Frequencies of C in octaves 0-6, as used upstream. */
export declare const C_FREQUENCIES: number[];
/**
 * Parse an ANSI music string into a list of notes.
 *
 * @param text The music string (without the introducer or the SO terminator).
 */
export declare function parseMusic(text: string): MusicNote[];
/**
 * Compute the frequency of a note number.
 *
 * Note 0 is C in octave 0. The seven octave base frequencies are the ones
 * used upstream rather than exact equal-tempered values.
 */
export declare function noteFrequency(note: number): number;
/**
 * Whether a music introducer is enabled for the given mode.
 *
 * `CSI |` is always valid; `CSI N` requires BANSI or FULL; `CSI M` requires
 * FULL.
 */
export declare function musicIntroducerEnabled(mode: MusicModeName, introducer: '|' | 'N' | 'M'): boolean;
/**
 * Parse a music string that was captured by the terminal.
 *
 * Returns null when the string is not valid music.
 */
export declare function parseCapturedMusic(text: string | null): MusicNote[] | null;
//# sourceMappingURL=music.d.ts.map