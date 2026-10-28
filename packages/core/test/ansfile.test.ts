import { describe, expect, it } from 'vitest';
import { CTerm } from '../src/cterm.js';
import { buildSauce, parseSauce, stripSauce, withSauce } from '../src/ansfile.js';
import { extractAnsi, extractText, searchScreen } from '../src/clipboard.js';

describe('ANSI files', () => {
	it('round-trips a SAUCE record', () => {
		const record = buildSauce({ title: 'A title', author: 'An author', dataType: 1, tinfo1: 80, tinfo2: 25 });
		expect(record.length).toBe(128);
		const file = withSauce(new TextEncoder().encode('\x1b[2Jhello'), { title: 'T', author: 'A' });
		const sauce = parseSauce(file);
		expect(sauce?.title).toBe('T');
		expect(sauce?.author).toBe('A');
		expect(sauce?.fileSize).toBe(9);
	});

	it('strips the SAUCE record from the payload', () => {
		const payload = new TextEncoder().encode('\x1b[2Jhello');
		const file = withSauce(payload, {});
		const stripped = stripSauce(file);
		expect(new TextDecoder().decode(stripped)).toBe('\x1b[2Jhello');
	});

	it('returns null when there is no SAUCE record', () => {
		expect(parseSauce(new TextEncoder().encode('nope'))).toBeNull();
	});
});

describe('clipboard extraction', () => {
	function screenOf(text: string, cols = 20, rows = 5): CTerm {
		const term = new CTerm({ cols, rows });
		term.writeString(text);
		return term;
	}

	it('extracts plain text', () => {
		const term = screenOf('Hello\r\nWorld');
		const text = extractText(term.screen, { top: 0, left: 0, bottom: 4, right: 19 });
		expect(text).toBe('Hello\nWorld');
	});

	it('extracts a rectangle', () => {
		const term = screenOf('abcdef\r\nghijkl');
		const text = extractText(term.screen, { top: 0, left: 1, bottom: 1, right: 3 });
		expect(text).toBe('bcd\nhij');
	});

	it('exports ANSI with colour attributes', () => {
		const term = screenOf('\x1b[31mred');
		const ansi = extractAnsi(term.screen, term.palette, { top: 0, left: 0, bottom: 0, right: 19 });
		expect(ansi).toContain('\x1b[31m');
		expect(ansi).toContain('red');
	});

	it('finds text case-insensitively', () => {
		const term = screenOf('Hello World');
		const hits = searchScreen(term.screen, 'world', { top: 0, left: 0, bottom: 0, right: 19 });
		expect(hits.length).toBe(1);
		expect(hits[0].column).toBe(6);
		expect(hits[0].text).toBe('World');
	});
});
