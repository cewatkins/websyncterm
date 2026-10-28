import { describe, expect, test } from 'vitest';
import {
	INTEGER_TOLERANCE,
	VIDEO_MODES,
	VIDEO_MODE_LIST,
	aspectFix,
	computeDisplaySize,
	hasSquarePixels,
	integerScale,
	nativeScreenSize,
	scaledWinSize,
	snapScale,
	widthControls,
} from '../src/scaler.js';

describe('video mode table', () => {
	test('contains the upstream modes with the upstream geometry', () => {
		expect(VIDEO_MODE_LIST).toHaveLength(40);
		expect(VIDEO_MODES.VGA80X25).toMatchObject({
			cols: 80,
			rows: 25,
			cellW: 9,
			cellH: 16,
			nativeX: 720,
			nativeY: 400,
			aspectW: 4,
			aspectH: 3,
		});
		expect(VIDEO_MODES.PRESTEL_40X25).toMatchObject({
			cols: 40,
			rows: 25,
			cellW: 12,
			cellH: 20,
			nativeX: 480,
			nativeY: 500,
			aspectW: 3077,
			aspectH: 2400,
		});
		expect(VIDEO_MODES.C40X43).toMatchObject({ cols: 40, rows: 43, cellW: 8, cellH: 8, nativeY: 774 });
		expect(VIDEO_MODES.ST132X52_5_4).toMatchObject({ aspectW: 5, aspectH: 4, nativeX: 1056, nativeY: 832 });
		expect(nativeScreenSize(VIDEO_MODES.C80)).toEqual({ width: 640, height: 400 });
		expect(nativeScreenSize(VIDEO_MODES.VGA80X25)).toEqual({ width: 720, height: 400 });
	});

	test('width controls matches bitmap_width_controls()', () => {
		// 400 * 4 / 3 = 533 <= 640
		expect(widthControls(VIDEO_MODES.C80)).toBe(true);
		// 400 * 4 / 3 = 533 <= 720
		expect(widthControls(VIDEO_MODES.VGA80X25)).toBe(true);
		// 400 * 8 / 5 = 640 <= 640
		expect(widthControls(VIDEO_MODES.LCD80X25)).toBe(true);
		// 592 * 16 / 9 = 1052 <= 1056
		expect(widthControls(VIDEO_MODES.ST132X37_16_9)).toBe(true);
		// 500 * 3077 / 2400 = 641 > 480, so Prestel is height controlled.
		expect(widthControls(VIDEO_MODES.PRESTEL_40X25)).toBe(false);
	});

	test('square pixels is only true when native and display aspect agree', () => {
		expect(hasSquarePixels(VIDEO_MODES.C80)).toBe(false);
		expect(hasSquarePixels(VIDEO_MODES.VGA80X25)).toBe(false);
		expect(hasSquarePixels(VIDEO_MODES.LCD80X25)).toBe(true);
		expect(hasSquarePixels(VIDEO_MODES.ATARIST_80X25_MONO)).toBe(false);
		expect(hasSquarePixels(VIDEO_MODES.ST132X37_16_9)).toBe(true);
	});

	test('aspectFix derives the non-authoritative dimension', () => {
		expect(aspectFix(800, 600, true, 4, 3)).toEqual({ width: 800, height: 600 });
		expect(aspectFix(640, 1, true, 4, 3)).toEqual({ width: 640, height: 480 });
		expect(aspectFix(1, 400, false, 4, 3)).toEqual({ width: 533, height: 400 });
		expect(aspectFix(100, 100, true, 0, 0)).toEqual({ width: 100, height: 100 });
	});

	test('scaledWinSize applies the aspect correction', () => {
		expect(scaledWinSize(VIDEO_MODES.C80, 1)).toEqual({ width: 640, height: 480 });
		expect(scaledWinSize(VIDEO_MODES.C80, 2)).toEqual({ width: 1280, height: 960 });
		expect(scaledWinSize(VIDEO_MODES.VGA80X25, 1)).toEqual({ width: 720, height: 540 });
		// Height-authoritative mode: width is derived from the height.
		expect(scaledWinSize(VIDEO_MODES.PRESTEL_40X25, 1)).toEqual({ width: 641, height: 500 });
	});
});

describe('computeDisplaySize', () => {
	test('fits the native size into the viewport and keeps 4:3', () => {
		const size = computeDisplaySize(VIDEO_MODES.C80, 1024, 768);
		expect(size).toMatchObject({
			width: 1024,
			height: 768,
			integerScale: false,
			widthControls: true,
			squarePixels: false,
		});
		expect(size.scale).toBeCloseTo(1.6, 10);
	});

	test('never scales below 1.0', () => {
		const size = computeDisplaySize(VIDEO_MODES.C80, 320, 200);
		expect(size.scale).toBe(1);
		expect(size.width).toBe(640);
		expect(size.height).toBe(480);
		expect(size.integerScale).toBe(true);
	});

	test('handles a constrained width', () => {
		const size = computeDisplaySize(VIDEO_MODES.C80, 650, 500);
		expect(size.width).toBe(650);
		expect(size.height).toBe(488);
		expect(size.scale).toBeCloseTo(650 / 640, 10);
	});

	test('keeps the VGA 4:3 display aspect', () => {
		const size = computeDisplaySize(VIDEO_MODES.VGA80X25, 800, 600);
		expect(size.width).toBe(800);
		expect(size.height).toBe(600);
		expect(size.scale).toBeCloseTo(800 / 720, 10);
	});

	test('integer snapping prefers the closest smaller multiple', () => {
		const size = computeDisplaySize(VIDEO_MODES.C80, 1300, 1000, { integer: true });
		expect(size).toMatchObject({ width: 1280, height: 960, scale: 2, integerScale: true });
	});

	test('a current scale near an integer triggers integer snapping', () => {
		const snapped = computeDisplaySize(VIDEO_MODES.C80, 1300, 1000, { currentScale: 2 + INTEGER_TOLERANCE / 2 });
		expect(snapped.scale).toBe(2);
		// Far away from an integer it is not snapped.
		const free = computeDisplaySize(VIDEO_MODES.C80, 1300, 1000, { currentScale: 2.2 });
		expect(free.scale).toBeCloseTo(Math.min(1300 / 640, 1000 / 480), 10);
	});
});

describe('integer_scale()', () => {
	test('picks the multiple closest to the old diagonal without exceeding the maximum', () => {
		// old window diagonal squared = 1300^2 + 900^2
		const snapped = integerScale(VIDEO_MODES.C80, 1300, 1000, 1300 * 1300 + 1000 * 1000);
		expect(snapped).toEqual({ width: 1280, height: 960, scale: 2 });
	});

	test('a huge old window is capped at the viewport', () => {
		const snapped = integerScale(VIDEO_MODES.C80, 1300, 1000, 10_000_000);
		expect(snapped.scale).toBe(2);
		expect(snapped.width).toBeLessThanOrEqual(1300);
		expect(snapped.height).toBeLessThanOrEqual(1000);
	});

	test('never returns a scale below 1', () => {
		const snapped = integerScale(VIDEO_MODES.C80, 100, 100, 0);
		expect(snapped.scale).toBe(1);
		expect(snapped.width).toBe(100);
		expect(snapped.height).toBe(75);
	});
});

describe('bitmap_snap()', () => {
	test('grows to the next multiple', () => {
		const snapped = snapScale(VIDEO_MODES.C80, 1300, 1000, { grow: true, maxWidth: 1300, maxHeight: 1000 });
		expect(snapped).toEqual({ width: 1280, height: 960, scale: 2 });
	});

	test('shrinking steps down only from an exact multiple', () => {
		expect(snapScale(VIDEO_MODES.C80, 1280, 960, { grow: false })).toEqual({
			width: 640,
			height: 480,
			scale: 1,
		});
		expect(snapScale(VIDEO_MODES.C80, 1300, 1000, { grow: false })).toEqual({
			width: 1280,
			height: 960,
			scale: 2,
		});
	});

	test('never drops below one', () => {
		expect(snapScale(VIDEO_MODES.C80, 300, 200, { grow: false })).toEqual({
			width: 640,
			height: 480,
			scale: 1,
		});
	});
});
