import { describe, expect, it } from 'vitest';
import { CTerm } from '../src/cterm.js';

/**
 * iCE colours.
 *
 * With iCE colours the blink attribute selects the bright variant of the
 * background colour instead of making the character blink. This is the
 * "high intensity BG" convention that ANSI art uses and that SAUCE's
 * `nonblink` ANSI flag describes.
 *
 * Upstream: `CIOLIB_VIDEO_BGBRIGHT` (DECSET 33) keeps the blink bit in the
 * background nibble, `CIOLIB_VIDEO_NOBLINK` (DECSET 35) stops the glyph
 * from being hidden, and `bitmap_attr2palette_locked()` masks the background
 * down to 0-7 unless BGBRIGHT is set.
 */
describe('iCE colours', () => {
	it('is enabled by default in the web app, not in the engine', () => {
		const term = new CTerm({ cols: 80, rows: 25 });
		expect(term.iceColors).toBe(false);
		term.setIceColors(true);
		expect(term.iceColors).toBe(true);
	});

	it('makes the blink bit select the bright background', () => {
		const term = new CTerm({ cols: 80, rows: 25 });
		term.setIceColors(true);
		// SGR 5 (blink) with a blue background.
		term.writeString('\x1b[5;44mX');
		// Background index 4 (blue) plus 8 for the intensity bit.
		expect(term.screen.bg[0]).toBe(12);
		expect(term.screen.flags[0] & 2).toBe(2); // the blink bit is still set
	});

	it('masks the background to 0-7 when iCE is off', () => {
		const term = new CTerm({ cols: 80, rows: 25 });
		term.setIceColors(false);
		term.writeString('\x1b[5;44mX');
		expect(term.screen.bg[0]).toBe(4);
		expect(term.screen.flags[0] & 2).toBe(2);
	});

	it('clears the intensity again when the blink is reset', () => {
		const term = new CTerm({ cols: 80, rows: 25 });
		term.setIceColors(true);
		term.writeString('\x1b[5;44m\x1b[25mX');
		expect(term.screen.bg[0]).toBe(4);
	});

	it('is overridden by an explicit DECSET 33 from the host', () => {
		const term = new CTerm({ cols: 80, rows: 25 });
		term.setIceColors(true);
		// The host turns the bright background off.
		term.writeString('\x1b[?33l');
		expect(term.iceColors).toBe(false);
		term.writeString('\x1b[5;44mX');
		expect(term.screen.bg[0]).toBe(4);
	});

	it('lets the host turn the bright background on', () => {
		const term = new CTerm({ cols: 80, rows: 25 });
		term.writeString('\x1b[?33h');
		expect(term.iceColors).toBe(true);
		term.writeString('\x1b[5;44mX');
		expect(term.screen.bg[0]).toBe(12);
	});

	it('reports the mode state through DECRQM', () => {
		const responses: string[] = [];
		const term = new CTerm({
			cols: 80,
			rows: 25,
			onResponse: (d) => responses.push(new TextDecoder().decode(d)),
		});
		term.setIceColors(true);
		term.writeString('\x1b[?33$p');
		expect(responses.join('')).toBe('\x1b[?33;1$y');
	});
});
