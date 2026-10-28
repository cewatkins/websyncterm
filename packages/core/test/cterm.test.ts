import { describe, expect, it } from 'vitest';
import { CTerm } from '../src/cterm.js';
import { cp437ToUnicode } from '../src/charset.js';

function term(cols = 80, rows = 25) {
	const out: Uint8Array[] = [];
	const t = new CTerm({ cols, rows, onResponse: (d) => out.push(d) });
	return { t, out, text: () => new TextDecoder().decode(Buffer.concat(out.map((d) => Buffer.from(d)))) };
}

function screenText(t: CTerm, row: number): string {
	let s = '';
	for (let x = 0; x < t.cols; x++) {
		s += String.fromCodePoint(t.screen.charAt(x, row));
	}
	return s.replace(/\s+$/, '');
}

describe('CTerm', () => {
	it('writes plain text', () => {
		const { t } = term();
		t.writeString('Hello');
		expect(screenText(t, 0)).toBe('Hello');
	});

	it('moves the cursor with CSI H', () => {
		const { t } = term();
		t.writeString('\x1b[3;5Hxy');
		expect(screenText(t, 2)).toBe('    xy');
	});

	it('erases the display with CSI 2 J', () => {
		const { t } = term();
		t.writeString('abc');
		t.writeString('\x1b[2J');
		expect(screenText(t, 0)).toBe('');
		expect(t.xpos).toBe(0);
		expect(t.ypos).toBe(0);
	});

	it('wraps to the next line at the right margin', () => {
		const { t } = term(10, 5);
		t.writeString('0123456789');
		expect(screenText(t, 0)).toBe('0123456789');
		expect(screenText(t, 1)).toBe('');
		expect(t.ypos).toBe(1);
	});

	it('does not wrap when DECAWM is reset', () => {
		const { t } = term(10, 5);
		t.writeString('\x1b[?7l');
		t.writeString('0123456789ABC');
		// The last column is overwritten in place, as upstream does.
		expect(screenText(t, 0)).toBe('012345678C');
		expect(screenText(t, 1)).toBe('');
	});

	it('applies SGR colours', () => {
		const { t } = term();
		t.writeString('\x1b[31mred');
		expect(t.screen.fg[0]).toBe(1);
		expect(screenText(t, 0)).toBe('red');
	});

	it('implements SGR 7 negative image by swapping colours', () => {
		const { t } = term();
		t.writeString('\x1b[31;44m\x1b[7mX');
		// fg red(1) / bg blue(4) swapped -> fg 4, bg 1
		expect(t.screen.fg[0]).toBe(4);
		expect(t.screen.bg[0]).toBe(1);
	});

	it('responds to DA with the CTerm identity', () => {
		const { t, text } = term();
		t.writeString('\x1b[c');
		expect(text()).toContain('67;84;101;114;109');
	});

	it('responds to DSR 6 with the cursor position', () => {
		const { t, text } = term();
		t.writeString('\x1b[5;10H\x1b[6n');
		expect(text()).toBe('\x1b[5;10R');
	});

	it('implements scroll regions', () => {
		const { t } = term(10, 6);
		t.writeString('\x1b[2;4r');
		expect(t.scrollTop).toBe(1);
		expect(t.scrollBottom).toBe(3);
	});

	it('handles OSC 4 palette changes', () => {
		const { t } = term();
		t.writeString('\x1b]4;1;rgb:ff/00/00\x1b\\');
		expect(t.palette.get(1 + 16)).toBe(0xff0000);
	});

	it('handles OSC 8 hyperlinks', () => {
		const { t } = term();
		t.writeString('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\');
		expect(t.hyperlinkUri).toBe('');
		expect(t.screen.linkId[0]).toBeGreaterThanOrEqual(0);
	});

	it('repeats the last character with CSI b', () => {
		const { t } = term();
		t.writeString('X\x1b[4b');
		expect(screenText(t, 0)).toBe('XXXXX');
	});

	it('inserts and deletes characters', () => {
		const { t } = term();
		t.writeString('abcdef\x1b[1;1H\x1b[2@');
		expect(screenText(t, 0)).toBe('  abcdef');
		t.writeString('\x1b[1;1H\x1b[2P');
		expect(screenText(t, 0)).toBe('abcdef');
	});

	it('maps CP437 bytes to Unicode', () => {
		expect(cp437ToUnicode(0x01)).toBe(0x263a);
		expect(cp437ToUnicode(0xb3)).toBe(0x2502);
		expect(cp437ToUnicode(0xdb)).toBe(0x2584);
	});

	it('captures ANSI music', () => {
		const { t } = term();
		t.writeString('\x1b|');
		t.writeString('MFABC');
		t.writeString('\x0e');
		expect(t.musicString).toBeNull();
	});
});
