/**
 * The `<web-syncterm>` custom element.
 *
 * A small, dependency-light widget that embeds a full SyncTERM-compatible
 * terminal in a page. It is deliberately framework-free so that the embed
 * bundle stays small.
 */

import {
	CTerm,
	ConnectionManager,
	encodeKey,
	type KeyEvent as TermKeyEvent,
	type Protocol,
} from '@websyncterm/core';
import { Renderer, VIDEO_MODE_LIST, type BitmapFont } from '@websyncterm/render';

/** The attributes the element understands. */
const ATTRIBUTES = {
	host: 'host',
	port: 'port',
	proto: 'proto',
	mode: 'mode',
	user: 'user',
	pass: 'pass',
	syspass: 'syspass',
	gateway: 'gateway',
	font: 'font',
	speed: 'speed',
	token: 'token',
	ice: 'ice',
} as const;

/** Options read from the element's attributes. */
export interface EmbedOptions {
	host: string;
	port: number;
	protocol: Protocol;
	mode: string;
	user: string;
	pass: string;
	syspass: string;
	gateway: string;
	font: string;
	speed: number;
	token: string;
	/** "1" for iCE colours (bright background), "0" for blink. */
	ice: string;
}

/**
 * Read the element's options.
 */
export function readOptions(element: HTMLElement): EmbedOptions {
	const get = (name: string): string => element.getAttribute(name) ?? '';
	const port = parseInt(get(ATTRIBUTES.port), 10);
	const speed = parseInt(get(ATTRIBUTES.speed), 10);
	return {
		host: get(ATTRIBUTES.host),
		port: Number.isFinite(port) && port > 0 ? port : 23,
		protocol: (get(ATTRIBUTES.proto) || 'telnet') as Protocol,
		mode: get(ATTRIBUTES.mode) || '80x25',
		user: get(ATTRIBUTES.user),
		pass: get(ATTRIBUTES.pass),
		syspass: get(ATTRIBUTES.syspass),
		gateway: get(ATTRIBUTES.gateway),
		font: get(ATTRIBUTES.font),
		speed: Number.isFinite(speed) ? speed : 0,
		token: get(ATTRIBUTES.token),
		ice: get(ATTRIBUTES.ice),
	};
}

/**
 * The `<web-syncterm>` element.
 */
export class WebSyncTermElement extends HTMLElement {
	private term: CTerm | null = null;
	private renderer: Renderer | null = null;
	private connection: ConnectionManager | null = null;
	private frame = 0;
	private status: HTMLElement | null = null;
	private connected = false;

	/** The element's shadow root. */
	private get root(): ShadowRoot {
		if (!this.shadowRoot) throw new Error('The element is not attached to the document.');
		return this.shadowRoot;
	}

	/** Called when the element is connected to the document. */
	connectedCallback(): void {
		if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
		this.root.innerHTML = TEMPLATE;
		this.status = this.root.querySelector('.status');
		this.setupCanvas();
	}

	/** Called when the element is removed from the document. */
	disconnectedCallback(): void {
		this.teardown();
	}

	/** Read the options again and reconnect. */
	attributeChangedCallback(): void {
		if (!this.shadowRoot) return;
		if (this.connected) this.connect();
	}

	/** Connect to the configured BBS. */
	connect(): void {
		const options = readOptions(this);
		if (!options.host) {
			this.setStatus('No host configured');
			return;
		}
		this.teardown();

		const mode =
			VIDEO_MODE_LIST.find(
				(m) => m.cols === parseInt(options.mode.split('x')[0], 10) && m.rows === parseInt(options.mode.split('x')[1], 10),
			) ?? VIDEO_MODE_LIST[3];

		this.term = new CTerm({
			cols: mode.cols,
			rows: mode.rows,
			// iCE colours are the default; "ice=0" selects blinking.
			onResponse: (data) => this.connection?.send(data),
			onHyperlink: (uri) => {
				if (/^(https?|telnet):/i.test(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
			},
		});
		this.term.setIceColors(options.ice !== '0');

		const canvas = this.root.querySelector<HTMLCanvasElement>('canvas');
		if (canvas) {
			this.renderer = new Renderer(canvas);
			this.renderer.setMode(mode);
			void this.loadFont(options.font);
			this.startRenderLoop();
		}

		this.connection = new ConnectionManager({
			onData: (data) => this.term?.write(data),
			onState: (state, detail) => {
				this.connected = state === 'connected';
				this.setStatus(
					state === 'connected'
						? `Connected to ${options.host}:${options.port}`
						: state === 'error'
							? `Error: ${detail ?? 'connection failed'}`
							: state === 'connecting'
								? 'Connecting…'
								: 'Disconnected',
				);
				this.root.querySelector('.connect')?.toggleAttribute('disabled', this.connected);
			},
		});
		this.connection.connect({
			host: options.host,
			port: options.port,
			protocol: options.protocol,
			username: options.user,
			password: options.pass,
			systemPassword: options.syspass,
			speed: options.speed,
			gateway: options.gateway || undefined,
			token: options.token || undefined,
			cols: mode.cols,
			rows: mode.rows,
		});
	}

	/** Disconnect. */
	disconnect(): void {
		this.connection?.close();
		this.connected = false;
		this.setStatus('Disconnected');
		this.root.querySelector('.connect')?.removeAttribute('disabled');
	}

	private setupCanvas(): void {
		const canvas = this.root.querySelector<HTMLCanvasElement>('canvas');
		if (!canvas) return;
		canvas.addEventListener('keydown', (event) => this.onKeyDown(event));
		canvas.addEventListener('paste', (event) => {
			const text = (event as ClipboardEvent).clipboardData?.getData('text');
			if (!text) return;
			event.preventDefault();
			this.connection?.send(new TextEncoder().encode(text));
		});
		this.root.querySelector('.connect')?.addEventListener('click', () => {
			if (this.connected) this.disconnect();
			else this.connect();
		});
		this.root.querySelector('.fullscreen')?.addEventListener('click', () => {
			if (document.fullscreenElement) void document.exitFullscreen();
			else void this.requestFullscreen();
		});
		canvas.focus();
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (event.altKey && event.key === 'Enter') {
			event.preventDefault();
			if (document.fullscreenElement) void document.exitFullscreen();
			else void this.requestFullscreen();
			return;
		}
		const termEvent = toTermKeyEvent(event);
		if (!termEvent) return;
		event.preventDefault();
		const bytes = encodeKey(termEvent, { decBkm: this.term?.decBkm ?? true });
		if (bytes.length > 0) this.connection?.send(bytes);
	}

	private async loadFont(name: string): Promise<void> {
		try {
			const response = await fetch(FONT_URL);
			if (!response.ok) return;
			const set = (await import('@websyncterm/render')).parseBuiltinFonts(await response.text());
			const height = (this.term ? VIDEO_MODE_LIST.find((m) => m.cols === this.term?.cols && m.rows === this.term?.rows)?.cellH : 16) ?? 16;
			const slot = name ? set.names.indexOf(name) : 0;
			const font: BitmapFont | null = set.getFont(slot >= 0 ? slot : 0, height as 8 | 14 | 16 | 20);
			if (font) this.renderer?.setFont(font);
		} catch {
			// The default font is used when the asset cannot be loaded.
		}
	}

	private startRenderLoop(): void {
		const loop = (): void => {
			this.frame = requestAnimationFrame(loop);
			if (this.term && this.renderer) {
				this.renderer.render(this.term.screen, this.term.palette, {
					x: this.term.xpos,
					y: this.term.ypos,
					style: this.term.cursorStyle,
					visible: this.term.cursorVisible,
				});
			}
		};
		this.frame = requestAnimationFrame(loop);
	}

	private teardown(): void {
		if (this.frame) cancelAnimationFrame(this.frame);
		this.frame = 0;
		this.connection?.close();
		this.connection = null;
		this.renderer?.destroy();
		this.renderer = null;
		this.term = null;
	}

	private setStatus(text: string): void {
		if (this.status) this.status.textContent = text;
	}
}

/**
 * The base URL of the embed bundle.
 *
 * The bundle is loaded with a `<script src>` tag, so the fonts are fetched
 * relative to the script rather than to the host page.
 */
const SCRIPT_BASE = ((): string => {
	if (typeof document === 'undefined') return './';
	const script = document.currentScript as HTMLScriptElement | null;
	if (script?.src) return new URL('.', script.src).href;
	return new URL('.', document.baseURI).href;
})();

/** The URL of the built-in font asset. */
const FONT_URL = new URL('assets/fonts/builtin-fonts.json', SCRIPT_BASE).href;

/**
 * Map a browser keyboard event to the terminal's key model.
 */
export function toTermKeyEvent(event: KeyboardEvent): TermKeyEvent | null {
	const named: Record<string, TermKeyEvent['key']> = {
		ArrowUp: 'up',
		ArrowDown: 'down',
		ArrowLeft: 'left',
		ArrowRight: 'right',
		Home: 'home',
		End: 'end',
		PageUp: 'pageUp',
		PageDown: 'pageDown',
		Insert: 'insert',
		Delete: 'delete',
		Backspace: 'backspace',
		Tab: 'tab',
		Enter: 'enter',
		Escape: 'escape',
		F1: 'f1', F2: 'f2', F3: 'f3', F4: 'f4', F5: 'f5', F6: 'f6',
		F7: 'f7', F8: 'f8', F9: 'f9', F10: 'f10', F11: 'f11', F12: 'f12',
	};
	const modifiers = { shift: event.shiftKey, alt: event.altKey, ctrl: event.ctrlKey };
	const key = named[event.key];
	if (key) {
		if (event.key === 'Tab' && event.shiftKey) return { key: 'backTab', modifiers };
		return { key, modifiers };
	}
	if (event.key.length === 1) return { char: event.key, modifiers };
	return null;
}

const TEMPLATE = `
<style>
	:host {
		display: block;
		background: #000;
		border: 1px solid #5555ff;
		border-radius: 4px;
		overflow: hidden;
		font-family: ui-monospace, monospace;
		color: #ffff55;
	}
	.toolbar {
		display: flex;
		gap: 0.35rem;
		padding: 0.3rem;
		background: #000066;
		border-bottom: 1px solid #5555ff;
		align-items: center;
	}
	.toolbar button {
		font: inherit;
		font-size: 0.85em;
		background: #000088;
		color: #ffff55;
		border: 1px solid #5555ff;
		border-radius: 3px;
		padding: 0.15rem 0.55rem;
		cursor: pointer;
	}
	.toolbar button:hover:not(:disabled) { background: #5555ff; color: #000; }
	.toolbar button:focus-visible { outline: 2px solid #55ffff; outline-offset: 1px; }
	.status { margin-left: auto; font-size: 0.8em; color: #aaaa55; }
	canvas { display: block; width: 100%; height: auto; background: #000; outline: none; }
</style>
<div class="toolbar">
	<button type="button" class="connect">Connect</button>
	<button type="button" class="fullscreen">Fullscreen</button>
	<span class="status" role="status" aria-live="polite">Disconnected</span>
</div>
<canvas tabindex="0" role="application" aria-label="BBS terminal"></canvas>
`;

/**
 * Register the custom element.
 */
export function defineWebSyncTerm(tag = 'web-syncterm'): void {
	if (typeof customElements === 'undefined') return;
	if (!customElements.get(tag)) {
		customElements.define(tag, WebSyncTermElement);
	}
}
