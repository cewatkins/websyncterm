// RIPscrip 1.54 interpreter.
//
// Framing follows SyncTERM's ripper.c byte-for-byte: the `!|` introducer,
// ESC[! version query, MegaNum arguments, `|`/CR boundaries, backslash
// continuation/escapes and LF suppression.  Drawing goes to a separate
// pixel layer so it never disturbs the terminal's character cells.

import {
	RipRaster, RIP_FILL_PATTERNS, RIP_LINE_PATTERNS,
	bgiImageSizeOk, type Point, type RasterImage,
} from './graphics.js';
import {
	findDescriptor, parseMegaNumAt, parseRipArgs,
} from './meganum.js';
import { DEFAULT_PALETTE, RipPalette } from './palette.js';
import {
	RIP_VERSION_STRING, expandVariables,
	type RipVariableContext,
} from './variables.js';

export { parseMegaNum } from './meganum.js';
export {
	bezierPolyline, bezierSampleCount, bgiImageSizeOk,
	RIP_FILL_PATTERNS, RIP_LINE_PATTERNS, RipRaster,
} from './graphics.js';
export type { Point, RasterImage, Viewport } from './graphics.js';
export {
	MASTER_PALETTE, DEFAULT_PALETTE, RipPalette, mapColor, masterColor,
} from './palette.js';
export {
	RIP_VERSION_STRING, expandVariables,
	type RipMouseState, type RipVariableContext, type VariableHooks,
} from './variables.js';

export interface RipInterpreterOptions {
	/** Initial 16-colour palette (master palette indices). */
	palette?: number[];
	/** Physical pixel-buffer width.  Defaults to 640. */
	width?: number;
	/** Physical pixel-buffer height.  Defaults to 350. */
	height?: number;
	/** Called after ESC[! / ESC[0! with the 14-byte version reply. */
	onVersion?: () => void;
	/** Called with an expanded host command string. */
	onHostCommand?: (cmd: string) => void;
	/** Called when a $SOUND$ variable is expanded. */
	onSound?: (name: string) => void;
	/** Called with non-RIP bytes that must be fed to the terminal engine. */
	onText?: (text: string) => void;
	/** Called for commands that need filesystem or host access. */
	onUnsupported?: (command: string, reason: string) => void;
	/** Called when RIP_ERASE_WINDOW (`!|e`) is received. */
	onEraseTextWindow?: () => void;
	/** Called when the `!|#` end-of-scene marker arrives. */
	onSceneComplete?: () => void;
	/** Host-supplied variable/mouse/sound environment. */
	variables?: RipVariableContext;
}

export interface RipGraphicsState {
	color: number;
	fillColor: number;
	fillStyle: number;
	fillPattern: number[];
	linePattern: number;
	lineStyle: number;
	lineWidth: number;
	xor: boolean;
	borders: boolean;
	virtualWidth: number;
	virtualHeight: number;
	viewport: { sx: number; sy: number; ex: number; ey: number };
	penX: number;
	penY: number;
	fontNum: number;
	fontVertical: number;
	fontSize: number;
}

export interface RipTextWindow {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	wrap: number;
	size: number;
	active: boolean;
}

interface MouseField {
	kind: 'field' | 'button';
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	invertable: boolean;
	resetAfter: boolean;
	command: string;
	hotkey?: number;
	flags?: number;
}

interface TextRegion {
	sx: number;
	sy: number;
	ex: number;
	ey: number;
	xpos: number;
	ypos: number;
	lineHeight: number;
	active: boolean;
}

const INTRO_BANG = 0x21;
const INTRO_SOH = 0x01;
const INTRO_STX = 0x02;
const PIPE = 0x7c;
const CR = 0x0d;
const LF = 0x0a;
const VT = 0x0b;
const ESC = 0x1b;
const BACKSLASH = 0x5c;

const DEFAULT_TEXT_WINDOW: RipTextWindow = {
	x0: 0, y0: 0, x1: 79, y1: 42, wrap: 1, size: 0, active: true,
};

export class RipInterpreter {
	private readonly opts: RipInterpreterOptions;
	private readonly raster: RipRaster;

	private enabledFlag = false;
	private cmdBuf: number[] = [];
	private escBuf: number[] = [];
	private lastByte = 0;
	private ebc = false;

	private textBuffer = '';
	private replies: Uint8Array[] = [];
	private hostOutput: string[] = [];

	private textCursorX = 0;
	private textCursorY = 0;
	private textWindow: RipTextWindow = { ...DEFAULT_TEXT_WINDOW };
	private textDisabled = false;

	private sceneComplete = false;
	private clipboard: RasterImage | null = null;
	private mouseFields: MouseField[] = [];
	private buttonStyle: number[] = [];
	private buttons: MouseField[] = [];
	private textRegion: TextRegion = {
		sx: -1, sy: -1, ex: -1, ey: -1,
		xpos: 0, ypos: 0, lineHeight: 8, active: false,
	};
	private userVars = new Map<string, string>();
	private deferredGraphicsQuery: string | null = null;
	private deferredTextQuery: string | null = null;

	private lastUnsupported: { command: string; reason: string } | null = null;

	constructor(opts: RipInterpreterOptions = {}) {
		this.opts = opts;
		this.raster = new RipRaster(
			opts.width ?? 640,
			opts.height ?? 350,
			new RipPalette(opts.palette ?? DEFAULT_PALETTE),
		);
	}

	// ---------------------------------------------------------------- API

	get enabled(): boolean {
		return this.enabledFlag;
	}

	/** The text cursor (0-based cells) affected by RIP text commands. */
	get cursor(): { x: number; y: number } {
		return { x: this.textCursorX, y: this.textCursorY };
	}

	get pixelBuffer(): { width: number; height: number; data: Uint32Array } {
		return {
			width: this.raster.width,
			height: this.raster.height,
			data: this.raster.data,
		};
	}

	get pixelWidth(): number {
		return this.raster.width;
	}

	get pixelHeight(): number {
		return this.raster.height;
	}

	/** Current 16-colour palette (master palette indices). */
	get palette(): number[] {
		return this.raster.palette.entries;
	}

	/** Current drawing state, for diagnostics and tests. */
	get graphicsState(): RipGraphicsState {
		const r = this.raster;
		return {
			color: r.color,
			fillColor: r.fillColor,
			fillStyle: r.fillStyle,
			fillPattern: Array.from(r.fillPattern),
			linePattern: r.linePattern,
			lineStyle: r.lineStyle,
			lineWidth: r.lineWidth,
			xor: r.xor,
			borders: r.borders,
			virtualWidth: r.virtualWidth,
			virtualHeight: r.virtualHeight,
			viewport: { ...r.viewport },
			penX: r.penX,
			penY: r.penY,
			fontNum: r.fontNum,
			fontVertical: r.fontVertical,
			fontSize: r.fontSize,
		};
	}

	get textWindowState(): RipTextWindow {
		return { ...this.textWindow };
	}

	get mouseFieldList(): MouseField[] {
		return this.mouseFields.map(f => ({ ...f }));
	}

	get buttonList(): MouseField[] {
		return this.buttons.map(b => ({ ...b }));
	}

	get sceneIsComplete(): boolean {
		return this.sceneComplete;
	}

	get unsupportedCommand(): { command: string; reason: string } | null {
		return this.lastUnsupported;
	}

	/**
	 * Dispatch a command left pending at the end of a stream (for example a
	 * scene file that does not end with CR).  Do not call this between
	 * chunks of a live connection.
	 */
	flush(): void {
		if (this.cmdBuf.length > 1) {
			this.dispatch();
			this.ebc = true;
		}
		else {
			this.cmdBuf.length = 0;
		}
	}

	/** Drain non-RIP bytes that must be handed to the terminal engine. */
	takeText(): string {
		const out = this.textBuffer;
		this.textBuffer = '';
		return out;
	}

	/** Drain queued replies (currently only the version query reply). */
	takeReplies(): Uint8Array[] {
		const out = this.replies;
		this.replies = [];
		return out;
	}

	/** Drain host-command strings produced since the last call. */
	takeHostOutput(): string[] {
		const out = this.hostOutput;
		this.hostOutput = [];
		return out;
	}

	/** Full reset: clears the pixel layer and all interpreter state. */
	reset(): void {
		this.raster.resetState();
		this.raster.data.fill(this.raster.colorRGB(0));
		this.enabledFlag = false;
		this.cmdBuf.length = 0;
		this.escBuf.length = 0;
		this.lastByte = 0;
		this.ebc = false;
		this.textBuffer = '';
		this.replies = [];
		this.hostOutput = [];
		this.textCursorX = 0;
		this.textCursorY = 0;
		this.textWindow = { ...DEFAULT_TEXT_WINDOW };
		this.textDisabled = false;
		this.sceneComplete = false;
		this.clipboard = null;
		this.mouseFields = [];
		this.buttonStyle = [];
		this.buttons = [];
		this.textRegion = {
			sx: -1, sy: -1, ex: -1, ey: -1,
			xpos: 0, ypos: 0, lineHeight: 8, active: false,
		};
		this.userVars.clear();
		this.deferredGraphicsQuery = null;
		this.deferredTextQuery = null;
		this.lastUnsupported = null;
	}

	// ------------------------------------------------------------ framing

	/** Feed bytes received from the host. */
	feed(data: Uint8Array): void {
		const before = this.textBuffer.length;
		for (let i = 0; i < data.length; i++)
			this.feedByte(data[i]!);
		if (this.opts.onText && this.textBuffer.length > before) {
			const chunk = this.textBuffer.slice(before);
			// When the callback is used, don't also grow the takeText()
			// queue indefinitely.
			this.textBuffer = this.textBuffer.slice(0, before);
			this.opts.onText(chunk);
		}
	}

	private emitText(s: string): void {
		this.textBuffer += s;
	}

	private emitByte(b: number): void {
		this.textBuffer += String.fromCharCode(b & 0xff);
	}

	private feedByte(b: number): void {
		// ESC accumulator: always active so ESC[! can enable RIP.
		if (this.escBuf.length > 0) {
			this.escFeed(b);
			return;
		}
		if (b === ESC && this.cmdBuf.length === 0) {
			this.escBuf.push(ESC);
			return;
		}

		if (!this.enabledFlag) {
			this.passthrough(b);
			return;
		}

		if (this.cmdBuf.length === 0) {
			if (this.acceptIntroducer(b)) {
				this.cmdBuf.push(b);
				return;
			}
			this.passthrough(b);
			return;
		}

		// A lone introducer that isn't followed by '|' is ordinary text.
		// A lone '|' is a fresh (empty) command, so it falls through.
		if (this.cmdBuf.length === 1 && b !== PIPE) {
			const b0 = this.cmdBuf[0]!;
			if (b0 === INTRO_BANG || b0 === INTRO_SOH || b0 === INTRO_STX) {
				this.cmdBuf.length = 0;
				this.ebc = false;
				this.emitByte(b0);
				this.passthrough(b);
				return;
			}
		}

		// LF is swallowed mid-command.
		if (b === LF)
			return;

		if (b === CR) {
			const nbs = this.trailingBackslashes();
			if (nbs & 1) {
				this.cmdBuf.pop();
				return;
			}
			this.dispatch();
			this.ebc = true;
			return;
		}

		if (b === PIPE) {
			const nbs = this.trailingBackslashes();
			if (nbs & 1) {
				this.cmdBuf.push(b);
				return;
			}
			this.dispatch();
			this.cmdBuf.push(PIPE);
			return;
		}

		this.cmdBuf.push(b);
	}

	private acceptIntroducer(b: number): boolean {
		if (b !== INTRO_BANG && b !== INTRO_SOH && b !== INTRO_STX)
			return false;
		if (this.lastByte === BACKSLASH)
			return false;
		if (b === INTRO_SOH || b === INTRO_STX)
			return true;
		// '!' is only valid at the beginning of a line, or when the text
		// cursor is already at column 1.
		const w = this.lastByte;
		if (w === 0 || w === CR || w === LF || w === VT)
			return true;
		return this.textCursorX === 0;
	}

	private trailingBackslashes(): number {
		let n = 0;
		for (let i = this.cmdBuf.length - 1; i >= 0 && this.cmdBuf[i] === BACKSLASH; i--)
			n++;
		return n;
	}

	private passthrough(b: number): void {
		if (this.ebc) {
			this.ebc = false;
			if (b !== VT)
				return;
		}
		if (this.textDisabled) {
			this.lastByte = b;
			return;
		}
		if (b === 0x0e || b === 0x0f) {
			this.lastByte = b;
			return;
		}
		this.emitByte(b);
		this.updateTextCursor(b);
		this.lastByte = b;
	}

	private updateTextCursor(b: number): void {
		if (b === CR) {
			this.textCursorX = 0;
		}
		else if (b === LF) {
			this.textCursorY++;
		}
		else if (b === 0x08) {
			if (this.textCursorX > 0)
				this.textCursorX--;
		}
		else if (b === 0x09) {
			this.textCursorX = (Math.floor(this.textCursorX / 8) + 1) * 8;
		}
		else if (b >= 0x20 && b !== 0x7f) {
			this.textCursorX++;
		}
	}

	// ------------------------------------------------------- ESC handling

	private escFeed(b: number): void {
		if (this.escBuf.length === 1) {
			if (b === 0x5b) {
				this.escBuf.push(b);
				return;
			}
			this.flushEsc(b);
			return;
		}

		if (b === 0x21) {
			this.escBuf.push(b);
			this.handleEscSequence(this.escBuf);
			this.escBuf = [];
			return;
		}

		if (((b >= 0x30 && b <= 0x39) || b === 0x3b) && this.escBuf.length < 32) {
			this.escBuf.push(b);
			return;
		}

		this.flushEsc(b);
	}

	private flushEsc(b: number): void {
		for (const c of this.escBuf)
			this.emitByte(c);
		this.escBuf = [];
		this.updateTextCursor(b);
		this.emitByte(b);
	}

	private handleEscSequence(seq: number[]): void {
		// ESC [ !            -- version query
		// ESC [ 0 !          -- version query
		// ESC [ 1 !          -- disable RIP for the session
		// ESC [ 2 !          -- no-op
		if (seq.length === 3) {
			this.enabledFlag = true;
			this.sendVersionReply();
			return;
		}
		if (seq.length === 4 && seq[2] === 0x30) {
			this.enabledFlag = true;
			this.sendVersionReply();
			return;
		}
		if (seq.length === 4 && seq[2] === 0x31) {
			this.enabledFlag = false;
			this.cmdBuf.length = 0;
			return;
		}
		if (seq.length === 4 && seq[2] === 0x32)
			return;
		// ESC [ <n> ; ... ! is SkyPix, which requires host image access.
		this.unsupported('skypix', 'SkyPix image loading is not supported in the browser');
	}

	private sendVersionReply(): void {
		const bytes = new Uint8Array(RIP_VERSION_STRING.length);
		for (let i = 0; i < RIP_VERSION_STRING.length; i++)
			bytes[i] = RIP_VERSION_STRING.charCodeAt(i) & 0xff;
		this.replies.push(bytes);
		this.opts.onVersion?.();
	}

	// ------------------------------------------------------------ dispatch

	private static unescape(raw: number[]): number[] {
		const out: number[] = [];
		for (let i = 0; i < raw.length; i++) {
			const c = raw[i]!;
			if (c === BACKSLASH && i + 1 < raw.length) {
				const nx = raw[i + 1]!;
				out.push(nx === PIPE ? 0xff : nx);
				i++;
			}
			else {
				out.push(c);
			}
		}
		return out;
	}

	private dispatch(): void {
		const raw = this.cmdBuf;
		this.cmdBuf = [];
		if (raw.length < 2)
			return;

		const buf = RipInterpreter.unescape(raw);
		if (buf.length < 2)
			return;

		let p = 0;
		const b0 = buf[0]!;
		if (b0 === INTRO_BANG || b0 === INTRO_SOH || b0 === INTRO_STX) {
			if (buf[1] !== PIPE)
				return;
			p = 2;
		}
		else if (b0 === PIPE) {
			p = 1;
		}
		else {
			return;
		}

		let level = 0;
		let sublevel = 0;
		if (p < buf.length && buf[p]! >= 0x31 && buf[p]! <= 0x39) {
			level = buf[p]! - 0x30;
			p++;
			if (p < buf.length && buf[p]! >= 0x31 && buf[p]! <= 0x39) {
				sublevel = buf[p]! - 0x30;
				p++;
			}
		}
		if (p >= buf.length)
			return;

		const cmd = buf[p]!;
		p++;

		let args = '';
		for (let i = p; i < buf.length; i++) {
			const c = buf[i]!;
			args += c === 0xff ? '|' : String.fromCharCode(c);
		}

		this.runCommand(level, sublevel, cmd, args);
	}

	private runCommand(level: number, sublevel: number, cmd: number, args: string): void {
		const desc = findDescriptor(level, cmd);
		const parsed = parseRipArgs(args, desc);
		if (parsed === null)
			return;
		const v = parsed.values;

		if (level === 0 && sublevel === 0) {
			this.runLevel0(cmd, args, v, parsed.text);
			return;
		}
		if (level === 1 && sublevel === 0) {
			this.runLevel1(cmd, args, v, parsed.text);
			return;
		}
		if (level === 9 && sublevel === 0 && cmd === ESC) {
			this.unsupported('9<esc>', 'RIP block-mode file transfer is not supported in the browser');
			return;
		}
		if (level !== 0) {
			this.unsupported(
				`${level}${sublevel ? sublevel : ''}${String.fromCharCode(cmd)}`,
				'unsupported RIPscrip command level',
			);
		}
	}

	private unsupported(command: string, reason: string): void {
		this.lastUnsupported = { command, reason };
		this.opts.onUnsupported?.(command, reason);
	}

	// ------------------------------------------------------------- level 0

	private runLevel0(cmd: number, args: string, v: number[], text: string | null): void {
		const r = this.raster;
		switch (String.fromCharCode(cmd)) {
			case '#':
				this.sceneComplete = true;
				this.opts.onSceneComplete?.();
				break;
			case '$':
			case '=':
				this.lineStyle(v);
				break;
			case '*':
				this.resetWindows();
				break;
			case '>':
				// Erase to end of line: the terminal owns character cells.
				this.emitText('\x1b[K');
				break;
			case '@':
				if (v.length < 2) break;
				r.penX = v[0]!;
				r.penY = v[1]!;
				r.drawText(text ?? ' ');
				break;
			case 'A':
				if (v.length < 5) break;
				r.fullEllipse(v[0]!, v[1]!, v[2]!, v[3]!,
					v[4]!, this.aspectRadius(v[4]!), false, r.color);
				break;
			case 'B':
				if (v.length < 4) break;
				this.fillRect(v[0]!, v[1]!, v[2]!, v[3]!);
				break;
			case 'C': {
				if (v.length < 3) break;
				const ry = this.aspectRadius(v[2]!);
				r.fullEllipse(v[0]!, v[1]!, 0, 360, v[2]!, ry, false, r.color);
				break;
			}
			case 'E':
				r.eraseViewport();
				break;
			case 'F':
				if (v.length < 3) break;
				if (r.noViewport()) break;
				if (v[0]! > r.viewport.ex - r.viewport.sx) break;
				if (v[1]! > r.viewport.ey - r.viewport.sy) break;
				if (v[2]! > 255) break;
				r.floodFill(v[0]!, v[1]!, v[2]!);
				break;
			case 'H':
				this.textCursorX = 0;
				this.textCursorY = 0;
				break;
			case 'I':
				if (v.length < 5) break;
				r.pieSlice(v[0]!, v[1]!, v[2]!, v[3]!,
					v[4]!, this.aspectRadius(v[4]!), r.color);
				break;
			case 'K':
				if (v.length < 4) break;
				this.fillRect(v[0]!, v[1]!, v[2]!, v[3]!);
				if (r.borders) {
					const [x0, y0, x1, y1] = this.normaliseRect(v[0]!, v[1]!, v[2]!, v[3]!);
					r.drawLine(x0, y0, x1, y0);
					r.drawLine(x1, y0, x1, y1);
					r.drawLine(x1, y1, x0, y1);
					r.drawLine(x0, y1, x0, y0);
				}
				break;
			case 'L':
				if (v.length < 4) break;
				r.drawLine(v[0]!, v[1]!, v[2]!, v[3]!, { xor: r.xor });
				break;
			case 'N':
				if (v.length < 1) break;
				r.borders = v[0] !== 0;
				break;
			case 'O':
			case 'V':
				if (v.length < 6) break;
				r.fullEllipse(v[0]!, v[1]!, v[2]!, v[3]!,
					v[4]!, v[5]!, false, r.color);
				break;
			case 'P':
				this.polygon(v, false);
				break;
			case 'Q':
				this.setPalette(v);
				break;
			case 'R':
				if (v.length < 4) break;
				r.drawLine(v[0]!, v[1]!, v[2]!, v[1]!, { xor: r.xor });
				r.drawLine(v[2]!, v[1]!, v[2]!, v[3]!, { xor: r.xor });
				r.drawLine(v[2]!, v[3]!, v[0]!, v[3]!, { xor: r.xor });
				r.drawLine(v[0]!, v[3]!, v[0]!, v[1]!, { xor: r.xor });
				break;
			case 'S':
				if (v.length < 2) break;
				if (v[0]! > 0x0b) break;
				if (v[1]! > 255) break;
				r.fillColor = v[1]! & 0x0f;
				r.fillStyle = v[0]!;
				r.fillPattern.set(RIP_FILL_PATTERNS[v[0]!] ?? RIP_FILL_PATTERNS[0]!);
				break;
			case 'T':
				r.drawText(text ?? ' ');
				break;
			case 'W':
				if (v.length < 1) break;
				if (v[0] === 0) r.xor = false;
				else if (v[0] === 1) r.xor = true;
				break;
			case 'X':
				if (v.length < 2) break;
				r.setPixelRel(v[0]!, v[1]!, r.color);
				break;
			case 'Y':
				if (v.length < 3) break;
				if (v[0]! <= 10) r.fontNum = v[0]!;
				if (v[1]! >= 0) r.fontVertical = v[1]!;
				if (v[2]! > 0 && v[2]! <= 10) r.fontSize = v[2]!;
				break;
			case 'Z': {
				if (v.length < 9) break;
				// cnt <= 0 selects 1020 (RIPterm bug).
				r.drawBezier(v[0]!, v[1]!, v[2]!, v[3]!,
					v[4]!, v[5]!, v[6]!, v[7]!, v[8]!);
				break;
			}
			case 'a':
				if (v.length < 2) break;
				if (v[0]! > 15) break;
				if (v[1]! > 63) break;
				this.onePalette(v[0]!, v[1]!);
				break;
			case 'b':
				this.extendedTextWindow(v);
				break;
			case 'c':
				if (v.length < 1) break;
				if (v[0]! <= 255) r.color = v[0]! & 0x0f;
				break;
			case 'e':
				if (this.textDisabled)
					break;
				this.textCursorX = 0;
				this.textCursorY = 0;
				this.opts.onEraseTextWindow?.();
				break;
			case 'f':
				if (v.length < 2) break;
				if (v[0]! < 1 || v[1]! < 1) break;
				r.virtualWidth = v[0]!;
				r.virtualHeight = v[1]!;
				r.viewport = {
					sx: 0, sy: 0,
					ex: v[0]! - 1, ey: v[1]! - 1,
				};
				break;
			case 'g':
				if (v.length < 2) break;
				this.textCursorX = v[0]!;
				this.textCursorY = v[1]!;
				break;
			case 'i':
				if (v.length < 6) break;
				r.ovalPieSlice(v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!, r.color);
				break;
			case 'j':
				if (v.length < 2) break;
				r.drawLine(v[0]!, v[1]!, v[0]!, v[1]!, { xor: r.xor });
				break;
			case 'l':
				this.polyline(v);
				break;
			case 'm':
				if (v.length < 2) break;
				if (v[0]! > r.viewport.ex - r.viewport.sx + 1) break;
				if (v[1]! > r.viewport.ey - r.viewport.sy + 1) break;
				r.penX = v[0]!;
				r.penY = v[1]!;
				break;
			case 'o':
				if (v.length < 4) break;
				r.fullEllipse(v[0]!, v[1]!, 0, 360, v[2]!, v[3]!, true, r.color);
				break;
			case 'p':
				this.polygon(v, true);
				break;
			case 's':
				if (v.length < 9) break;
				for (let i = 0; i < 8; i++)
					r.fillPattern[i] = v[i]! & 0xff;
				if (v[8]! < 0 || v[8]! > 255) break;
				r.fillColor = v[8]!;
				r.fillStyle = -1;
				break;
			case 't':
				this.polyBezier(args, false, false);
				break;
			case 'v':
				if (v.length < 4) break;
				if (v[0] === 0 && v[1] === 0 && v[2] === 0 && v[3] === 0) {
					r.viewport = { sx: 0, sy: 0, ex: 0, ey: 0 };
					break;
				}
				{
					let x0 = v[0]!, y0 = v[1]!, x1 = v[2]!, y1 = v[3]!;
					if (x1 >= r.virtualWidth) x1 = r.virtualWidth - 1;
					if (y1 >= r.virtualHeight) y1 = r.virtualHeight - 1;
					if (x0 >= x1 || y0 >= y1) break;
					r.viewport = { sx: x0, sy: y0, ex: x1, ey: y1 };
				}
				break;
			case 'w':
				this.ripTextWindow(v);
				break;
			case 'x':
				this.polyBezier(args, true, true);
				break;
			case 'z':
				this.polyBezier(args, false, true);
				break;
			case '\x1b':
				this.unsupported('0<esc>', 'RIP SkyPix command is not supported in the browser');
				break;
			default:
				this.unsupported(String.fromCharCode(cmd), 'unsupported RIPscrip command');
				break;
		}
	}

	// ------------------------------------------------------------- level 1

	private runLevel1(cmd: number, args: string, v: number[], text: string | null): void {
		switch (String.fromCharCode(cmd)) {
			case '\x1b': {
				if (v.length < 1 || text === null) break;
				if (v[0] === 0) {
					this.handleCommandString(text);
				}
				else if (v[0] === 1) {
					this.deferredGraphicsQuery = text === '$OFF$' ? null : text;
				}
				else if (v[0] === 2) {
					this.deferredTextQuery = text === '$OFF$' ? null : text;
				}
				else {
					this.unsupported('1<esc>', `unknown query mode ${v[0]}`);
				}
				break;
			}
			case 'B':
				this.buttonStyle = v.slice();
				break;
			case 'C':
				this.getImage(v);
				break;
			case 'D':
				if (text === null) break;
				this.defineVariable(v, text);
				break;
			case 'E':
				this.textRegion = {
					sx: -1, sy: -1, ex: -1, ey: -1,
					xpos: 0, ypos: 0, lineHeight: this.raster.fontHeight(), active: false,
				};
				break;
			case 'F':
				if (v.length < 2 || text === null) break;
				if (v[0]! > 4) break;
				this.unsupported('1F', 'RIP file queries require host filesystem access');
				this.replies.push(encodeLatin1(v[0] === 0 ? '0' : '0\r\n'));
				break;
			case 'G':
				this.unsupported('1G', 'RIP scroll-copy regions are not supported in the browser');
				break;
			case 'I':
				this.unsupported('1I', 'RIP icon loading requires host filesystem access');
				break;
			case 'K':
				this.mouseFields = [];
				break;
			case 'M': {
				if (v.length < 7) break;
				if (v[3]! > this.raster.viewport.ex - this.raster.viewport.sx) break;
				if (v[4]! > this.raster.viewport.ey - this.raster.viewport.sy) break;
				if (v[5]! > 1 || v[6]! > 1) break;
				this.mouseFields.push({
					kind: 'field',
					x0: v[1]! + this.raster.viewport.sx,
					y0: v[2]! + this.raster.viewport.sy,
					x1: v[3]! + this.raster.viewport.sx,
					y1: v[4]! + this.raster.viewport.sy,
					invertable: v[5] !== 0,
					resetAfter: v[6] !== 0,
					command: text ?? '',
				});
				break;
			}
			case 'P':
				this.putImage(v);
				break;
			case 'R':
				this.unsupported('1R', 'RIP scene playback requires host filesystem access');
				break;
			case 'T':
				if (v.length < 4) break;
				this.textRegion = {
					sx: v[0]!, sy: v[1]!, ex: v[2]!, ey: v[3]!,
					xpos: 0, ypos: 0,
					lineHeight: this.raster.fontHeight(),
					active: true,
				};
				break;
			case 't':
				if (v.length < 1 || text === null) break;
				this.regionText(v[0]!, text);
				break;
			case 'U': {
				if (v.length < 7) break;
				this.buttons.push({
					kind: 'button',
					x0: v[0]!, y0: v[1]!, x1: v[2]!, y1: v[3]!,
					hotkey: v[4]!,
					flags: v[5]!,
					invertable: true,
					resetAfter: false,
					command: text ?? '',
				});
				break;
			}
			case 'W':
				this.unsupported('1W', 'RIP icon writing requires host filesystem access');
				break;
			default:
				this.unsupported(`1${String.fromCharCode(cmd)}`, 'unsupported RIPscrip level 1 command');
				break;
		}
	}

	// ------------------------------------------------------- text windowing

	private ripTextWindow(v: number[]): void {
		if (v.length < 6) return;
		if (v[0] === 0 && v[1] === 0 && v[2] === 0 && v[3] === 0) {
			this.textDisabled = true;
			this.textWindow = { ...this.textWindow, active: false };
			return;
		}
		this.textDisabled = false;
		if (v[4]! < 0 || v[4]! > 1) return;
		let size = v[5]!;
		if (size < 0 || size > 4) size = 0;
		this.textWindow = {
			x0: v[0]!, y0: v[1]!, x1: v[2]!, y1: v[3]!,
			wrap: v[4]!, size, active: true,
		};
		this.textCursorX = 0;
		this.textCursorY = 0;
	}

	private extendedTextWindow(v: number[]): void {
		if (v.length < 8) return;
		const x0 = v[0]!, y0 = v[1]!, x1 = v[2]!, y1 = v[3]!;
		const cols = v[4]!, rows = v[5]!, font = v[6]!, flags = v[7]!;
		if (cols <= 0 || rows <= 0) return;

		const maxwidth = (!(flags & 0x10) && font !== 4) ? 8 : 16;
		const cellW = maxwidth === 16 ? 16 : (font === 4 ? 16 : (font === 1 || font === 3 ? 7 : 8));
		const cellH = font === 0 || font === 1 ? 8 : 14;
		this.textDisabled = false;
		this.textWindow = {
			x0: Math.floor(x0 / cellW),
			y0: Math.floor(y0 / cellH),
			x1: Math.floor(x0 / cellW) + cols - 1,
			y1: Math.floor(y0 / cellH) + rows - 1,
			wrap: (flags & 0x01) ? 1 : 0,
			size: font === 0 ? 0 : (font === 1 ? 1 : 2),
			active: true,
		};
		this.textCursorX = 0;
		this.textCursorY = 0;
		if (flags & 0x20) {
			for (let y = y0; y <= y1; y++)
				for (let x = x0; x <= x1; x++)
					this.raster.setPixelAbs(x, y, 0);
		}
	}

	private regionText(justify: number, text: string): void {
		const region = this.textRegion;
		if (!region.active) return;
		const r = this.raster;
		const oldX = r.penX;
		const oldY = r.penY;
		const oldDir = r.fontVertical;

		r.fontVertical = 0;
		r.penX = region.sx + region.xpos - r.viewport.sx;
		r.penY = region.sy + region.ypos - r.viewport.sy;

		const words = text.split(' ');
		const nonEmpty = words.filter(w => w.length > 0);
		if (justify === 0 || nonEmpty.length < 2) {
			r.drawText(text);
		}
		else {
			const regionW = region.ex - region.sx + 1;
			const textW = r.textWidth(text);
			const slack = regionW - textW;
			const step = nonEmpty.length > 1 ? slack / (nonEmpty.length - 1) : slack;
			let first = true;
			for (const word of nonEmpty) {
				if (!first) {
					r.drawText(' '.repeat(Math.max(0, Math.trunc(step))));
				}
				r.drawText(word);
				first = false;
			}
		}

		region.ypos += region.lineHeight + 3;
		r.penX = oldX;
		r.penY = oldY;
		r.fontVertical = oldDir;
	}

	// ------------------------------------------------------ host variables

	private expandHostText(input: string): string {
		const ctx = this.opts.variables;
		return expandVariables(input, {
			get: (name) => this.userVars.get(name) ?? ctx?.get(name),
			mouse: ctx?.mouse,
			sound: (name) => {
				this.opts.onSound?.(name);
				ctx?.sound?.(name);
			},
			reset: () => this.resetWindows(),
			save: (slot) => ctx?.save?.(slot),
			restore: (slot) => ctx?.restore?.(slot),
		});
	}

	private handleCommandString(cmd: string): void {
		const expanded = this.expandHostText(cmd);
		if (this.opts.onHostCommand)
			this.opts.onHostCommand(expanded);
		else
			this.hostOutput.push(expanded);
	}

	private defineVariable(v: number[], text: string): void {
		const colon = text.indexOf(':');
		if (colon < 0) {
			this.unsupported('1D', 'malformed RIP_DEFINE text');
			return;
		}
		const head = text.slice(0, colon);
		const comma = head.indexOf(',');
		let name = comma >= 0 ? head.slice(0, comma) : head;
		let width = 60;
		if (comma >= 0) {
			const w = Number.parseInt(head.slice(comma + 1), 10);
			if (Number.isFinite(w))
				width = Math.max(1, Math.min(255, w));
		}
		name = name.trim();
		if (!/^[A-Za-z][A-Za-z0-9_]{0,11}$/.test(name)) {
			this.unsupported('1D', 'invalid RIP variable name');
			return;
		}
		void width;
		let rest = text.slice(colon + 1);
		if (rest.startsWith('?')) {
			const end = rest.indexOf('?', 1);
			if (end >= 0)
				rest = rest.slice(end + 1);
		}
		const defaultValue = rest.length > 0 ? rest : null;
		const flags = v[0] ?? 0;
		const nonInteractive = (flags & 0x04) !== 0;
		const existing = this.userVars.get(name);

		if (nonInteractive) {
			if (existing !== undefined) {
				if (defaultValue !== null)
					this.userVars.set(name, defaultValue);
			}
			else if (defaultValue !== null) {
				this.userVars.set(name, defaultValue);
			}
			else {
				this.unsupported('1D', 'interactive variable definition requires host input');
			}
			return;
		}
		if (defaultValue !== null) {
			this.userVars.set(name, defaultValue);
		}
		else {
			this.unsupported('1D', 'interactive variable definition requires host input');
		}
	}

	// ----------------------------------------------------------- primitives

	private aspectRadius(radius: number): number {
		const r = this.raster;
		if (r.virtualWidth === 640 && r.virtualHeight === 350)
			return Math.trunc((radius * 7750) / 10000);
		return Math.trunc((radius * (r.virtualWidth / r.virtualHeight)) / (4 / 3));
	}

	private normaliseRect(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
		if (x0 > x1) [x0, x1] = [x1, x0];
		if (y0 > y1) [y0, y1] = [y1, y0];
		return [x0, y0, x1, y1];
	}

	private fillRect(x0: number, y0: number, x1: number, y1: number): void {
		const [ax, ay, bx, by] = this.normaliseRect(x0, y0, x1, y1);
		for (let y = ay; y <= by; y++)
			for (let x = ax; x <= bx; x++)
				this.raster.fillPixelRel(x, y);
	}

	private lineStyle(v: number[]): void {
		if (v.length < 3) return;
		if (v[0]! > 4) return;
		if (v[2]! > 3) return;
		const userPattern = v[1]! & 0xffff;
		const r = this.raster;
		r.linePattern = v[0]! < 4
			? RIP_LINE_PATTERNS[v[0]!]!
			: userPattern;
		r.lineStyle = v[0]!;
		r.lineWidth = v[2]!;
	}

	private polygon(v: number[], filled: boolean): void {
		const r = this.raster;
		if (r.noViewport()) return;
		if (v.length <= 1) return;
		if ((v.length - 1) & 1) return;
		const npoints = v[0]!;
		const pts: Point[] = [];
		for (let i = 0; i < npoints && 2 + i * 2 < v.length; i++)
			pts.push({ x: v[1 + i * 2]!, y: v[2 + i * 2]! });
		if (pts.length < 2) return;
		r.drawPolygon(pts, filled);
	}

	private polyline(v: number[]): void {
		const r = this.raster;
		if (r.noViewport()) return;
		if (v.length <= 1) return;
		if ((v.length - 1) & 1) return;
		const npoints = v[0]!;
		const pts: Point[] = [];
		for (let i = 0; i < npoints && 2 + i * 2 < v.length; i++)
			pts.push({ x: v[1 + i * 2]!, y: v[2 + i * 2]! });
		if (pts.length < 2) return;
		r.drawPolyline(pts);
	}

	/**
	 * Poly-Bezier commands (`!|t`, `!|z`, `!|x`).  These have no
	 * descriptor and are parsed by hand, exactly like upstream.
	 */
	private polyBezier(args: string, filled: boolean, closed: boolean): void {
		const r = this.raster;
		const numGot = parseMegaNumAt(args, 0, 2);
		if (numGot === null) return;
		const num = numGot.value;
		const countGot = parseMegaNumAt(args, 2, 2);
		if (countGot === null || countGot.value <= 0) return;
		const count = countGot.value;
		const sxGot = parseMegaNumAt(args, 5, 2);
		if (sxGot === null) return;
		const syGot = parseMegaNumAt(args, 7, 2);
		if (syGot === null) return;
		const sx = sxGot.value;
		const sy = syGot.value;

		let lx = sx;
		let ly = sy;
		let ch = 4;
		let lastWasBezier = false;

		for (let i = 0; i < num; i++) {
			const typeGot = parseMegaNumAt(args, ch, 1);
			if (typeGot === null) return;
			const type = typeGot.value;
			ch++;
			if (type === 0) {
				const x1 = parseMegaNumAt(args, ch, 2);
				const y1 = parseMegaNumAt(args, ch + 2, 2);
				if (x1 === null || y1 === null) return;
				ch += 4;
				if (!lastWasBezier) {
					r.drawLine(lx, ly, x1.value, y1.value, {
						pattern: r.linePattern, width: r.lineWidth,
					});
				}
				lx = x1.value;
				ly = y1.value;
				lastWasBezier = false;
			}
			else if (type === 1 || type === 2 || type === 5 || type === 6) {
				const p1 = parseMegaNumAt(args, ch, 2);
				const p2 = parseMegaNumAt(args, ch + 2, 2);
				const p3 = parseMegaNumAt(args, ch + 4, 2);
				const p4 = parseMegaNumAt(args, ch + 6, 2);
				const p5 = parseMegaNumAt(args, ch + 8, 2);
				const p6 = parseMegaNumAt(args, ch + 10, 2);
				if (p1 === null || p2 === null || p3 === null
					|| p4 === null || p5 === null || p6 === null)
					return;
				ch += 12;
				let x4: number;
				let y4: number;
				if (ch >= args.length || args.charCodeAt(ch) === 0) {
					x4 = sx;
					y4 = sy;
				}
				else {
					const gx = parseMegaNumAt(args, ch + 1, 2);
					const gy = parseMegaNumAt(args, ch + 3, 2);
					if (gx === null || gy === null) return;
					x4 = gx.value;
					y4 = gy.value;
				}
				r.drawBezier(p1.value, p2.value, p3.value, p4.value,
					p5.value, p6.value, x4, y4, count);
				lx = x4;
				ly = y4;
				lastWasBezier = true;
			}
			else {
				return;
			}
		}

		if (closed && (lx !== sx || ly !== sy)) {
			r.drawLine(lx, ly, sx, sy, {
				pattern: r.linePattern, width: r.lineWidth,
			});
		}
		if (filled) {
			// RIPterm fills the resulting closed region.  The browser
			// implementation leaves the outline intact; a true area fill
			// would need the original marker-based do_fill algorithm.
			this.unsupported('poly-bezier-fill', 'filled poly-Bezier is not yet supported');
		}
	}

	// ------------------------------------------------------------- palette

	private setPalette(v: number[]): void {
		if (v.length < 16) return;
		const oldColors = this.paletteColors();
		for (let i = 0; i < 16; i++) {
			if (v[i]! < 0 || v[i]! > 63)
				break;
			this.raster.palette.setOne(i, v[i]!);
		}
		this.remapPalette(oldColors);
	}

	private onePalette(index: number, value: number): void {
		const oldColors = this.paletteColors();
		this.raster.palette.setOne(index, value);
		this.remapPalette(oldColors);
	}

	private paletteColors(): number[] {
		const out: number[] = [];
		for (let i = 0; i < 16; i++)
			out.push(this.raster.colorRGB(i));
		return out;
	}

	private remapPalette(oldColors: number[]): void {
		const r = this.raster;
		const newColors = this.paletteColors();
		const data = r.data;
		for (let i = 0; i < data.length; i++) {
			const pix = data[i]!;
			for (let c = 0; c < 16; c++) {
				if (pix === oldColors[c]) {
					data[i] = newColors[c]!;
					break;
				}
			}
		}
	}

	// ---------------------------------------------------------- clipboard

	private getImage(v: number[]): void {
		if (v.length < 5) return;
		const [x0, y0, x1, y1] = this.normaliseRect(v[0]!, v[1]!, v[2]!, v[3]!);
		if (!bgiImageSizeOk(x1 - x0 + 1, y1 - y0 + 1)) {
			// RIPterm's "Image too large" dialog side effects.
			const r = this.raster;
			r.color = 7;
			r.fillColor = 8;
			r.fillStyle = 1;
			r.lineWidth = 1;
			r.lineStyle = 0;
			r.linePattern = 0xffff;
			r.xor = false;
			return;
		}
		this.clipboard = this.raster.capture(x0, y0, x1, y1);
	}

	private putImage(v: number[]): void {
		if (v.length < 4) return;
		if (v[2]! > 4) {
			this.unsupported('1P', `unknown put-image mode ${v[2]}`);
			return;
		}
		const clip = this.clipboard;
		if (clip === null) return;
		const r = this.raster;
		const vx = v[0]! + r.viewport.sx;
		const vy = v[1]! + r.viewport.sy;
		if (r.mapX(vx) + clip.width - 1 > r.mapX(r.viewport.ex)) return;
		if (r.mapY(vy) + clip.height - 1 > r.mapY(r.viewport.ey)) return;
		r.blit(clip, v[0]!, v[1]!, v[2]!);
	}

	// -------------------------------------------------------- scene reset

	/**
	 * `!|*` / RIP_RESET_WINDOWS.  Deliberately preserves the current
	 * colour, line style, line width and clipboard (RIPterm does).
	 */
	private resetWindows(): void {
		const r = this.raster;
		const oldColors = this.paletteColors();
		this.mouseFields = [];
		r.virtualWidth = 640;
		r.virtualHeight = 350;
		r.viewport = { sx: 0, sy: 0, ex: 639, ey: 349 };
		r.borders = true;
		this.textDisabled = false;
		this.textWindow = { ...DEFAULT_TEXT_WINDOW };
		this.textCursorX = 0;
		this.textCursorY = 0;
		r.palette.reset();
		this.remapPalette(oldColors);
		r.data.fill(r.colorRGB(0));
	}
}

function encodeLatin1(s: string): Uint8Array {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++)
		out[i] = s.charCodeAt(i) & 0xff;
	return out;
}
