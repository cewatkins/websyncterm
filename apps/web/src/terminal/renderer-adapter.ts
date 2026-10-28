/**
 * The renderer adapter.
 *
 * All interaction with `@websyncterm/render` is confined to this file so
 * that the web app does not have to change if the renderer's API shifts.
 */

import type { CTerm, Palette, ScreenBuffer } from '@websyncterm/core';
import type { BitmapFont, Renderer, ScreenMode, VideoMode } from '@websyncterm/render';

/** Options for the renderer adapter. */
export interface RendererAdapterOptions {
	canvas: HTMLCanvasElement;
	/** Called when the user selects a link. */
	onOpenLink?: (uri: string) => void;
}

/** A cell coordinate on the screen. */
export interface CellPoint {
	x: number;
	y: number;
}

/**
 * Wraps the render package's `Renderer`.
 */
export class RendererAdapter {
	private renderer: Renderer | null = null;
	private font: BitmapFont | null = null;
	private mode: VideoMode | null = null;
	private frame: number | null = null;
	private blinkOn = true;

	constructor(private readonly opts: RendererAdapterOptions) {}

	/** Attach to a canvas and start the render loop. */
	start(): void {
		if (this.renderer) return;
		this.renderer = new (RendererCtor as unknown as new (
			canvas: HTMLCanvasElement,
			options: unknown,
		) => Renderer)(this.opts.canvas, { onOpenLink: this.opts.onOpenLink });
		this.loop();
	}

	/** Stop the render loop and release resources. */
	stop(): void {
		if (this.frame !== null) {
			cancelAnimationFrame(this.frame);
			this.frame = null;
		}
		this.renderer?.destroy();
		this.renderer = null;
	}

	/** Set the bitmap font. */
	setFont(font: BitmapFont | null): void {
		this.font = font;
		this.renderer?.setFont(font);
	}

	/** Set the screen mode. */
	setMode(mode: VideoMode | null): void {
		this.mode = mode;
		this.renderer?.setMode(mode);
	}

	/** The current screen mode. */
	getMode(): VideoMode | null {
		return this.mode;
	}

	/** Handle a resize. */
	resize(): void {
		this.renderer?.resize();
	}

	/** Take a PNG screenshot of the screen. */
	async screenshot(): Promise<Blob | null> {
		return (await this.renderer?.screenshot()) ?? null;
	}

	/** Convert a pointer position to a cell coordinate. */
	pointToCell(clientX: number, clientY: number): CellPoint | null {
		return this.renderer?.pointToCell(clientX, clientY) ?? null;
	}

	private loop = (): void => {
		this.frame = requestAnimationFrame(this.loop);
		this.blinkOn = !this.blinkOn;
	};
}

/**
 * Lazily resolve the render package's `Renderer` constructor.
 *
 * The render package is imported dynamically so that the terminal engine can
 * be used in a worker without pulling in the DOM code.
 */
let RendererCtor: unknown = null;

/** Load the render package. */
export async function loadRenderer(): Promise<void> {
	if (RendererCtor) return;
	const mod = await import('@websyncterm/render');
	RendererCtor = mod.Renderer;
}

/** The terminal types the adapter renders. */
export type { ScreenMode, VideoMode };
