/**
 * SyncTERM video modes and the display scaling rules.
 *
 * The table mirrors `vparams[]` in `src/conio/vidmodes.c`. Scaling follows
 * `bitmap_width_controls()`, `bitmap_get_scaled_win_size()`, `bitmap_snap()`
 * and `integer_scale()` in `src/conio/bitmap_con.c`.
 */

/** One SyncTERM video mode. */
export interface VideoMode {
	/** Upstream mode name. */
	readonly name: string;
	/** Text columns. */
	readonly cols: number;
	/** Text rows. */
	readonly rows: number;
	/** Cell width in font pixels. */
	readonly cellW: number;
	/** Cell height in font pixels. */
	readonly cellH: number;
	/** Native graphics width. */
	readonly nativeX: number;
	/** Native graphics height. */
	readonly nativeY: number;
	/** Display aspect numerator (0 = unspecified). */
	readonly aspectW: number;
	/** Display aspect denominator (0 = unspecified). */
	readonly aspectH: number;
}

function mode(
	name: string,
	cols: number,
	rows: number,
	cellW: number,
	cellH: number,
	nativeX: number,
	nativeY: number,
	aspectW: number,
	aspectH: number,
): VideoMode {
	return { name, cols, rows, cellW, cellH, nativeX, nativeY, aspectW, aspectH };
}

/** The video mode table, in upstream order. */
export const VIDEO_MODE_LIST: readonly VideoMode[] = [
	mode('BW40', 40, 25, 8, 16, 320, 200, 4, 3),
	mode('C40', 40, 25, 8, 16, 320, 200, 4, 3),
	mode('BW80', 80, 25, 8, 16, 640, 400, 4, 3),
	mode('C80', 80, 25, 8, 16, 640, 400, 4, 3),
	mode('MONO', 80, 25, 8, 16, 640, 400, 4, 3),
	mode('C40X14', 40, 14, 8, 16, 320, 224, 4, 3),
	mode('C40X21', 40, 21, 8, 16, 320, 336, 4, 3),
	mode('C40X28', 40, 28, 8, 14, 320, 392, 4, 3),
	mode('C40X43', 40, 43, 8, 8, 320, 774, 4, 3),
	mode('C40X50', 40, 50, 8, 8, 320, 400, 4, 3),
	mode('C40X60', 40, 60, 8, 8, 320, 480, 4, 3),
	mode('C80X14', 80, 14, 8, 16, 640, 224, 4, 3),
	mode('C80X21', 80, 21, 8, 16, 640, 336, 4, 3),
	mode('C80X28', 80, 28, 8, 14, 640, 392, 4, 3),
	mode('C80X30', 80, 30, 8, 16, 640, 480, 4, 3),
	mode('C80X43', 80, 43, 8, 8, 640, 350, 4, 3),
	mode('EGA80X25', 80, 25, 8, 14, 640, 350, 4, 3),
	mode('C80X50', 80, 50, 8, 8, 640, 400, 4, 3),
	mode('C80X60', 80, 60, 8, 8, 640, 480, 4, 3),
	mode('VESA_132X21', 132, 21, 8, 16, 1056, 336, 4, 3),
	mode('VESA_132X25', 132, 25, 8, 16, 1056, 400, 4, 3),
	mode('VESA_132X28', 132, 28, 8, 14, 1056, 392, 4, 3),
	mode('VESA_132X30', 132, 30, 8, 16, 1056, 480, 4, 3),
	mode('VESA_132X34', 132, 34, 8, 14, 1056, 476, 4, 3),
	mode('VESA_132X43', 132, 43, 8, 8, 1056, 350, 4, 3),
	mode('VESA_132X50', 132, 50, 8, 8, 1056, 400, 4, 3),
	mode('VESA_132X60', 132, 60, 8, 8, 1056, 480, 4, 3),
	mode('C64_40X25', 40, 25, 8, 8, 320, 200, 6, 5),
	mode('C128_40X25', 40, 25, 8, 8, 320, 200, 6, 5),
	mode('C128_80X25', 80, 25, 8, 8, 640, 200, 4, 3),
	mode('ATARI_40X24', 40, 24, 8, 8, 320, 192, 4, 3),
	mode('ATARI_80X25', 80, 25, 8, 16, 640, 400, 4, 3),
	mode('ST132X37_16_9', 132, 37, 8, 16, 1056, 592, 16, 9),
	mode('ST132X52_5_4', 132, 52, 8, 16, 1056, 832, 5, 4),
	mode('VGA80X25', 80, 25, 9, 16, 720, 400, 4, 3),
	mode('LCD80X25', 80, 25, 8, 16, 640, 400, 8, 5),
	mode('PRESTEL_40X25', 40, 25, 12, 20, 480, 500, 3077, 2400),
	mode('ATARIST_40X25', 40, 25, 8, 8, 320, 200, 4, 3),
	mode('ATARIST_80X25', 80, 25, 8, 8, 640, 200, 4, 3),
	mode('ATARIST_80X25_MONO', 80, 25, 8, 16, 640, 400, 4, 3),
];

/** The mode table keyed by name. */
export const VIDEO_MODES: Readonly<Record<string, VideoMode>> = Object.freeze(
	Object.fromEntries(VIDEO_MODE_LIST.map((entry) => [entry.name, entry])),
);

/** Default mode. */
export const DEFAULT_MODE = VIDEO_MODES.C80;

/** Look up a mode by name (case insensitive) or return a mode object. */
export function resolveVideoMode(value: string | VideoMode | undefined): VideoMode {
	if (value === undefined) return DEFAULT_MODE;
	if (typeof value !== 'string') return value;
	const direct = VIDEO_MODES[value];
	if (direct) return direct;
	const upper = value.toUpperCase();
	return VIDEO_MODES[upper] ?? DEFAULT_MODE;
}

/** True when the width (rather than the height) determines the display size. */
export function widthControls(mode: VideoMode): boolean {
	if (mode.aspectW === 0 || mode.aspectH === 0) return true;
	return Math.round((mode.nativeY * mode.aspectW) / mode.aspectH) <= mode.nativeX;
}

/** Apply the aspect ratio correction to a width/height pair. */
export function aspectFix(
	width: number,
	height: number,
	wc: boolean,
	aspectW: number,
	aspectH: number,
): { width: number; height: number } {
	if (aspectW === 0 || aspectH === 0) return { width, height };
	if (wc) {
		return { width, height: Math.round((width * aspectH) / aspectW) };
	}
	return { width: Math.round((height * aspectW) / aspectH), height };
}

/** The size of the native screen at a given scale, aspect corrected. */
export function scaledWinSize(mode: VideoMode, scale: number): { width: number; height: number } {
	const factor = scale < 1 ? 1 : scale;
	const wc = widthControls(mode);
	let width = Math.round(mode.nativeX * factor);
	let height = Math.round(mode.nativeY * factor);
	if (mode.aspectW !== 0 && mode.aspectH !== 0) {
		if (wc) height = Math.round((width * mode.aspectH) / mode.aspectW);
		else width = Math.round((height * mode.aspectW) / mode.aspectH);
	}
	return { width: Math.max(1, width), height: Math.max(1, height) };
}

/** `scaledWinSize` with the authoritative dimension clamped to a maximum. */
export function scaledWinSizeClamped(
	mode: VideoMode,
	scale: number,
	maxWidth: number,
	maxHeight: number,
): { width: number; height: number } {
	const factor = scale < 1 ? 1 : scale;
	const wc = widthControls(mode);
	if (mode.aspectW === 0 || mode.aspectH === 0) {
		let width = Math.round(mode.nativeX * factor);
		let height = Math.round(mode.nativeY * factor);
		if (maxWidth > 0) width = Math.min(width, maxWidth);
		if (maxHeight > 0) height = Math.min(height, maxHeight);
		return { width: Math.max(1, width), height: Math.max(1, height) };
	}
	if (wc) {
		let width = Math.round(mode.nativeX * factor);
		if (maxWidth > 0) width = Math.min(width, maxWidth);
		width = Math.max(1, width);
		return { width, height: Math.max(1, Math.round((width * mode.aspectH) / mode.aspectW)) };
	}
	let height = Math.round(mode.nativeY * factor);
	if (maxHeight > 0) height = Math.min(height, maxHeight);
	height = Math.max(1, height);
	return { width: Math.max(1, Math.round((height * mode.aspectW) / mode.aspectH)), height };
}

/** A computed display size. */
export interface DisplaySize {
	/** Canvas width in device pixels. */
	width: number;
	/** Canvas height in device pixels. */
	height: number;
	/** Scale factor applied to the native screen. */
	scale: number;
	/** True when `scale` is an integer. */
	integerScale: boolean;
	/** True when the mode's pixels are square. */
	squarePixels: boolean;
	/** True when the width is authoritative. */
	widthControls: boolean;
}

export interface ComputeDisplayOptions {
	/** Force the integer snapping path. */
	integer?: boolean;
	/** Previous scale; a value within 0.0125 of an integer triggers snapping. */
	currentScale?: number;
	/** Previous window width, used for the integer-snap diagonal. */
	oldWidth?: number;
	/** Previous window height, used for the integer-snap diagonal. */
	oldHeight?: number;
	/** Lower bound; never less than 1. */
	minScale?: number;
	/** Upper bound. */
	maxScale?: number;
}

/** Upstream's integer-snap tolerance. */
export const INTEGER_TOLERANCE = 0.0125;

/**
 * Choose the integer multiple whose squared diagonal is closest to the old
 * diagonal without exceeding the maximum, preferring the smaller multiple on
 * ties (`integer_scale()`).
 */
export function integerScale(
	mode: VideoMode,
	maxWidth: number,
	maxHeight: number,
	oldSize: number,
): { width: number; height: number; scale: number } {
	let mult = 1;
	let size = scaledWinSizeClamped(mode, mult, maxWidth, maxHeight);
	let w = size.width;
	let h = size.height;
	let bestSize = w * w + h * h;
	let lastSize = bestSize;
	let nextSize = bestSize;

	while (nextSize < oldSize) {
		mult++;
		const candidate = scaledWinSize(mode, mult);
		w = candidate.width;
		h = candidate.height;
		if (maxWidth > 0 && w > maxWidth) {
			mult--;
			nextSize = lastSize;
			break;
		}
		if (w === maxWidth) break;
		if (maxHeight > 0 && h > maxHeight) {
			mult--;
			nextSize = lastSize;
			break;
		}
		if (h === maxHeight) break;
		bestSize = w * w + h * h;
		lastSize = nextSize;
		nextSize = bestSize;
	}
	if (oldSize - lastSize <= nextSize - oldSize) {
		if (mult > 1) mult--;
	}
	const final = scaledWinSizeClamped(mode, mult, maxWidth, maxHeight);
	return { width: final.width, height: final.height, scale: mult };
}

/**
 * Snap the display to an exact multiple of the native size (`bitmap_snap()`).
 */
export function snapScale(
	mode: VideoMode,
	winWidth: number,
	winHeight: number,
	options: { grow: boolean; maxWidth?: number; maxHeight?: number },
): { width: number; height: number; scale: number } {
	const wc = widthControls(mode);
	const maxWidth = options.maxWidth ?? 0;
	const maxHeight = options.maxHeight ?? 0;
	const currentWidth = wc ? winWidth : winHeight;
	const nativeWidth = wc ? mode.nativeX : mode.nativeY;
	let mult = Math.floor(currentWidth / nativeWidth);
	if (options.grow) {
		mult++;
	} else if (currentWidth % nativeWidth === 0) {
		mult--;
	}
	if (!Number.isFinite(mult) || mult < 1) mult = 1;
	let size = scaledWinSize(mode, mult);
	while (((maxWidth > 0 && size.width > maxWidth) || (maxHeight > 0 && size.height > maxHeight)) && mult > 1) {
		mult--;
		size = scaledWinSize(mode, mult);
	}
	return { width: size.width, height: size.height, scale: mult };
}

/** True when the mode's aspect ratio matches its native pixel geometry. */
export function hasSquarePixels(mode: VideoMode): boolean {
	if (mode.aspectW === 0 || mode.aspectH === 0) return true;
	const nativeRatio = mode.nativeX / mode.nativeY;
	const aspectRatio = mode.aspectW / mode.aspectH;
	return Math.abs(aspectRatio - nativeRatio) / aspectRatio < 0.005;
}

/**
 * Compute the on-screen canvas size for a mode inside a viewport.
 *
 * The scale factor is never allowed below 1, matching SyncTERM: a viewport
 * smaller than the native screen produces a native-sized (clipped) display.
 */
export function computeDisplaySize(
	mode: VideoMode,
	viewportW: number,
	viewportH: number,
	options: ComputeDisplayOptions = {},
): DisplaySize {
	const base = scaledWinSize(mode, 1);
	const wc = widthControls(mode);
	const minScale = Math.max(1, options.minScale ?? 1);
	const maxScale = options.maxScale ?? Number.POSITIVE_INFINITY;

	const fit = Math.min(viewportW / base.width, viewportH / base.height);
	let scale = Math.max(minScale, Math.min(fit, maxScale));
	if (!Number.isFinite(scale)) scale = minScale;

	const snap =
		fit >= minScale &&
		(options.integer === true ||
			(options.currentScale !== undefined &&
				Math.abs(options.currentScale - Math.round(options.currentScale)) < INTEGER_TOLERANCE));

	let width: number;
	let height: number;
	if (snap) {
		const oldWidth = options.oldWidth ?? viewportW;
		const oldHeight = options.oldHeight ?? viewportH;
		const oldSize = oldWidth * oldWidth + oldHeight * oldHeight;
		const snapped = integerScale(mode, viewportW, viewportH, oldSize);
		width = snapped.width;
		height = snapped.height;
		scale = snapped.scale;
	} else if (fit < minScale) {
		// The viewport is smaller than the native screen. SyncTERM never scales
		// below 1.0, so report the native aspect-corrected size instead of a
		// shrunken one; the caller clips or scrolls.
		const size = scaledWinSize(mode, 1);
		width = size.width;
		height = size.height;
		scale = 1;
	} else {
		const size = scaledWinSizeClamped(mode, scale, viewportW, viewportH);
		width = size.width;
		height = size.height;
	}

	return {
		width,
		height,
		scale,
		integerScale: Number.isInteger(scale),
		squarePixels: hasSquarePixels(mode),
		widthControls: wc,
	};
}

/** Convenience: the native pixel size of a mode (glyph geometry). */
export function nativeScreenSize(mode: VideoMode): { width: number; height: number } {
	return { width: mode.cols * mode.cellW, height: mode.rows * mode.cellH };
}
