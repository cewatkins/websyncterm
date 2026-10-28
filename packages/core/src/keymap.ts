/**
 * Key to byte-sequence translation.
 *
 * Mirrors the tables in `src/conio/cterm.c` (ansi_keys and friends) and the
 * per-emulation overrides for PETSCII, ATASCII, VT52, Prestel and the BBC
 * Micro.
 */

import { TermEmulation, type TermEmulationName } from './types.js';

/** Logical key identifiers used by the browser front end. */
export const Key = {
	Up: 'up',
	Down: 'down',
	Left: 'left',
	Right: 'right',
	Home: 'home',
	End: 'end',
	PageUp: 'pageUp',
	PageDown: 'pageDown',
	Insert: 'insert',
	Delete: 'delete',
	Backspace: 'backspace',
	Tab: 'tab',
	BackTab: 'backTab',
	Enter: 'enter',
	Escape: 'escape',
	F1: 'f1', F2: 'f2', F3: 'f3', F4: 'f4', F5: 'f5', F6: 'f6',
	F7: 'f7', F8: 'f8', F9: 'f9', F10: 'f10', F11: 'f11', F12: 'f12',
} as const;

export type KeyName = (typeof Key)[keyof typeof Key];

/** Modifier keys. */
export interface Modifiers {
	shift?: boolean;
	alt?: boolean;
	ctrl?: boolean;
}

/** A key event as delivered by the browser. */
export interface KeyEvent {
	/** A printable character, if the key produced one. */
	char?: string;
	/** A named key (arrows, function keys, ...). */
	key?: KeyName;
	modifiers?: Modifiers;
	/** The raw KeyboardEvent code, used for physical key reporting. */
	code?: string;
}

/** Function key CSI final bytes, in SyncTERM's order. */
const FN_FINAL = [
	11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24,
];

/** Options that affect key translation. */
export interface KeyMapOptions {
	emulation?: TermEmulationName;
	/** DECBKM: backspace sends 0x08 rather than 0x7f. */
	decBkm?: boolean;
	/** Doorway mode sends `NUL <scancode>` for Alt combinations. */
	doorwayMode?: boolean;
}

/**
 * Translate a key event into the bytes to send to the host.
 */
export function encodeKey(event: KeyEvent, opts: KeyMapOptions = {}): Uint8Array {
	const emulation = opts.emulation ?? TermEmulation.AnsiBbs;
	const decBkm = opts.decBkm ?? true;

	switch (emulation) {
		case TermEmulation.PetsciiUpper:
		case TermEmulation.PetsciiLower:
			return petsciiKey(event);
		case TermEmulation.Atascii:
			return atasciiKey(event);
		case TermEmulation.Vt52:
		case TermEmulation.AtariSt:
			return vt52Key(event, decBkm);
		case TermEmulation.Prestel:
			return prestelKey(event);
		case TermEmulation.Beeb:
			return beebKey(event);
		default:
			return ansiKey(event, decBkm);
	}
}

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function modifierParam(mods: Modifiers | undefined): number {
	if (!mods) return 1;
	if (mods.ctrl) return 5;
	if (mods.alt) return 3;
	if (mods.shift) return 2;
	return 1;
}

function ansiKey(event: KeyEvent, decBkm: boolean): Uint8Array {
	const mods = event.modifiers;
	switch (event.key) {
		case Key.Up:
			return bytes('\x1b[A');
		case Key.Down:
			return bytes('\x1b[B');
		case Key.Right:
			return bytes('\x1b[C');
		case Key.Left:
			return bytes('\x1b[D');
		case Key.Home:
			return bytes('\x1b[H');
		case Key.End:
			return bytes('\x1b[K');
		case Key.PageUp:
			return bytes('\x1b[V');
		case Key.PageDown:
			return bytes('\x1b[U');
		case Key.Insert:
			return bytes('\x1b[@');
		case Key.BackTab:
			return bytes('\x1b[Z');
		case Key.Delete:
			return bytes(decBkm ? '\x7f' : '\x1b[3~');
		case Key.Backspace:
			return bytes(decBkm ? '\x08' : '\x7f');
		case Key.Tab:
			return bytes('\t');
		case Key.Enter:
			return bytes('\r');
		case Key.Escape:
			return bytes('\x1b');
		default:
			break;
	}
	const fnIndex = functionKeyIndex(event.key);
	if (fnIndex >= 0) {
		const mod = modifierParam(mods);
		const final = FN_FINAL[fnIndex];
		return mod === 1 ? bytes(`\x1b[${final}~`) : bytes(`\x1b[${final};${mod}~`);
	}
	if (event.char !== undefined && event.char.length > 0) {
		const code = event.char.codePointAt(0) ?? 0;
		if (code < 0x20) return bytes(event.char);
		return bytes(event.char);
	}
	return new Uint8Array(0);
}

function functionKeyIndex(key: KeyName | undefined): number {
	if (!key) return -1;
	const m = /^f(\d+)$/.exec(key);
	if (!m) return -1;
	const n = parseInt(m[1], 10);
	if (n < 1 || n > 12) return -1;
	return n - 1;
}

/** PETSCII key codes (`cterm.c:158-178`). */
function petsciiKey(event: KeyEvent): Uint8Array {
	switch (event.key) {
		case Key.F1: return bytes('\x85');
		case Key.F2: return bytes('\x89');
		case Key.F3: return bytes('\x86');
		case Key.F4: return bytes('\x8a');
		case Key.F5: return bytes('\x87');
		case Key.F6: return bytes('\x8b');
		case Key.F7: return bytes('\x88');
		case Key.F8: return bytes('\x8c');
		case Key.Home: return bytes('\x13');
		case Key.Up: return bytes('\x91');
		case Key.Down: return bytes('\x11');
		case Key.Left: return bytes('\x9d');
		case Key.Right: return bytes('\x1d');
		case Key.End: return bytes('\x93');
		case Key.Insert: return bytes('\x94');
		case Key.Delete:
		case Key.Backspace:
			return bytes('\x14');
		case Key.Enter:
			return bytes('\r');
		default:
			break;
	}
	if (event.char !== undefined && event.char.length > 0) return bytes(event.char);
	return new Uint8Array(0);
}

/** ATASCII key codes (`cterm.c:148-156`). */
function atasciiKey(event: KeyEvent): Uint8Array {
	switch (event.key) {
		case Key.Up: return bytes('\x1c');
		case Key.Down: return bytes('\x1d');
		case Key.Left: return bytes('\x1e');
		case Key.Right: return bytes('\x1f');
		case Key.Insert: return bytes('\xff');
		case Key.Delete: return bytes('\x7e');
		case Key.Backspace: return bytes('\x08');
		default:
			break;
	}
	if (event.char === '`') return new Uint8Array(0); // toggles inverse video
	if (event.char !== undefined && event.char.length > 0) return bytes(event.char);
	return new Uint8Array(0);
}

/** VT52 key codes (`cterm.c:321-329`). */
function vt52Key(event: KeyEvent, decBkm: boolean): Uint8Array {
	switch (event.key) {
		case Key.F1: return bytes('\x1bP');
		case Key.F2: return bytes('\x1bQ');
		case Key.F3: return bytes('\x1bR');
		case Key.Up: return bytes('\x1bA');
		case Key.Down: return bytes('\x1bB');
		case Key.Right: return bytes('\x1bC');
		case Key.Left: return bytes('\x1bD');
		case Key.Delete:
			return bytes(decBkm ? '\x7f' : '\x1b[3~');
		case Key.Backspace:
			return bytes(decBkm ? '\x08' : '\x7f');
		default:
			break;
	}
	if (event.char !== undefined && event.char.length > 0) return bytes(event.char);
	return new Uint8Array(0);
}

/** Prestel key codes. */
function prestelKey(event: KeyEvent): Uint8Array {
	const mods = event.modifiers ?? {};
	const k: KeyName | undefined = event.key;
	if (mods.ctrl) {
		switch (k) {
			case Key.Left: return bytes('\xac');
			case Key.Right: return bytes('\xad');
			case Key.End: return bytes('\xab');
			case Key.Up: return bytes('\xaf');
			case Key.Down: return bytes('\xae');
			default: break;
		}
	}
	if (mods.shift) {
		switch (k) {
			case Key.Up: return bytes('\x9f');
			case Key.Down: return bytes('\x9e');
			case Key.Left: return bytes('\x9c');
			case Key.Right: return bytes('\x9d');
			case Key.End: return bytes('\x9b');
			default: break;
		}
	}
	switch (k) {
		case Key.F7: return bytes('\x1b');
		case Key.Home: return bytes('\x1e');
		case Key.Up: return bytes('\x8f');
		case Key.Down: return bytes('\x8e');
		case Key.Left: return bytes('\x8c');
		case Key.Right: return bytes('\x8d');
		case Key.Delete:
		case Key.Backspace:
			return bytes('\x7f');
		default: break;
	}
	const fnIndex = functionKeyIndex(k);
	if (fnIndex >= 0 && fnIndex < 10) {
		if (mods.ctrl) return bytes(String.fromCharCode(0xa0 + fnIndex));
		if (mods.shift) return bytes(String.fromCharCode(0x90 + fnIndex));
	}
	if (event.char !== undefined && event.char.length > 0) {
		// Prestel substitutes these characters.
		switch (event.char) {
			case '#': return bytes('_');
			case '_': return bytes('`');
			case '`': return bytes('#');
			default: break;
		}
		const code = event.char.codePointAt(0) ?? 0;
		if (code < 0x20 || code > 0x7f) return new Uint8Array(0);
		return bytes(event.char);
	}

	return new Uint8Array(0);
}

/** BBC Micro (Mode 7) key codes. */
function beebKey(event: KeyEvent): Uint8Array {
	const mods = event.modifiers ?? {};
	const k: KeyName | undefined = event.key;
	if (mods.ctrl) {
		switch (k) {
			case Key.Left: return bytes('\xac');
			case Key.Right: return bytes('\xad');
			case Key.End: return bytes('\xab');
			case Key.Up: return bytes('\xaf');
			case Key.Down: return bytes('\xae');
			default: break;
		}
	}
	if (mods.shift) {
		switch (k) {
			case Key.Up: return bytes('\x9f');
			case Key.Down: return bytes('\x9e');
			case Key.Left: return bytes('\x9c');
			case Key.Right: return bytes('\x9d');
			case Key.End: return bytes('\x9b');
			default: break;
		}
	}
	switch (k) {
		case Key.F7: return bytes('\x1b');
		case Key.Home: return bytes('\x1f');
		case Key.Up: return bytes('\x8f');
		case Key.Down: return bytes('\x8e');
		case Key.Left: return bytes('\x8c');
		case Key.Right: return bytes('\x8d');
		case Key.Delete:
		case Key.Backspace:
			return bytes('\x7f');
		default: break;
	}
	const fnIndex = functionKeyIndex(k);
	if (fnIndex >= 0 && fnIndex < 10) {
		if (mods.ctrl) return bytes(String.fromCharCode(0xa0 + fnIndex));
		if (mods.shift) return bytes(String.fromCharCode(0x90 + fnIndex));
	}
	if (event.char !== undefined && event.char.length > 0) {
		const code = event.char.codePointAt(0) ?? 0;
		if (code > 0x7f) return new Uint8Array(0);
		return bytes(event.char);
	}

	return new Uint8Array(0);
}

/**
 * Build a mouse report in the format SyncTERM sends.
 *
 * @param mode The active mouse reporting mode.
 * @param button 0-based button number.
 * @param x 1-based column.
 * @param y 1-based row.
 * @param motion True when the event is a motion report.
 * @param release True when the button was released.
 */
export function encodeMouseReport(
	mode: { x10: boolean; sgr: boolean },
	button: number,
	x: number,
	y: number,
	motion: boolean,
	release: boolean,
	mods: { shift?: boolean; alt?: boolean; ctrl?: boolean } = {},
): Uint8Array {
	let cb = button;
	if (motion) cb += 32;
	if (mods.shift) cb += 4;
	if (mods.alt) cb += 8;
	if (mods.ctrl) cb += 16;
	if (release) cb = button + (mode.sgr ? 3 : 3);

	if (mode.sgr) {
		const final = release ? 'm' : 'M';
		return bytes(`\x1b[<${cb};${x};${y}${final}`);
	}
	const clamp = (v: number): number => Math.max(0, Math.min(222, v - 1));
	return bytes(`\x1b[M${String.fromCharCode(32 + cb)}${String.fromCharCode(33 + clamp(x))}${String.fromCharCode(33 + clamp(y))}`);
}

/**
 * The SyncTERM local shortcut bindings (Wren `keys_default.wren`).
 *
 * These are handled by the application, not sent to the host.
 */
export const LOCAL_SHORTCUTS: Record<string, string> = {
	'alt+x': 'disconnect-and-exit',
	'alt+h': 'hangup',
	'ctrl+q': 'hangup',
	'alt+o': 'toggle-mouse',
	'alt+arrowup': 'throttle-up',
	'alt+arrowdown': 'throttle-down',
	'shift+insert': 'paste',
	'alt+b': 'scrollback',
	'alt+c': 'capture',
	'alt+m': 'ansi-music',
	'alt+d': 'download',
	'alt+u': 'upload',
	'alt+f': 'font-picker',
	'alt+z': 'online-menu',
	'ctrl+s': 'online-menu',
	'alt+l': 'send-credentials',
	'alt+e': 'menu',
};
