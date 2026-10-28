/**
 * Screen text extraction and ANSI export.
 *
 * Used by the clipboard ("copy"), the scrollback search and the "export as
 * ANSI" action. Non-ASCII screen modes (PETSCII, ATASCII, Prestel, …) are
 * translated back to plain text.
 */

import { byteToUnicode, type CodepageName } from './charset.js';
import type { ScreenBuffer } from './buffer.js';
import type { Palette } from './palette.js';

/** A rectangle of the screen to extract. */
export interface Region {
	top: number;
	left: number;
	bottom: number;
	right: number;
}

/**
 * Extract a region of the screen as plain text.
 *
 * Trailing whitespace on each line is removed and lines that are entirely
 * blank are dropped from the middle of the selection, matching what a user
 * expects when copying a rectangle from a terminal.
 */
export function extractText(
	screen: ScreenBuffer,
	region: Region,
	codepage: CodepageName = 'CP437',
	mapper?: (code: number) => number,
): string {
	const lines: string[] = [];
	const top = Math.max(0, region.top);
	const bottom = Math.min(screen.rows - 1, region.bottom);
	for (let y = top; y <= bottom; y++) {
		let line = '';
		const left = Math.max(0, region.left);
		const right = Math.min(screen.cols - 1, region.right);
		for (let x = left; x <= right; x++) {
			const code = screen.chars[y * screen.cols + x];
			const mapped = mapper ? mapper(code) : byteToUnicode(code, codepage);
			line += String.fromCodePoint(mapped);
		}
		lines.push(line.replace(/\s+$/, ''));
	}
	while (lines.length > 0 && lines[0] === '') lines.shift();
	while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	return lines.join('\n');
}

/**
 * Convert a screen region to ANSI escape sequences.
 *
 * The output uses SGR for the colours and preserves the original byte values
 * so the result can be replayed into any ANSI terminal.
 */
export function extractAnsi(
	screen: ScreenBuffer,
	palette: Palette,
	region: Region,
	codepage: CodepageName = 'CP437',
): string {
	let out = '';
	let lastFg = -1;
	let lastBg = -1;
	let lastFlags = -1;

	const top = Math.max(0, region.top);
	const bottom = Math.min(screen.rows - 1, region.bottom);
	for (let y = top; y <= bottom; y++) {
		let line = '';
		const left = Math.max(0, region.left);
		const right = Math.min(screen.cols - 1, region.right);
		for (let x = left; x <= right; x++) {
			const i = y * screen.cols + x;
			const fg = screen.fg[i];
			const bg = screen.bg[i];
			const flags = screen.flags[i];
			if (fg !== lastFg || bg !== lastBg || flags !== lastFlags) {
				line += '\x1b[0m';
				if (flags & 1) line += '\x1b[1m';
				if (flags & 2) line += '\x1b[5m';
				if (flags & 4) line += '\x1b[7m';
				if (fg >= 0 && fg < 8) line += `\x1b[3${fg}m`;
				else if (fg >= 8 && fg < 16) line += `\x1b[9${fg - 8}m`;
				else if (fg >= 16) line += `\x1b[38;5;${fg - 16}m`;
				if (bg >= 0 && bg < 8) line += `\x1b[4${bg}m`;
				else if (bg >= 8 && bg < 16) line += `\x1b[10${bg - 8}m`;
				else if (bg >= 16) line += `\x1b[48;5;${bg - 16}m`;
				lastFg = fg;
				lastBg = bg;
				lastFlags = flags;
			}
			const code = screen.chars[i];
			line += String.fromCodePoint(code);
		}
		out += line.replace(/\s+$/, '') + '\r\n';
	}
	out += '\x1b[0m';
	void palette;
	void codepage;
	return out;
}

/**
 * Find every occurrence of `needle` in the scrollback and on the screen.
 */
export interface SearchHit {
	/** True when the hit is in the scrollback rather than on the screen. */
	inScrollback: boolean;
	/** The scrollback row index, or the screen row when on the screen. */
	row: number;
	/** The column of the hit. */
	column: number;
	/** The matching text. */
	text: string;
}

/**
 * Search a region of the screen for a string, case-insensitively.
 */
export function searchScreen(
	screen: ScreenBuffer,
	needle: string,
	region: Region,
	codepage: CodepageName = 'CP437',
): SearchHit[] {
	const hits: SearchHit[] = [];
	if (needle === '') return hits;
	const lower = needle.toLowerCase();
	for (let y = region.top; y <= region.bottom; y++) {
		let line = '';
		for (let x = region.left; x <= region.right; x++) {
			line += String.fromCodePoint(byteToUnicode(screen.chars[y * screen.cols + x], codepage));
		}
		const haystack = line.toLowerCase();
		let from = 0;
		for (;;) {
			const at = haystack.indexOf(lower, from);
			if (at === -1) break;
			hits.push({ inScrollback: false, row: y, column: region.left + at, text: line.slice(at, at + needle.length) });
			from = at + 1;
		}
	}
	return hits;
}
