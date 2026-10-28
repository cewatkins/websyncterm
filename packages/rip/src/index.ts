// @websyncterm/rip — RIPscrip 1.54 interpreter.
//
// Byte-compatible framing and drawing with SyncTERM's ripper.c /
// RIPterm v1.54.00.  Drawing is kept in a separate pixel layer for the
// renderer to composite over the terminal's character cells.

export {
	RipInterpreter,
	parseMegaNum,
	bezierPolyline,
	bezierSampleCount,
	bgiImageSizeOk,
	RIP_FILL_PATTERNS,
	RIP_LINE_PATTERNS,
	RipRaster,
	MASTER_PALETTE,
	DEFAULT_PALETTE,
	RipPalette,
	mapColor,
	masterColor,
	RIP_VERSION_STRING,
	expandVariables,
} from './interpreter.js';

export type {
	RipInterpreterOptions,
	RipGraphicsState,
	RipTextWindow,
	Point,
	RasterImage,
	Viewport,
	RipMouseState,
	RipVariableContext,
	VariableHooks,
} from './interpreter.js';
