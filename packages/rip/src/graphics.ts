// RIPscrip graphics raster.
//
// Draws into an 0xAARRGGBB pixel buffer at the physical resolution of the
// screen while accepting virtual (RIPscrip) coordinates.  The virtual frame
// defaults to 640x350 and every coordinate is mapped with
//
//     physical = round(virtual * physicalSize / virtualSize)
//
// all drawing primitives are clipped to the current viewport; a viewport of
// 0,0,0,0 disables it and makes every viewport-checking primitive a no-op.

import { FONT8X8 } from './font8x8.js';
import { RipPalette } from './palette.js';

export interface Point {
	x: number;
	y: number;
}

export interface Viewport {
	sx: number;
	sy: number;
	ex: number;
	ey: number;
}

export interface RasterImage {
	width: number;
	height: number;
	data: Uint32Array;
}

export interface LineOptions {
	color?: number;
	pattern?: number;
	width?: number;
	xor?: boolean;
}

/** RIPterm's four built-in line patterns (deliberately not the docs'). */
export const RIP_LINE_PATTERNS: readonly number[] = [
	0xffff, 0xcccc, 0xfc78, 0xf8f8,
];

/** The twelve predefined 8x8 fill patterns. */
export const RIP_FILL_PATTERNS: readonly (readonly number[])[] = [
	[0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // background
	[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], // solid
	[0xff, 0xff, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00], // line
	[0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80], // light slash
	[0xe0, 0xc1, 0x83, 0x07, 0x0e, 0x1c, 0x38, 0x70], // normal slash
	[0xf0, 0x78, 0x3c, 0x1e, 0x0f, 0x87, 0xc3, 0xe1], // normal backslash
	[0xa5, 0xd2, 0x69, 0xb4, 0x5a, 0x2d, 0x96, 0x4b], // light backslash
	[0xff, 0x88, 0x88, 0x88, 0xff, 0x88, 0x88, 0x88], // light hatch
	[0x81, 0x42, 0x24, 0x18, 0x18, 0x24, 0x42, 0x81], // heavy cross hatch
	[0xcc, 0x33, 0xcc, 0x33, 0xcc, 0x33, 0xcc, 0x33], // interleaving line
	[0x80, 0x00, 0x08, 0x00, 0x80, 0x00, 0x08, 0x00], // widely spaced dots
	[0x88, 0x00, 0x22, 0x00, 0x88, 0x00, 0x22, 0x00], // closely spaced dots
];

// BGI sin table: sin(0)..sin(90) scaled by 32768 (Q1.15).
const BGI_SIN_TABLE: readonly number[] = [
	0x0000, 0x023b, 0x0477, 0x06b2, 0x08ed, 0x0b27, 0x0d61, 0x0f99, 0x11d0, 0x1406,
	0x163a, 0x186c, 0x1a9c, 0x1ccb, 0x1ef7, 0x2120, 0x2348, 0x256c, 0x278d, 0x29ac,
	0x2bc7, 0x2ddf, 0x2ff3, 0x3203, 0x340f, 0x3618, 0x381c, 0x3a1c, 0x3c17, 0x3e0e,
	0x4000, 0x41ec, 0x43d4, 0x45b6, 0x4793, 0x496a, 0x4b3c, 0x4d08, 0x4ecd, 0x508d,
	0x5246, 0x53f9, 0x55a6, 0x574b, 0x58ea, 0x5a82, 0x5c13, 0x5d9c, 0x5f1f, 0x609a,
	0x620d, 0x6379, 0x64dd, 0x6639, 0x678d, 0x68d9, 0x6a1d, 0x6b59, 0x6c8c, 0x6db7,
	0x6ed9, 0x6ff3, 0x7104, 0x720c, 0x730b, 0x7401, 0x74ef, 0x75d3, 0x76ad, 0x777f,
	0x7847, 0x7906, 0x79bc, 0x7a68, 0x7b0a, 0x7ba3, 0x7c32, 0x7cb8, 0x7d33, 0x7da5,
	0x7e0e, 0x7e6c, 0x7ec1, 0x7f0b, 0x7f4c, 0x7f83, 0x7fb0, 0x7fd3, 0x7fec, 0x7ffb,
	0x8000,
];

export function bgiSin32(angleDeg: number): number {
	let a = angleDeg % 360;
	if (a < 0)
		a += 360;
	let neg = false;
	if (a > 180) {
		a -= 180;
		neg = true;
	}
	if (a > 90)
		a = 180 - a;
	const val = (BGI_SIN_TABLE[a] ?? 0) << 1;
	return neg ? -val : val;
}

export function bgiCos32(angleDeg: number): number {
	return bgiSin32(angleDeg + 90);
}

/** BGI's 32x16 -> high-16-bit signed multiply. */
export function bgiTrigMul(trig32: number, radius: number): number {
	const lo = trig32 & 0xffff;
	const hi = (trig32 >>> 16) & 0xffff;
	const r = radius & 0xffff;
	const r1 = Math.imul(hi, r) >>> 0;
	const r2 = Math.imul(lo, r) >>> 0;
	return ((((r1 & 0xffff) + (r2 >>> 16)) << 16) >> 16);
}

function bgiMetric(axVal: number, bxVal: number): number {
	const bx = -bxVal;
	if (axVal >= 0) {
		if (bx >= 0)
			return bx - axVal;
		return axVal + 6000 + bx;
	}
	if (bx >= 0)
		return -axVal + 2000 - bx;
	return axVal + 4000 - bx;
}

function bgiArcLimit(a: number, b: number, angle: number): number {
	const sx = bgiTrigMul(bgiCos32(angle), a);
	const sy = -bgiTrigMul(bgiSin32(angle), b);
	return bgiMetric(sx, sy);
}

function bgiArcInRange(metric: number, start: number, end: number, inv: boolean): boolean {
	return inv ? metric >= start || metric <= end : metric >= start && metric <= end;
}

/**
 * Build the sample polyline for a RIPscrip Bezier.  A point count <= 0 is a
 * RIPterm bug and means 1020 (0x3FC) samples.
 */
export function bezierPolyline(
	x1: number, y1: number,
	x2: number, y2: number,
	x3: number, y3: number,
	x4: number, y4: number,
	cnt: number,
): Point[] {
	const count = cnt <= 0 ? 0x3fc : cnt;
	const pts: Point[] = [{ x: x1, y: y1 }];
	const step = 1.0 / count;
	for (let k = 1; k * step <= 1.0; k++) {
		const t = k * step;
		const tSq = t * t;
		const tCu = t * tSq;
		const r = 1.0 - t;
		const rSq = r * r;
		const rCu = rSq * r;
		const c1 = 3.0 * t * rSq;
		const c2 = 3.0 * tSq * r;
		pts.push({
			x: Math.trunc(rCu * x1 + c1 * x2 + c2 * x3 + tCu * x4),
			y: Math.trunc(rCu * y1 + c1 * y2 + c2 * y3 + tCu * y4),
		});
	}
	pts.push({ x: x4, y: y4 });
	return pts;
}

/** Number of segments a RIPscrip Bezier uses (cnt <= 0 -> 1020). */
export function bezierSampleCount(cnt: number): number {
	return cnt <= 0 ? 0x3fc : cnt;
}

/** BGI's image-size limit: ((w+7)/8) * 4 planes * h + 6 <= 65535. */
export function bgiImageSizeOk(width: number, height: number): boolean {
	const size = Math.trunc((width + 7) / 8) * 4 * height + 6;
	return size <= 65535;
}

const BLACK = 0xff000000;

export class RipRaster {
	readonly width: number;
	readonly height: number;
	readonly data: Uint32Array;
	readonly palette: RipPalette;

	virtualWidth = 640;
	virtualHeight = 350;
	viewport: Viewport = { sx: 0, sy: 0, ex: 639, ey: 349 };

	color = 1;
	fillColor = 7;
	fillStyle = 1;
	fillPattern = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
	linePattern = 0xffff;
	lineStyle = 0;
	lineWidth = 1;
	xor = false;
	borders = true;

	penX = 0;
	penY = 0;
	fontNum = 0;
	fontVertical = 0;
	fontSize = 1;

	private arcCollect: Point[] | null = null;

	constructor(width = 640, height = 350, palette?: RipPalette | readonly number[]) {
		this.width = Math.max(1, Math.trunc(width));
		this.height = Math.max(1, Math.trunc(height));
		this.data = new Uint32Array(this.width * this.height);
		this.data.fill(BLACK);
		this.palette = palette instanceof RipPalette
			? palette
			: new RipPalette(palette);
	}

	/** Clear the whole frame to the current background colour (index 0). */
	clear(): void {
		this.data.fill(this.colorRGB(0));
	}

	/** Fill the viewport with the current background colour. */
	eraseViewport(): void {
		if (this.noViewport())
			return;
		for (let y = this.viewport.sy; y <= this.viewport.ey; y++)
			for (let x = this.viewport.sx; x <= this.viewport.ex; x++)
				this.setPixelAbs(x, y, 0);
	}

	/** Set one pixel using absolute virtual coordinates. */
	setPixelAbs(vx: number, vy: number, index: number): void {
		this.putIndex(vx, vy, index, false);
	}

	/** Reset the graphics state without clearing the pixel buffer. */
	resetState(): void {
		this.virtualWidth = 640;
		this.virtualHeight = 350;
		this.viewport = { sx: 0, sy: 0, ex: 639, ey: 349 };
		this.color = 1;
		this.fillColor = 7;
		this.fillStyle = 1;
		this.fillPattern.fill(0xff);
		this.linePattern = 0xffff;
		this.lineStyle = 0;
		this.lineWidth = 1;
		this.xor = false;
		this.borders = true;
		this.penX = 0;
		this.penY = 0;
		this.fontNum = 0;
		this.fontVertical = 0;
		this.fontSize = 1;
		this.palette.reset();
	}

	noViewport(): boolean {
		const v = this.viewport;
		return v.sx === 0 && v.sy === 0 && v.ex === 0 && v.ey === 0;
	}

	mapX(vx: number): number {
		return Math.round((vx * this.width) / this.virtualWidth);
	}

	mapY(vy: number): number {
		return Math.round((vy * this.height) / this.virtualHeight);
	}

	colorRGB(index: number): number {
		return this.palette.color(index);
	}

	/** Find the palette index currently showing an 0xAARRGGBB value. */
	colorIndexOf(rgb: number): number {
		return this.palette.indexOf(rgb);
	}

	private putRGB(vx: number, vy: number, rgb: number): void {
		const px = this.mapX(vx);
		const py = this.mapY(vy);
		if (px < 0 || px >= this.width || py < 0 || py >= this.height)
			return;
		this.data[py * this.width + px] = rgb;
	}

	private putIndex(vx: number, vy: number, index: number, xor: boolean): void {
		const px = this.mapX(vx);
		const py = this.mapY(vy);
		if (px < 0 || px >= this.width || py < 0 || py >= this.height)
			return;
		const off = py * this.width + px;
		if (xor) {
			const cur = this.data[off]!;
			const ci = this.palette.indexOf(cur);
			const ni = ((ci < 0 ? 0 : ci) ^ index) & 0x0f;
			this.data[off] = this.colorRGB(ni);
		}
		else {
			this.data[off] = this.colorRGB(index);
		}
	}

	/** Set one viewport-relative pixel (no write mode). */
	setPixelRel(x: number, y: number, index: number): void {
		if (this.noViewport())
			return;
		if (x < 0 || x > this.viewport.ex - this.viewport.sx)
			return;
		if (y < 0 || y > this.viewport.ey - this.viewport.sy)
			return;
		this.putIndex(this.viewport.sx + x, this.viewport.sy + y, index, false);
	}

	/** Set one viewport-relative pixel, honouring the XOR write mode. */
	drawPixelRel(x: number, y: number): void {
		if (this.noViewport())
			return;
		if (x < 0 || x > this.viewport.ex - this.viewport.sx)
			return;
		if (y < 0 || y > this.viewport.ey - this.viewport.sy)
			return;
		this.putIndex(this.viewport.sx + x, this.viewport.sy + y, this.color, this.xor);
	}

	/** Patterned fill at a viewport-relative position. */
	fillPixelRel(x: number, y: number): void {
		const ax = this.viewport.sx + x;
		const ay = this.viewport.sy + y;
		if (ax > this.viewport.ex || ay > this.viewport.ey)
			return;
		const fg = this.colorRGB(this.fillColor);
		const bg = this.colorRGB(0);
		const on = (this.fillPattern[ay & 7]! & (0x80 >> (ax & 7))) !== 0;
		this.putRGB(ax, ay, on ? fg : bg);
	}

	private clipLine(
		x1: number, y1: number, x2: number, y2: number,
	): [number, number, number, number] | null {
		// Coordinates reaching drawLine are viewport-relative (the pen,
		// text glyph strokes and every primitive all use that space), so
		// clip against the viewport's *size* rather than its absolute
		// origin.
		const sx = 0;
		const sy = 0;
		const ex = this.viewport.ex - this.viewport.sx;
		const ey = this.viewport.ey - this.viewport.sy;
		for (;;) {
			let oc1 = 0;
			let oc2 = 0;
			if (x1 < sx) oc1 |= 1; else if (x1 > ex) oc1 |= 2;
			if (y1 < sy) oc1 |= 4; else if (y1 > ey) oc1 |= 8;
			if (x2 < sx) oc2 |= 1; else if (x2 > ex) oc2 |= 2;
			if (y2 < sy) oc2 |= 4; else if (y2 > ey) oc2 |= 8;

			if ((oc1 | oc2) === 0)
				return [x1, y1, x2, y2];
			if ((oc1 & oc2) !== 0)
				return null;

			let swapped = false;
			if (oc1 === 0) {
				[x1, x2] = [x2, x1];
				[y1, y2] = [y2, y1];
				[oc1, oc2] = [oc2, oc1];
				swapped = true;
			}

			const dx = x2 - x1;
			const dy = y2 - y1;

			if (oc1 & 1) {
				y1 += Math.trunc(((sx - x1) * dy) / dx);
				x1 = sx;
			}
			else if (oc1 & 2) {
				y1 += Math.trunc(((ex - x1) * dy) / dx);
				x1 = ex;
			}
			else if (oc1 & 4) {
				x1 += Math.trunc(((sy - y1) * dx) / dy);
				y1 = sy;
			}
			else if (oc1 & 8) {
				x1 += Math.trunc(((ey - y1) * dx) / dy);
				y1 = ey;
			}

			if (swapped) {
				[x1, x2] = [x2, x1];
				[y1, y2] = [y2, y1];
			}
		}
	}

	/**
	 * Draw a line between viewport-relative coordinates.  Uses BGI's
	 * Bresenham and Cohen-Sutherland clipping, with optional 3px thickness.
	 */
	drawLine(
		x1: number, y1: number, x2: number, y2: number,
		opts: LineOptions = {},
	): void {
		const color = opts.color ?? this.color;
		const pattern = opts.pattern ?? this.linePattern;
		const width = opts.width ?? this.lineWidth;
		const xor = opts.xor ?? false;

		if (this.noViewport())
			return;

		const origX1 = x1, origY1 = y1, origX2 = x2, origY2 = y2;
		const ldx = x2 - x1, ldy = y2 - y1;
		const clipped = this.clipLine(x1, y1, x2, y2);

		if (clipped !== null) {
			[x1, y1, x2, y2] = clipped;
			let dx = Math.abs(x2 - x1);
			let dy = Math.abs(y2 - y1);
			let swap = false;
			if (y2 < y1) {
				swap = true;
				[x1, x2] = [x2, x1];
				[y1, y2] = [y2, y1];
			}
			void swap;
			const xoff = x2 < x1 ? -1 : 1;
			const yoff = y2 < y1 ? -1 : 1;

			let minC: 'x' | 'y';
			let minS: number;
			let minO: number;
			let minD: number;
			let maxC: 'x' | 'y';
			let maxS: number;
			let maxE: number;
			let maxO: number;
			let maxD: number;

			let x = x1;
			let y = y1;
			if (dx >= dy) {
				minC = 'y'; minS = y1; minO = yoff; minD = dy;
				maxC = 'x'; maxS = x1; maxE = x2; maxO = xoff; maxD = dx;
			}
			else {
				minC = 'x'; minS = x1; minO = xoff; minD = dx;
				maxC = 'y'; maxS = y1; maxE = y2; maxO = yoff; maxD = dy;
			}

			let de = 2 * minD - maxD;
			let ppos = 0;
			let c = minS;
			const setC = (v: number): void => {
				if (minC === 'x') x = v; else y = v;
			};
			setC(c);
			let mc = maxS;
			const maxIter = Math.abs(maxE - maxS) + 1;
			for (let n = 0; n < maxIter; n++, mc += maxO) {
				if (maxC === 'x') x = mc; else y = mc;
				if ((pattern & (1 << ppos)) !== 0) {
					if (xor)
						this.drawPixelRel(x, y);
					else
						this.setPixelRel(x, y, color);
				}
				if (de >= 0) {
					c += minO;
					setC(c);
					de = de - ((2 * maxD) & 0x7fffffff);
				}
				de = de + ((2 * minD) & 0x7fffffff);
				ppos = (ppos + 1) & 0x0f;
			}
		}

		if (width === 3) {
			const origAdx = Math.abs(ldx);
			const origAdy = Math.abs(ldy);
			for (let side = -1; side <= 1; side += 2) {
				let ox1: number, oy1: number, ox2: number, oy2: number;
				if (origAdx >= origAdy) {
					ox1 = origX1; oy1 = origY1 + side;
					ox2 = origX2; oy2 = origY2 + side;
				}
				else {
					ox1 = origX1 + side; oy1 = origY1;
					ox2 = origX2 + side; oy2 = origY2;
				}
				this.drawLine(ox1, oy1, ox2, oy2, {
					color, pattern, width: 1, xor,
				});
			}
		}
	}

	/**
	 * Draw a Bezier curve using the current line style.  Kept public so
	 * tests can observe the polyline.
	 */
	drawBezier(
		x1: number, y1: number,
		x2: number, y2: number,
		x3: number, y3: number,
		x4: number, y4: number,
		cnt: number,
	): void {
		const pts = bezierPolyline(x1, y1, x2, y2, x3, y3, x4, y4, cnt);
		this.penX = x1;
		this.penY = y1;
		for (const p of pts) {
			this.drawLine(this.penX, this.penY, p.x, p.y, { xor: this.xor });
			this.penX = p.x;
			this.penY = p.y;
		}
	}

	private ellipsePlot(
		xc: number, yc: number, x: number, y: number,
		a: number, b: number,
		sa: number, ea: number, startLimit: number, endLimit: number,
		fill: boolean, inv: boolean, color: number, pass: number,
	): void {
		void a; void b; void sa; void ea;
		if (pass === 0) {
			if (!fill)
				return;
			if (y === 0) {
				for (let fx = xc - x; fx <= xc + x; fx++)
					this.fillPixelRel(fx, yc);
			}
			else {
				for (let fx = xc - x; fx <= xc + x; fx++) {
					this.fillPixelRel(fx, yc + y);
					this.fillPixelRel(fx, yc - y);
				}
			}
			return;
		}

		const collect = this.arcCollect;
		if (collect !== null) {
			if (bgiArcInRange(y - x, startLimit, endLimit, inv))
				collect.push({ x: xc + x, y: yc - y });
			if (bgiArcInRange(x - y + 2000, startLimit, endLimit, inv))
				collect.push({ x: xc - x, y: yc - y });
			if (bgiArcInRange(y - x + 4000, startLimit, endLimit, inv))
				collect.push({ x: xc - x, y: yc + y });
			if (bgiArcInRange(x - y + 6000, startLimit, endLimit, inv))
				collect.push({ x: xc + x, y: yc + y });
		}

		if (this.borders && this.lineWidth !== 3) {
			if (bgiArcInRange(y - x, startLimit, endLimit, inv))
				this.setPixelRel(xc + x, yc - y, color);
			if (bgiArcInRange(x - y + 2000, startLimit, endLimit, inv))
				this.setPixelRel(xc - x, yc - y, color);
			if (bgiArcInRange(y - x + 4000, startLimit, endLimit, inv))
				this.setPixelRel(xc - x, yc + y, color);
			if (bgiArcInRange(x - y + 6000, startLimit, endLimit, inv))
				this.setPixelRel(xc + x, yc + y, color);
		}
	}

	/**
	 * BGI ellipse/arc.  `fill` fills with the current fill pattern;
	 * otherwise the border is drawn in `color`.
	 */
	fullEllipse(
		xc: number, yc: number, sa: number, ea: number,
		a: number, b: number, fill: boolean, color: number,
	): void {
		const thickSweep = this.lineWidth === 3 && this.borders && !fill;
		if (sa % 360 === ea % 360 && !(sa === 0 && ea === 360) && !thickSweep)
			return;

		const origA = a, origB = b;
		if (a === 0) a = 1;
		if (b === 0) b = 1;

		const startLimit = bgiArcLimit(a, b, sa);
		const endLimit = bgiArcLimit(a, b, ea);
		const inv = endLimit <= startLimit;

		const bigger = Math.max(a, b);
		const aSq100 = bigger * bigger * 100;
		const step = Math.trunc(Math.trunc(aSq100 / a) / a);
		const stepConst = Math.trunc(Math.trunc(aSq100 / b) / b);
		const temp = stepConst * b;

		for (let pass = 0; pass < 2; pass++) {
			if (pass === 0 && !fill)
				continue;
			if (pass === 1 && thickSweep)
				continue;

			let x = 0;
			let y = b;
			let error = temp * b - aSq100;
			let delta = 2 * temp;
			let incr = 0;
			let incrAccum = 0;
			let threshold = 0;

			const plot = (): void => {
				this.ellipsePlot(xc, yc, x, y, a, b, sa, ea,
					startLimit, endLimit, fill, inv, color, pass);
			};
			const updateIncr = (): void => {
				incr = incrAccum + step;
				threshold = delta - stepConst;
			};
			const decY = (): void => {
				y--;
				error -= threshold;
				delta = threshold - stepConst;
			};
			const incX = (): void => {
				x++;
				error += incr;
				incrAccum = incr + step;
			};

			plot();
			updateIncr();
			if (2 * error + 2 * incr >= threshold)
				decY();
			incX();
			while (incrAccum < delta) {
				plot();
				updateIncr();
				if (2 * error + 2 * incr >= threshold)
					decY();
				incX();
			}
			while (y >= 0) {
				plot();
				updateIncr();
				if (Math.trunc(incr / 2) + error <= threshold)
					incX();
				decY();
			}
		}

		if (this.lineWidth === 3 && this.borders) {
			let sweepEa = ea;
			if (sa >= ea)
				sweepEa = ea + 360;
			const savedPattern = this.linePattern;
			this.linePattern = 0xffff;
			let prevX = xc + bgiTrigMul(bgiCos32(sa), origA);
			let prevY = yc - bgiTrigMul(bgiSin32(sa), origB);
			let normalDrawn = false;
			let dupDrawn = false;
			for (let deg = sa + 1; deg <= sweepEa; deg++) {
				const curX = xc + bgiTrigMul(bgiCos32(deg), origA);
				const curY = yc - bgiTrigMul(bgiSin32(deg), origB);
				if (curX !== prevX || curY !== prevY) {
					this.drawLine(prevX, prevY, curX, curY);
					prevX = curX;
					prevY = curY;
					normalDrawn = true;
					dupDrawn = false;
				}
				else if (normalDrawn && !dupDrawn) {
					this.drawLine(curX, curY, curX, curY);
					dupDrawn = true;
				}
			}
			this.linePattern = savedPattern;
			// RIPterm bug: custom line style gets clobbered here.
			if (this.lineStyle === 4)
				this.linePattern = 0x8000;
		}
	}

	/** Draw a filled pie slice (RIP_ARC-style angles). */
	pieSlice(
		xc: number, yc: number, sa: number, ea: number,
		radiusX: number, radiusY: number, color: number,
	): void {
		if (sa > ea)
			[sa, ea] = [ea, sa];
		for (let subSa = sa; subSa < ea;) {
			const nextBoundary = (Math.trunc(subSa / 90) + 1) * 90;
			const subEa = nextBoundary < ea ? nextBoundary : ea;
			if (subEa - subSa >= 2) {
				const savedBorders = this.borders;
				this.borders = false;
				this.arcCollect = [];
				this.fullEllipse(xc, yc, subSa, subEa, radiusX, radiusY, false, color);
				this.borders = savedBorders;
				const arc = this.arcCollect;
				this.arcCollect = null;
				this.piePolyFill(xc, yc, arc ?? []);
				if (this.borders && arc !== null) {
					for (let i = 1; i < arc.length; i++)
						this.drawLine(arc[i - 1]!.x, arc[i - 1]!.y, arc[i]!.x, arc[i]!.y);
				}
			}
			subSa = subEa;
		}
		if (this.borders) {
			let ex = xc + bgiTrigMul(bgiCos32(sa), radiusX);
			let ey = yc - bgiTrigMul(bgiSin32(sa), radiusY);
			this.drawLine(xc, yc, ex, ey);
			ex = xc + bgiTrigMul(bgiCos32(ea), radiusX);
			ey = yc - bgiTrigMul(bgiSin32(ea), radiusY);
			this.drawLine(xc, yc, ex, ey);
		}
	}

	/** Draw an elliptical pie slice. */
	ovalPieSlice(
		xc: number, yc: number, sa: number, ea: number,
		radiusX: number, radiusY: number, color: number,
	): void {
		if (radiusX === 0 && radiusY === 0)
			return;
		for (let subSa = sa; subSa < ea;) {
			const nextBoundary = (Math.trunc(subSa / 90) + 1) * 90;
			const subEa = nextBoundary < ea ? nextBoundary : ea;
			if (subEa - subSa >= 2) {
				const savedBorders = this.borders;
				this.borders = false;
				this.arcCollect = [];
				this.fullEllipse(xc, yc, subSa, subEa, radiusX, radiusY, false, color);
				this.borders = savedBorders;
				const arc = this.arcCollect;
				this.arcCollect = null;
				this.piePolyFill(xc, yc, arc ?? []);
				if (this.borders && arc !== null) {
					for (let i = 1; i < arc.length; i++)
						this.drawLine(arc[i - 1]!.x, arc[i - 1]!.y, arc[i]!.x, arc[i]!.y);
				}
			}
			subSa = subEa;
		}
		if (this.borders) {
			let ex = xc + bgiTrigMul(bgiCos32(sa), radiusX);
			let ey = yc - bgiTrigMul(bgiSin32(sa), radiusY);
			this.drawLine(xc, yc, ex, ey);
			ex = xc + bgiTrigMul(bgiCos32(ea), radiusX);
			ey = yc - bgiTrigMul(bgiSin32(ea), radiusY);
			this.drawLine(xc, yc, ex, ey);
		}
	}

	private piePolyFill(cx: number, cy: number, arc: Point[]): void {
		if (arc.length === 0)
			return;
		const pts = arc.slice();
		pts.push({ x: cx, y: cy });
		pts.push({ x: arc[0]!.x, y: arc[0]!.y });
		this.scanlinePolyFill(pts);
	}

	private static readonly SEP: Point = { x: -2147483648, y: 0 };

	private scanlinePolyFill(pts: Point[]): void {
		if (this.fillStyle === 0 || pts.length < 2)
			return;
		let minY = Number.MAX_SAFE_INTEGER;
		let maxY = -Number.MAX_SAFE_INTEGER;
		for (const p of pts) {
			if (p.x === RipRaster.SEP.x)
				continue;
			if (p.y < minY) minY = p.y;
			if (p.y > maxY) maxY = p.y;
		}
		if (minY > maxY)
			return;

		const isects: number[] = [];
		for (let y = minY; y <= maxY; y++) {
			isects.length = 0;
			for (let i = 0; i + 1 < pts.length; i++) {
				const a = pts[i]!;
				const b = pts[i + 1]!;
				if (a.x === RipRaster.SEP.x || b.x === RipRaster.SEP.x)
					continue;
				let y0 = a.y, y1 = b.y, x0 = a.x, x1 = b.x;
				if (y1 < y0) {
					[y0, y1] = [y1, y0];
					[x0, x1] = [x1, x0];
				}
				if (y0 === y1)
					continue;
				if (y < y0 || y >= y1)
					continue;
				const ix = x0 + Math.trunc(((y - y0) * (x1 - x0)) / (y1 - y0));
				let j = isects.length;
				while (j > 0 && isects[j - 1]! > ix) {
					isects[j] = isects[j - 1]!;
					j--;
				}
				isects[j] = ix;
			}
			for (let k = 0; k + 1 < isects.length; k += 2) {
				for (let fx = isects[k]!; fx <= isects[k + 1]!; fx++)
					this.fillPixelRel(fx, y);
			}
		}
	}

	private collectVertices(raw: Point[], closePoly: boolean): Point[] {
		const buf: Point[] = [];
		let vcnt = 0;
		let first = 0;
		for (let i = 0; i < raw.length; i++) {
			const p = raw[i]!;
			const match = p.x === raw[first]!.x && p.y === raw[first]!.y;
			if (vcnt === 0) {
				buf.push({ x: p.x, y: p.y });
				vcnt = 1;
				first = i;
			}
			else if (match && vcnt === 1) {
				continue;
			}
			else if (match) {
				buf.push({ x: p.x, y: p.y });
				buf.push({ x: RipRaster.SEP.x, y: 0 });
				vcnt = 0;
			}
			else {
				buf.push({ x: p.x, y: p.y });
				vcnt++;
			}
		}
		if (closePoly)
			buf.push({ x: raw[0]?.x ?? 0, y: raw[0]?.y ?? 0 });
		buf.push({ x: RipRaster.SEP.x, y: 0 });
		return buf;
	}

	private drawPolyOutline(buf: Point[]): void {
		for (let i = 0; i + 1 < buf.length; i++) {
			if (buf[i]!.x === RipRaster.SEP.x || buf[i + 1]!.x === RipRaster.SEP.x)
				continue;
			this.drawLine(buf[i]!.x, buf[i]!.y, buf[i + 1]!.x, buf[i + 1]!.y);
		}
	}

	/** Draw a polygon through the supplied vertices, auto-closing it. */
	drawPolygon(points: Point[], filled: boolean): void {
		if (points.length < 2)
			return;
		const raw = points.map(p => ({ x: p.x, y: p.y }));
		raw.push({ x: points[0]!.x, y: points[0]!.y });
		const buf = this.collectVertices(raw, filled);
		if (filled) {
			this.scanlinePolyFill(buf);
			if (this.color !== 0)
				this.drawPolyOutline(buf);
		}
		else {
			this.drawPolyOutline(buf);
		}
	}

	/** Draw a polyline (not closed). */
	drawPolyline(points: Point[]): void {
		for (let i = 1; i < points.length; i++) {
			this.drawLine(points[i - 1]!.x, points[i - 1]!.y,
				points[i]!.x, points[i]!.y);
		}
	}

	/**
	 * Scanline flood fill.  Deliberately stops on the fill colour as well as
	 * the border colour (RIPterm behaviour).
	 */
	floodFill(seedX: number, seedY: number, borderIndex: number): void {
		if (this.noViewport())
			return;
		const w = this.viewport.ex - this.viewport.sx + 1;
		const h = this.viewport.ey - this.viewport.sy + 1;
		if (seedX < 0 || seedY < 0 || seedX >= w || seedY >= h)
			return;

		const border = this.colorRGB(borderIndex);
		const fg = this.colorRGB(this.fillColor);
		const bg = this.colorRGB(0);

		const get = (x: number, y: number): number => {
			const px = this.mapX(this.viewport.sx + x);
			const py = this.mapY(this.viewport.sy + y);
			if (px < 0 || px >= this.width || py < 0 || py >= this.height)
				return border;
			return this.data[py * this.width + px]!;
		};
		const put = (x: number, y: number): void => {
			const ax = this.viewport.sx + x;
			const ay = this.viewport.sy + y;
			const on = (this.fillPattern[ay & 7]! & (0x80 >> (ax & 7))) !== 0;
			this.putRGB(ax, ay, on ? fg : bg);
		};
		const fillable = (c: number): boolean => c !== border && c !== fg;

		if (!fillable(get(seedX, seedY)))
			return;

		const stack: Point[] = [{ x: seedX, y: seedY }];
		const seen = new Uint8Array(w * h);
		let guard = 0;
		while (stack.length > 0 && guard++ < w * h * 8) {
			const seed = stack.pop()!;
			const sy = seed.y;
			let x = seed.x;
			if (!fillable(get(x, sy)))
				continue;
			while (x > 0 && fillable(get(x - 1, sy)))
				x--;
			let spanUp = false;
			let spanDown = false;
			for (; x < w && fillable(get(x, sy)); x++) {
				if (seen[sy * w + x] !== 0)
					break;
				seen[sy * w + x] = 1;
				put(x, sy);
				if (sy > 0) {
					const up = fillable(get(x, sy - 1)) && seen[(sy - 1) * w + x] === 0;
					if (up && !spanUp) {
						stack.push({ x, y: sy - 1 });
						spanUp = true;
					}
					else if (!up) {
						spanUp = false;
					}
				}
				if (sy < h - 1) {
					const dn = fillable(get(x, sy + 1)) && seen[(sy + 1) * w + x] === 0;
					if (dn && !spanDown) {
						stack.push({ x, y: sy + 1 });
						spanDown = true;
					}
					else if (!dn) {
						spanDown = false;
					}
				}
			}
		}
	}

	charWidth(ch: number): number {
		void ch;
		return 8 * this.fontSize;
	}

	textWidth(str: string): number {
		let tw = 0;
		for (let i = 0; i < str.length; i++) {
			if (str[i] === '\n')
				continue;
			tw += this.charWidth(str.charCodeAt(i));
		}
		return tw;
	}

	fontHeight(): number {
		return 8 * this.fontSize;
	}

	/** Draw one character at the pen position. */
	drawChar(ch: number): void {
		if (this.noViewport())
			return;
		const vw = this.viewport.ex - this.viewport.sx;
		const vh = this.viewport.ey - this.viewport.sy;
		const size = this.fontSize;
		const color = this.color;

		if (this.fontVertical === 0) {
			const clipExt = 8 * size - 2;
			if (this.penX < 0 || this.penX >= vw - clipExt
				|| this.penY < 0 || this.penY >= vh - clipExt) {
				this.penX += 8 * size;
				return;
			}
		}

		const glyph = (ch & 0xff) * 8;
		if (this.fontVertical !== 0) {
			for (let y = 0; y < 8; y++) {
				for (let x = 0; x < 8; x++) {
					if ((FONT8X8[glyph + y]! & (0x80 >> x)) === 0)
						continue;
					for (let ys = 0; ys < size; ys++) {
						for (let xs = 0; xs < size; xs++) {
							this.setPixelRel(
								this.penX + y * size + ys - 8 * size,
								this.penY - x * size - xs - 1,
								color,
							);
						}
					}
				}
			}
			this.penY += 8 * size;
		}
		else {
			for (let y = 0; y < 8; y++) {
				for (let x = 0; x < 8; x++) {
					if ((FONT8X8[glyph + y]! & (0x80 >> x)) === 0)
						continue;
					for (let ys = 0; ys < size; ys++) {
						for (let xs = 0; xs < size; xs++) {
							this.setPixelRel(
								this.penX + x * size + xs,
								this.penY + y * size + ys,
								color,
							);
						}
					}
				}
			}
			this.penX += 8 * size;
		}
	}

	/** Draw text at the pen position; newlines are ignored, as upstream. */
	drawText(str: string): void {
		if (this.fontVertical !== 0) {
			const sx = this.penX;
			const sy = this.penY;
			let tw = 0;
			for (let i = 0; i < str.length; i++) {
				if (str[i] !== '\n')
					tw += this.charWidth(str.charCodeAt(i));
			}
			this.penY += tw;
			const cy = this.penY;
			for (let i = 0; i < str.length; i++) {
				if (str[i] === '\n')
					continue;
				this.penX = sx;
				this.penY = cy;
				this.drawChar(str.charCodeAt(i));
				this.penY -= this.charWidth(str.charCodeAt(i));
			}
			this.penY = sy;
			this.penX = sx + tw;
		}
		else {
			for (let i = 0; i < str.length; i++) {
				if (str[i] === '\n')
					continue;
				this.drawChar(str.charCodeAt(i));
			}
		}
	}

	/** Capture a viewport-relative rectangle for the clipboard. */
	capture(x0: number, y0: number, x1: number, y1: number): RasterImage | null {
		if (this.noViewport())
			return null;
		let sx = x0 + this.viewport.sx;
		let sy = y0 + this.viewport.sy;
		let ex = x1 + this.viewport.sx;
		let ey = y1 + this.viewport.sy;
		if (sx > ex) [sx, ex] = [ex, sx];
		if (sy > ey) [sy, ey] = [ey, sy];
		const w = ex - sx + 1;
		const h = ey - sy + 1;
		if (w <= 0 || h <= 0)
			return null;
		const data = new Uint32Array(w * h);
		for (let y = 0; y < h; y++) {
			const py = this.mapY(sy + y);
			for (let x = 0; x < w; x++) {
				const px = this.mapX(sx + x);
				data[y * w + x] = (px >= 0 && px < this.width && py >= 0 && py < this.height)
					? this.data[py * this.width + px]!
					: BLACK;
			}
		}
		return { width: w, height: h, data };
	}

	/** Paste a captured image at a viewport-relative position. */
	blit(image: RasterImage, x: number, y: number, mode: number): void {
		const bx = this.mapX(x + this.viewport.sx);
		const by = this.mapY(y + this.viewport.sy);
		for (let iy = 0; iy < image.height; iy++) {
			const py = by + iy;
			if (py < 0 || py >= this.height)
				continue;
			for (let ix = 0; ix < image.width; ix++) {
				const px = bx + ix;
				if (px < 0 || px >= this.width)
					continue;
				const off = py * this.width + px;
				const src = image.data[iy * image.width + ix]!;
				const dst = this.data[off]!;
				switch (mode) {
					case 0:
						this.data[off] = src;
						break;
					case 1: {
						const si = this.palette.indexOf(src);
						const di = this.palette.indexOf(dst);
						this.data[off] = this.colorRGB(((si < 0 ? 0 : si) ^ (di < 0 ? 0 : di)) & 0x0f);
						break;
					}
					case 2:
						this.data[off] = (src | dst) | 0xff000000;
						break;
					case 3:
						this.data[off] = src & dst | 0xff000000;
						break;
					case 4:
						this.data[off] = (~src) | 0xff000000;
						break;
					default:
						this.data[off] = src;
						break;
				}
			}
		}
	}
}
