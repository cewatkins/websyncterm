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
import { MusicMode } from './cterm.js';
/** The tempo in quarter notes per minute. */
export const DEFAULT_TEMPO = 120;
/** The default octave. */
export const DEFAULT_OCTAVE = 4;
/** The default note length (a quarter note). */
export const DEFAULT_NOTE_LENGTH = 4;
/** Frequencies of C in octaves 0-6, as used upstream. */
export const C_FREQUENCIES = [65.406, 130.81, 261.62, 523.25, 1046.5, 2093.0, 4186.0];
/** Note names within an octave (the upstream "octave" ordering). */
const NOTE_SEMITONES = {
    C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};
/** The characters allowed in a music string. */
const ALLOWED = 'aAbBcCdDeEfFgGlLmMnNoOpPsStT0123456789.-+#<> ';
/**
 * Parse an ANSI music string into a list of notes.
 *
 * @param text The music string (without the introducer or the SO terminator).
 */
export function parseMusic(text) {
    const notes = [];
    let octave = DEFAULT_OCTAVE;
    let noteLength = DEFAULT_NOTE_LENGTH;
    let tempo = DEFAULT_TEMPO;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (!ALLOWED.includes(ch)) {
            // An invalid character aborts the whole string.
            return [];
        }
        i++;
        switch (ch) {
            case 'M': {
                const mode = text[i];
                i++;
                if (mode === 'T') {
                    let digits = '';
                    while (i < text.length && text[i] >= '0' && text[i] <= '9')
                        digits += text[i++];
                    if (digits) {
                        const v = parseInt(digits, 10);
                        tempo = Math.max(32, Math.min(255, v));
                    }
                }
                else if (mode === 'O') {
                    let digits = '';
                    while (i < text.length && text[i] >= '0' && text[i] <= '9')
                        digits += text[i++];
                    if (digits) {
                        const v = parseInt(digits, 10);
                        octave = Math.max(0, Math.min(6, v));
                    }
                }
                // MF/MB/MN/ML/MS are mode selectors with no effect on the notes.
                continue;
            }
            case 'L': {
                let digits = '';
                while (i < text.length && text[i] >= '0' && text[i] <= '9')
                    digits += text[i++];
                if (digits) {
                    const v = parseInt(digits, 10);
                    if (v >= 1 && v <= 64)
                        noteLength = v;
                }
                continue;
            }
            case 'N': {
                let digits = '';
                while (i < text.length && text[i] >= '0' && text[i] <= '9')
                    digits += text[i++];
                const v = digits ? parseInt(digits, 10) : -1;
                const note = v >= 0 && v <= 71 ? v : -1;
                notes.push({ note, duration: noteLength });
                continue;
            }
            case '<':
                octave = Math.max(0, octave - 1);
                continue;
            case '>':
                octave = Math.min(6, octave + 1);
                continue;
            case 'P': {
                // A pause.
                const mods = parseModifiers(text, i);
                i = mods.next;
                notes.push({ note: -1, duration: mods.duration });
                continue;
            }
            case 'A':
            case 'B':
            case 'C':
            case 'D':
            case 'E':
            case 'F':
            case 'G': {
                const mods = parseModifiers(text, i);
                i = mods.next;
                const semitone = NOTE_SEMITONES[ch];
                const note = octave * 12 + semitone + mods.semitoneOffset;
                notes.push({ note, duration: mods.duration });
                continue;
            }
            default:
                continue;
        }
    }
    void tempo;
    return notes;
}
/** Parse the modifiers that may follow a note. */
function parseModifiers(text, start) {
    let i = start;
    let semitoneOffset = 0;
    let duration = DEFAULT_NOTE_LENGTH;
    let dotted = false;
    for (;;) {
        const ch = text[i];
        if (ch === undefined)
            break;
        if (ch === '+' || ch === '#') {
            semitoneOffset++;
            i++;
            continue;
        }
        if (ch === '-') {
            semitoneOffset--;
            i++;
            continue;
        }
        if (ch === '.') {
            dotted = true;
            i++;
            continue;
        }
        if (ch >= '0' && ch <= '9') {
            let digits = '';
            while (i < text.length && text[i] >= '0' && text[i] <= '9')
                digits += text[i++];
            const v = parseInt(digits, 10);
            if (v >= 1 && v <= 64)
                duration = v;
            break;
        }
        break;
    }
    if (dotted)
        duration = duration * 1.5;
    return { semitoneOffset, duration, next: i };
}
/**
 * Compute the frequency of a note number.
 *
 * Note 0 is C in octave 0. The seven octave base frequencies are the ones
 * used upstream rather than exact equal-tempered values.
 */
export function noteFrequency(note) {
    if (note < 0)
        return 0;
    const octave = Math.floor(note / 12);
    const semitone = note % 12;
    const base = C_FREQUENCIES[Math.max(0, Math.min(6, octave))];
    return base * Math.pow(2, semitone / 12);
}
/**
 * Whether a music introducer is enabled for the given mode.
 *
 * `CSI |` is always valid; `CSI N` requires BANSI or FULL; `CSI M` requires
 * FULL.
 */
export function musicIntroducerEnabled(mode, introducer) {
    switch (introducer) {
        case '|':
            return true;
        case 'N':
            return mode >= MusicMode.Bansi;
        case 'M':
            return mode >= MusicMode.Full;
        default:
            return false;
    }
}
/**
 * Parse a music string that was captured by the terminal.
 *
 * Returns null when the string is not valid music.
 */
export function parseCapturedMusic(text) {
    if (text === null)
        return null;
    const trimmed = text.trim();
    if (trimmed === '')
        return null;
    // The upstream rule: if the introducer was `CSI M`, the first character may
    // be a mode letter that must be ignored.
    let body = trimmed;
    if (/^[BbFfLlSs]/.test(body))
        body = body.slice(1);
    else if (/^[Nn](?![0-9])/.test(body))
        body = body.slice(1);
    return parseMusic(body);
}
//# sourceMappingURL=music.js.map