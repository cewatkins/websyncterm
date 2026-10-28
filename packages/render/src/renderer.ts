/**
 * Canvas2D renderer for a SyncTERM screen buffer.
 *
 * Cells are painted from a pre-tinted glyph atlas with one `drawImage()` per
 * character; only the cells that changed since the previous frame (plus the
 * old/new cursor cells) are repainted. Sixel graphics are decoded once into an
 * offscreen canvas and composited beneath the text layer.
 */

import type { CursorStyleName, Palette, ScreenBuffer } from '@websyncterm/core';
import {
	BitmapFont,
	buildGlyphAtlas,
	createCanvas2D,
	drawGlyphDirect,
	get2DContext,
	rgbToCss,
	tintGlyphAtlas,
	unicodeToGlyphIndex,
	type Context2D,
	type GlyphAtlas,
	type RenderCanvas,
} from './font.js';
import { CRTPostProcessor, type CRTOptions } from './crt.js';
import { resolveVideoMode, type VideoMode } from './scaler.js';

/* Attribute bits, matching AttrFlags in @websyncterm/core. */
const FLAG_BLINK = 1 << 0;
const FLAG_BOLD = 1 << 1;
const FLAG_REVERSE = 1 << 2;
const FLAG_CONCEALED = 1 << 3;
const FLAG_TRUE_FG = 1 << 4;
const FLAG_TRUE_BG = 1 << 5;

/** A sixel image as produced by `CTerm.sixelPixels`. */
export interface SixelOverlay {
	/** Palette index per pixel; -1 is transparent. */
	pixels: Int32Array;
	width: number;
	height: number;
	baseX: number;
	baseY: number;
	cw?: number;
	ch?: number;
}

/** Cursor state passed to {@link Renderer.render}. */
export interface RenderCursor {
	x: number;
	y: number;
	style?: CursorStyleName;
	visible?: boolean;
}

/** Per-frame render options. */
export interface RenderOptions {
	/** Force the blink phase (otherwise derived from the clock). */
	blinkOn?: boolean;
	/** Force the cursor blink phase. */
	cursorBlinkOn?: boolean;
	/** DECSET 35 / CTerm NoBlink: render blink as a bright background. */
	noBlink?: boolean;
	/** Sixel overlay to composite beneath the text. */
	sixel?: SixelOverlay | null;
	/** Clock in milliseconds, for deterministic rendering. */
	time?: number;
	/** Redraw everything. */
	force?: boolean;
}

/** Renderer construction options. */
export interface RendererOptions {
	font?: BitmapFont;
	mode?: VideoMode | string;
	/** Integer pixel scale (default 1). */
	scale?: number;
	/** Default blink handling when a frame does not specify it. */
	noBlink?: boolean;
	/** Disable image smoothing when scaling glyphs. */
	smoothing?: boolean;
	/** Enable CRT post-processing. */
	crt?: boolean | CRTOptions | CRTPostProcessor;
	/** Default foreground palette index (default 7). */
	defaultFg?: number;
	/** Default background palette index (default 0). */
	defaultBg?: number;
	/** Text blink period in milliseconds (default 500). */
	blinkRate?: number;
	/** Cursor blink period in milliseconds (default 530). */
	cursorBlinkRate?: number;
}

interface Rect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

interface Shadow {
	cols: number;
	rows: number;
	chars: Uint16Array;
	fg: Int16Array;
	bg: Int16Array;
	flags: Uint16Array;
	fgRgb: Uint32Array;
	bgRgb: Uint32Array;
}

const EMPTY_FONT = new BitmapFont(8, 16, new Uint8Array(4096));

function unionRect(a: Rect | null, b: Rect | null): Rect | null {
	if (!a) return b;
	if (!b) return a;
	return {
		x0: Math.min(a.x0, b.x0),
		y0: Math.min(a.y0, b.y0),
		x1: Math.max(a.x1, b.x1),
		y1: Math.max(a.y1, b.y1),
	};
}

function now(): number {
	const g = globalThis as unknown as { performance?: { now(): number } };
	if (g.performance && typeof g.performance.now === 'function') return g.performance.now();
	return Date.now();
}

/** Canvas2D terminal renderer. */
export class Renderer {
	/** The canvas the caller handed us (the CRT output canvas). */
	readonly canvas: RenderCanvas;

	private mode: VideoMode;
	private font: BitmapFont;
	private scale: number;
	private readonly opt: Required<
		Pick<RendererOptions, 'noBlink' | 'smoothing' | 'defaultFg' | 'defaultBg' | 'blinkRate' | 'cursorBlinkRate'>
	>;

	private readonly source: RenderCanvas | null;
	private readonly ctx: Context2D;
	private readonly crt: CRTPostProcessor | null;

	private width = 1;
	private height = 1;

	private atlas: GlyphAtlas | null = null;
	private readonly tinted = new Map<number, RenderCanvas>();
	private shadow: Shadow | null = null;
	private fullDirty = true;

	private lastBlinkOn: boolean | null = null;
	private lastNoBlink: boolean | null = null;
	private lastCursorBlinkOn: boolean | null = null;
	private lastCursor: { x: number; y: number } | null = null;
	private lastCursorStyle: string | null = null;

	private sixel: SixelOverlay | null = null;
	private sixelCanvas: RenderCanvas | null = null;
	private sixelPixels: Int32Array | null = null;
	private sixelPalette: Palette | null = null;

	private destroyed = false;

	constructor(canvas: RenderCanvas, options: RendererOptions = {}) {
		this.canvas = canvas;
		this.mode = resolveVideoMode(options.mode);
		this.font = options.font ?? EMPTY_FONT;
		this.scale = Math.max(1, Math.round(options.scale ?? 1));
		this.opt = {
			noBlink: options.noBlink ?? false,
			smoothing: options.smoothing ?? false,
			defaultFg: options.defaultFg ?? 7,
			defaultBg: options.defaultBg ?? 0,
			blinkRate: options.blinkRate ?? 500,
			cursorBlinkRate: options.cursorBlinkRate ?? 530,
		};

		let crt: CRTPostProcessor | null = null;
		let source: RenderCanvas | null = null;
		if (options.crt !== undefined && options.crt !== false) {
			if (options.crt instanceof CRTPostProcessor) {
				crt = options.crt;
			} else {
				crt = new CRTPostProcessor(canvas, options.crt === true ? {} : options.crt);
			}
			source = crt.active ? createCanvas2D(1, 1) : null;
			if (!source) crt = null;
		}
		this.crt = crt;
		this.source = source;

		const ctx = get2DContext(source ?? canvas);
		if (!ctx) throw new Error('2D canvas context is not available');
		this.ctx = ctx;
		this.resize();
	}

	/** The active video mode. */
	get videoMode(): VideoMode {
		return this.mode;
	}

	/** The active font. */
	get bitmapFont(): BitmapFont {
		return this.font;
	}

	/** Current integer pixel scale. */
	get pixelScale(): number {
		return this.scale;
	}

	/** Whether CRT post-processing is in use. */
	get crtEnabled(): boolean {
		return this.crt !== null && this.crt.active;
	}

	/** Replace the font; the glyph atlas is rebuilt lazily. */
	setFont(font: BitmapFont): void {
		this.font = font;
		this.invalidateAtlas();
	}

	/** Switch video mode; this resizes the backing store. */
	setMode(mode: VideoMode | string): void {
		this.mode = resolveVideoMode(mode);
		this.resize();
	}

	/** Set the integer pixel scale. */
	setScale(scale: number): void {
		const next = Math.max(1, Math.round(scale));
		if (next === this.scale) return;
		this.scale = next;
		this.resize();
	}

	/** Attach or detach the sixel overlay. */
	setSixel(image: SixelOverlay | null): void {
		if (image === this.sixel) return;
		this.sixel = image;
		this.sixelCanvas = null;
		this.sixelPixels = null;
		this.sixelPalette = null;
		this.fullDirty = true;
	}

	/** Resize the backing store to the mode's native pixel size. */
	resize(): void {
		this.width = Math.max(1, this.mode.cols * this.mode.cellW * this.scale);
		this.height = Math.max(1, this.mode.rows * this.mode.cellH * this.scale);
		this.canvas.width = this.width;
		this.canvas.height = this.height;
		if (this.source) {
			this.source.width = this.width;
			this.source.height = this.height;
		}
		this.ctx.imageSmoothingEnabled = this.opt.smoothing;
		this.invalidateAtlas();
		this.shadow = null;
		this.fullDirty = true;
	}

	/** Render one frame. */
	render(
		screen: ScreenBuffer,
		palette: Palette,
		cursor: RenderCursor | null = null,
		options: RenderOptions = {},
	): void {
		if (this.destroyed) return;

		if (options.sixel !== undefined) this.setSixel(options.sixel);
		if (options.force) this.fullDirty = true;

		const nowMs = options.time ?? now();
		const blinkOn = options.blinkOn ?? Math.floor(nowMs / this.opt.blinkRate) % 2 === 0;
		const cursorBlinkOn = options.cursorBlinkOn ?? Math.floor(nowMs / this.opt.cursorBlinkRate) % 2 === 0;
		const noBlink = options.noBlink ?? this.opt.noBlink;

		if (this.lastBlinkOn !== null && this.lastBlinkOn !== blinkOn) this.fullDirty = true;
		if (this.lastNoBlink !== null && this.lastNoBlink !== noBlink) this.fullDirty = true;

		const style = cursor?.style ?? 'blinking-block';
		const cursorVisible = !!cursor && cursor.visible !== false;
		const cursorBlinking = style.startsWith('blinking');
		const cursorShown = cursorVisible && (!cursorBlinking || cursorBlinkOn);

		let dirty = this.scanDirty(screen);
		if (this.fullDirty) dirty = { x0: 0, y0: 0, x1: screen.cols - 1, y1: screen.rows - 1 };

		// Cursor bookkeeping: erase the old cell when it moves, blinks or changes style.
		let cursorDirty: Rect | null = null;
		if (this.lastCursor) {
			const moved =
				!cursorVisible ||
				!cursor ||
				cursor.x !== this.lastCursor.x ||
				cursor.y !== this.lastCursor.y ||
				style !== this.lastCursorStyle;
			const blinked = this.lastCursorBlinkOn !== null && this.lastCursorBlinkOn !== cursorBlinkOn;
			if (moved || blinked) cursorDirty = unionRect(cursorDirty, this.cursorRect(this.lastCursor, screen));
		}
		if (cursorShown && cursor) cursorDirty = unionRect(cursorDirty, this.cursorRect(cursor, screen));

		dirty = unionRect(dirty, cursorDirty);

		if (dirty) {
			this.ensureAtlas();
			const ctx = this.ctx;
			ctx.imageSmoothingEnabled = this.opt.smoothing;

			if (this.fullDirty) {
				ctx.fillStyle = '#000000';
				ctx.fillRect(0, 0, this.width, this.height);
				this.drawSixel(palette);
			}

			const x0 = Math.max(0, dirty.x0);
			const y0 = Math.max(0, dirty.y0);
			const x1 = Math.min(screen.cols - 1, dirty.x1);
			const y1 = Math.min(screen.rows - 1, dirty.y1);
			for (let y = y0; y <= y1; y++) {
				for (let x = x0; x <= x1; x++) {
					this.drawCell(screen, palette, x, y, blinkOn, noBlink);
				}
			}
			if (cursorShown && cursor) this.drawCursor(screen, palette, cursor, style, noBlink);
			this.updateShadow(screen);
			this.fullDirty = false;
			if (this.crt && this.source) this.crt.process(this.source);
		}

		this.lastBlinkOn = blinkOn;
		this.lastNoBlink = noBlink;
		this.lastCursorBlinkOn = cursorBlinkOn;
		this.lastCursorStyle = style;
		this.lastCursor = cursorVisible && cursor ? { x: cursor.x, y: cursor.y } : null;
	}

	/** Capture the current frame as a PNG blob. */
	async screenshot(): Promise<Blob> {
		const canvas = this.canvas as HTMLCanvasElement & OffscreenCanvas;
		if (typeof canvas.convertToBlob === 'function') {
			return canvas.convertToBlob({ type: 'image/png' });
		}
		if (typeof canvas.toBlob === 'function') {
			return new Promise<Blob>((resolve, reject) => {
				canvas.toBlob((blob) => {
					if (blob) resolve(blob);
					else reject(new Error('canvas.toBlob returned null'));
				}, 'image/png');
			});
		}
		throw new Error('canvas does not support screenshots');
	}

	/** Release cached resources. */
	destroy(): void {
		this.destroyed = true;
		this.tinted.clear();
		this.atlas = null;
		this.sixelCanvas = null;
		this.sixel = null;
		this.shadow = null;
		this.crt?.destroy();
	}

	// -----------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------

	private invalidateAtlas(): void {
		this.atlas = null;
		this.tinted.clear();
		// Rebuild against the current cell geometry on the next frame.
		this.ensureAtlas();
	}

	private ensureAtlas(): void {
		if (this.atlas) return;
		this.atlas = buildGlyphAtlas(this.font, {
			cellWidth: this.mode.cellW,
			cellHeight: this.font.height,
			scale: this.scale,
		});
		this.tinted.clear();
		if (!this.atlas) return;
	}

	private atlasFor(color: number): RenderCanvas | null {
		if (!this.atlas) return null;
		const key = color >>> 0;
		const cached = this.tinted.get(key);
		if (cached) return cached;
		if (this.tinted.size > 256) this.tinted.clear();
		const tinted = tintGlyphAtlas(this.atlas, color);
		if (!tinted) return null;
		this.tinted.set(key, tinted);
		return tinted;
	}

	private drawGlyphColored(code: number, color: number, px: number, py: number): void {
		const atlas = this.atlasFor(color);
		if (atlas) {
			const rect = this.atlas!.cellRect(code);
			const sw = this.atlas!.cellWidth * this.atlas!.scale;
			const sh = this.atlas!.cellHeight * this.atlas!.scale;
			this.ctx.drawImage(atlas as CanvasImageSource, rect.sx, rect.sy, sw, sh, px, py, sw, sh);
			return;
		}
		drawGlyphDirect(this.ctx, this.font, code, px, py, color, {
			scale: this.scale,
			cellWidth: this.mode.cellW,
			cellHeight: this.font.height,
		});
	}

	private cellColors(
		screen: ScreenBuffer,
		palette: Palette,
		index: number,
		noBlink: boolean,
	): { fg: number; bg: number } {
		const flags = screen.flags[index];
		const fgIndex = screen.fg[index];
		const bgIndex = screen.bg[index];

		const trueFg = (flags & FLAG_TRUE_FG) !== 0 && screen.fgRgb[index] !== 0;
		const trueBg = (flags & FLAG_TRUE_BG) !== 0 && screen.bgRgb[index] !== 0;

		let fg = trueFg ? screen.fgRgb[index] : palette.get(fgIndex >= 0 ? fgIndex : this.opt.defaultFg);
		let bg = trueBg ? screen.bgRgb[index] : palette.get(bgIndex >= 0 ? bgIndex : this.opt.defaultBg);

		// SGR bold selects the high-intensity half of the palette.
		if (!trueFg && (flags & FLAG_BOLD) !== 0) {
			const bright = fgIndex >= 0 ? fgIndex : this.opt.defaultFg;
			if (bright >= 0 && bright < 8) fg = palette.get(bright + 8);
		}

		// DECSET 35: blink becomes a bright background instead of a hidden glyph.
		if (noBlink && (flags & FLAG_BLINK) !== 0 && !trueBg) {
			const bright = bgIndex >= 0 ? bgIndex : this.opt.defaultBg;
			if (bright >= 0 && bright < 8) bg = palette.get(bright + 8);
		}

		if ((flags & FLAG_REVERSE) !== 0) {
			const swap = fg;
			fg = bg;
			bg = swap;
		}
		if ((flags & FLAG_CONCEALED) !== 0) fg = bg;
		return { fg, bg };
	}

	private drawCell(
		screen: ScreenBuffer,
		palette: Palette,
		x: number,
		y: number,
		blinkOn: boolean,
		noBlink: boolean,
	): void {
		const index = y * screen.cols + x;
		let { fg, bg } = this.cellColors(screen, palette, index, noBlink);
		if (!noBlink && (screen.flags[index] & FLAG_BLINK) !== 0 && !blinkOn) fg = bg;

		const cw = this.mode.cellW * this.scale;
		const ch = this.mode.cellH * this.scale;
		const px = x * cw;
		const py = y * ch;
		this.ctx.fillStyle = rgbToCss(bg);
		this.ctx.fillRect(px, py, cw, ch);
		if (fg !== bg) {
			const code = unicodeToGlyphIndex(screen.chars[index]);
			this.drawGlyphColored(code, fg, px, py);
		}
	}

	private drawCursor(
		screen: ScreenBuffer,
		palette: Palette,
		cursor: RenderCursor,
		style: string,
		noBlink: boolean,
	): void {
		if (cursor.x < 0 || cursor.y < 0 || cursor.x >= screen.cols || cursor.y >= screen.rows) return;
		const index = cursor.y * screen.cols + cursor.x;
		const { fg, bg } = this.cellColors(screen, palette, index, noBlink);
		const cw = this.mode.cellW * this.scale;
		const ch = this.mode.cellH * this.scale;
		const px = cursor.x * cw;
		const py = cursor.y * ch;

		this.ctx.fillStyle = rgbToCss(fg);
		if (style.endsWith('block')) {
			this.ctx.fillRect(px, py, cw, ch);
			const code = unicodeToGlyphIndex(screen.chars[index]);
			if (fg !== bg) this.drawGlyphColored(code, bg, px, py);
		} else {
			const thickness = Math.max(1, Math.round(2 * this.scale));
			this.ctx.fillRect(px, py + ch - thickness, cw, thickness);
		}
	}

	private cursorRect(cursor: { x: number; y: number }, screen: ScreenBuffer): Rect | null {
		if (cursor.x < 0 || cursor.y < 0 || cursor.x >= screen.cols || cursor.y >= screen.rows) return null;
		return { x0: cursor.x, y0: cursor.y, x1: cursor.x, y1: cursor.y };
	}

	private scanDirty(screen: ScreenBuffer): Rect | null {
		const need = screen.cols * screen.rows;
		if (!this.shadow || this.shadow.cols !== screen.cols || this.shadow.rows !== screen.rows) {
			this.shadow = {
				cols: screen.cols,
				rows: screen.rows,
				chars: new Uint16Array(need),
				fg: new Int16Array(need),
				bg: new Int16Array(need),
				flags: new Uint16Array(need),
				fgRgb: new Uint32Array(need),
				bgRgb: new Uint32Array(need),
			};
			this.fullDirty = true;
			return null;
		}
		if (this.fullDirty) return null;

		const shadow = this.shadow;
		let x0 = screen.cols;
		let y0 = screen.rows;
		let x1 = -1;
		let y1 = -1;
		for (let y = 0; y < screen.rows; y++) {
			const row = y * screen.cols;
			for (let x = 0; x < screen.cols; x++) {
				const i = row + x;
				if (
					shadow.chars[i] !== screen.chars[i] ||
					shadow.fg[i] !== screen.fg[i] ||
					shadow.bg[i] !== screen.bg[i] ||
					shadow.flags[i] !== screen.flags[i] ||
					shadow.fgRgb[i] !== screen.fgRgb[i] ||
					shadow.bgRgb[i] !== screen.bgRgb[i]
				) {
					if (x < x0) x0 = x;
					if (y < y0) y0 = y;
					if (x > x1) x1 = x;
					if (y > y1) y1 = y;
				}
			}
		}
		if (x1 < 0) return null;
		return { x0, y0, x1, y1 };
	}

	private updateShadow(screen: ScreenBuffer): void {
		const shadow = this.shadow;
		if (!shadow) return;
		shadow.chars.set(screen.chars);
		shadow.fg.set(screen.fg);
		shadow.bg.set(screen.bg);
		shadow.flags.set(screen.flags);
		shadow.fgRgb.set(screen.fgRgb);
		shadow.bgRgb.set(screen.bgRgb);
	}

	private drawSixel(palette: Palette): void {
		const image = this.sixel;
		if (!image || image.width <= 0 || image.height <= 0) return;
		const canvas = this.ensureSixelCanvas(palette);
		if (!canvas) return;
		this.ctx.imageSmoothingEnabled = false;
		this.ctx.drawImage(
			canvas as CanvasImageSource,
			image.baseX * this.scale,
			image.baseY * this.scale,
			image.width * this.scale,
			image.height * this.scale,
		);
		this.ctx.imageSmoothingEnabled = this.opt.smoothing;
	}

	private ensureSixelCanvas(palette: Palette): RenderCanvas | null {
		const image = this.sixel;
		if (!image) return null;
		if (
			this.sixelCanvas &&
			this.sixelPixels === image.pixels &&
			this.sixelPalette === palette
		) {
			return this.sixelCanvas;
		}
		const canvas = createCanvas2D(image.width, image.height);
		if (!canvas) return null;
		const ctx = get2DContext(canvas);
		if (!ctx) return null;
		const data = ctx.createImageData(image.width, image.height);
		const out = data.data;
		for (let i = 0; i < image.pixels.length; i++) {
			const value = image.pixels[i];
			const offset = i * 4;
			if (value < 0) {
				out[offset] = 0;
				out[offset + 1] = 0;
				out[offset + 2] = 0;
				out[offset + 3] = 0;
				continue;
			}
			const rgb = palette.get(value);
			out[offset] = (rgb >> 16) & 0xff;
			out[offset + 1] = (rgb >> 8) & 0xff;
			out[offset + 2] = rgb & 0xff;
			out[offset + 3] = 0xff;
		}
		ctx.putImageData(data, 0, 0);
		this.sixelCanvas = canvas;
		this.sixelPixels = image.pixels;
		this.sixelPalette = palette;
		return canvas;
	}
}
