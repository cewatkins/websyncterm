// Host-command text-variable expansion.
//
// Host commands are strings sent back to the BBS by RIP commands such as
// RIP_QUERY and mouse fields.  They support ^X control escapes and $NAME$
// variables.  The host application supplies environment values through a
// RipVariableContext; mouse values come from the same interface.

/** Mouse state as seen by $X$/$Y$/$XY$/$XYM$/$M$/$MSTAT$. */
export interface RipMouseState {
	/** Graphics coordinates, or text-cell coordinates in text mode. */
	x: number;
	y: number;
	/** Bit 0 = left, bit 1 = right, bit 2 = middle. */
	buttons: number;
	/** When true, $X$/$Y$ use two-digit text coordinates. */
	text?: boolean;
}

/**
 * Values supplied by the host application.  The interpreter calls `get`
 * for unknown variables, and uses the optional hooks for the special
 * action variables ($RESET$, $SAVE0$ ... $SAVE9$, $RESTORE...$).
 */
export interface RipVariableContext {
	get(name: string): string | undefined;
	mouse?: RipMouseState;
	sound?(name: string): void;
	reset?(): void;
	save?(slot: number): void;
	restore?(slot: number): void;
}

export interface VariableHooks {
	get(name: string): string | undefined;
	mouse?: RipMouseState;
	sound(name: string): void;
	reset(): void;
	save(slot: number): void;
	restore(slot: number): void;
}

export const RIP_VERSION_STRING = 'RIPSCRIP015410';

const SOUND_VARIABLES = new Set([
	'ALARM', 'BEEP', 'BLIP', 'MUSIC', 'PHASER', 'REVPHASER',
]);

function pad(value: number, width: number): string {
	const neg = value < 0;
	const s = Math.abs(Math.trunc(value)).toString().padStart(width, '0');
	return neg ? `-${s}` : s;
}

function mouseString(name: string, mouse: RipMouseState | undefined): string | null {
	const state = mouse ?? { x: 0, y: 0, buttons: 0 };
	const fw = state.text ? 2 : 4;
	switch (name) {
		case 'X':
			return pad(state.x, fw);
		case 'Y':
			return pad(state.y, fw);
		case 'XY':
			return `${pad(state.x, fw)}:${pad(state.y, fw)}`;
		case 'XYM':
			return `${pad(state.x, fw)}:${pad(state.y, fw)}:`
				+ `${state.buttons & 1}${(state.buttons >> 1) & 1}${(state.buttons >> 2) & 1}`;
		case 'M':
			return `${state.buttons & 1}${(state.buttons >> 1) & 1}${(state.buttons >> 2) & 1}`;
		case 'MSTAT':
			return 'YES';
		default:
			return null;
	}
}

function slotFromName(name: string): number {
	if (name === 'SAVE' || name === 'RESTORE' || name === 'RMF' || name === 'RCB')
		return 0;
	if (name === 'SAVEALL' || name === 'RESTOREALL')
		return -1;
	const m = /^SAVE([0-9])$/.exec(name) ?? /^RESTORE([0-9])$/.exec(name);
	return m ? Number(m[1]) : 0;
}

const ACTION_VARIABLES = new Set([
	'OFF', 'HKEYON', 'HKEYOFF', 'TABON', 'TABOFF', 'RESET',
	'SAVE', 'SAVEALL', 'RESTORE', 'RESTOREALL', 'RMF', 'RCB',
	'SAVE0', 'SAVE1', 'SAVE2', 'SAVE3', 'SAVE4', 'SAVE5', 'SAVE6',
	'SAVE7', 'SAVE8', 'SAVE9',
	'RESTORE1', 'RESTORE2', 'RESTORE3', 'RESTORE4', 'RESTORE5',
	'RESTORE6', 'RESTORE7', 'RESTORE8', 'RESTORE9',
]);

/**
 * Resolve one $NAME$ variable.  Returns null when the name is not one of
 * the built-in variables (the caller then asks the host).
 */
function resolveBuiltin(name: string, hooks: VariableHooks): string | null {
	const upper = name.toUpperCase();

	const mouse = mouseString(upper, hooks.mouse);
	if (mouse !== null)
		return mouse;

	if (upper === 'RIPVER')
		return RIP_VERSION_STRING;

	if (SOUND_VARIABLES.has(upper)) {
		hooks.sound(upper);
		return '';
	}

	if (!ACTION_VARIABLES.has(upper))
		return null;

	if (upper === 'RESET') {
		hooks.reset();
		return '';
	}
	if (upper.startsWith('SAVE')) {
		hooks.save(slotFromName(upper));
		return '';
	}
	if (upper.startsWith('RESTORE') || upper === 'RMF' || upper === 'RCB') {
		hooks.restore(slotFromName(upper));
		return '';
	}
	// OFF / HKEYON / HKEYOFF / TABON / TABOFF
	return '';
}

/**
 * Expand a host-command string.
 *
 * - `^X` (and `` `X ``) produce control characters; `^^`/`` `` `` are
 *   literals.
 * - `$NAME$` is substituted.  Unknown names resolve through hooks.get()
 *   and finally to the empty string.
 * - Template and popup syntax (`[...]`, `((...))`) is not interpreted in
 *   the browser; the text is passed through unchanged.
 */
export function expandVariables(input: string, hooks: VariableHooks): string {
	let out = '';
	for (let i = 0; i < input.length; i++) {
		const c = input[i]!;

		if (c === '^' || c === '`') {
			const next = input[i + 1];
			if (next === c) {
				out += c;
				i++;
				continue;
			}
			if (next !== undefined) {
				const up = next.toUpperCase();
				if (up >= '@' && up <= '_') {
					out += String.fromCharCode(up.charCodeAt(0) - 0x40);
					i++;
					continue;
				}
			}
			out += c;
			continue;
		}

		if (c === '$') {
			const end = input.indexOf('$', i + 1);
			if (end < 0) {
				out += c;
				continue;
			}
			const name = input.slice(i + 1, end);
			const builtin = resolveBuiltin(name, hooks);
			if (builtin !== null) {
				out += builtin;
			}
			else {
				out += hooks.get(name) ?? '';
			}
			i = end;
			continue;
		}

		out += c;
	}
	return out;
}
