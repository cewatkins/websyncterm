/**
 * The terminal hook.
 *
 * Wires the core terminal engine, the render package and the connection
 * manager together, and exposes a small imperative API to the React layer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
	CTerm,
	ConnectionManager,
	type ConnectOptions,
	type ConnectionState,
	type TermEmulationName,
} from '@websyncterm/core';
import {
	BuiltinFontSet,
	Renderer,
	VIDEO_MODE_LIST,
	type BitmapFont,
	type VideoMode,
} from '@websyncterm/render';
import { loadBuiltinFonts } from './fonts.js';

/** The font the terminal starts with. */
const DEFAULT_FONT_SLOT = 0;

/** Options for {@link useTerminal}. */
export interface UseTerminalOptions {
	/** The initial screen mode name, e.g. `80x25`. */
	mode?: string;
	/** The initial emulation. */
	emulation?: TermEmulationName;
	/** Called when the user activates a hyperlink. */
	onOpenLink?: (uri: string) => void;
}

/** The API returned by {@link useTerminal}. */
export interface TerminalApi {
	term: CTerm | null;
	connect: (options: ConnectOptions) => void;
	disconnect: () => void;
	send: (data: Uint8Array) => void;
	state: ConnectionState;
	detail: string;
	setMode: (mode: string) => void;
	setFont: (slot: number) => void;
	builtinFonts: BuiltinFontSet | null;
	videoModes: readonly VideoMode[];
	elapsed: number;
	bytesIn: number;
	bytesOut: number;
}

/**
 * Create and own a terminal session.
 */
export function useTerminal(options: UseTerminalOptions = {}): TerminalApi {
	const termRef = useRef<CTerm | null>(null);
	const connRef = useRef<ConnectionManager | null>(null);
	const rendererRef = useRef<Renderer | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const builtinRef = useRef<BuiltinFontSet | null>(null);

	const [state, setState] = useState<ConnectionState>('idle');
	const [detail, setDetail] = useState('');
	const [builtinFonts, setBuiltinFonts] = useState<BuiltinFontSet | null>(null);
	const [modeName, setModeName] = useState(options.mode ?? 'C80');
	const [fontSlot, setFontSlot] = useState(DEFAULT_FONT_SLOT);
	const [elapsed, setElapsed] = useState(0);
	const [bytesIn, setBytesIn] = useState(0);
	const [bytesOut, setBytesOut] = useState(0);

	// Create the terminal engine once.
	if (!termRef.current) {
		const mode = VIDEO_MODE_LIST.find((m) => m.name === modeName) ?? VIDEO_MODE_LIST[3];
		termRef.current = new CTerm({
			cols: mode.cols,
			rows: mode.rows,
			onResponse: (data) => {
				connRef.current?.send(data);
				setBytesOut((n) => n + data.length);
			},
			onHyperlink: (uri) => options.onOpenLink?.(uri),
		});
	}

	// Load the built-in font data.
	useEffect(() => {
		let cancelled = false;
		void loadBuiltinFonts().then((set) => {
			if (cancelled) return;
			builtinRef.current = set;
			setBuiltinFonts(set);
			const font = set.getFont(DEFAULT_FONT_SLOT, 16);
			if (font) rendererRef.current?.setFont(font);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	// Attach the renderer to the canvas.
	const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
		canvasRef.current = canvas;
		if (!canvas) {
			rendererRef.current?.destroy();
			rendererRef.current = null;
			return;
		}
		if (rendererRef.current) return;
		const renderer = new Renderer(canvas);
		rendererRef.current = renderer;
		const font = builtinRef.current?.getFont(fontSlot, 16) ?? null;
		if (font) renderer.setFont(font);
		renderer.setMode(modeName);
	}, [modeName, fontSlot, options.onOpenLink]);

	// The render loop.
	useEffect(() => {
		let frame = 0;
		const loop = (): void => {
			frame = requestAnimationFrame(loop);
			const term = termRef.current;
			const renderer = rendererRef.current;
			if (!term || !renderer) return;
			renderer.render(term.screen, term.palette, {
				x: term.xpos,
				y: term.ypos,
				style: term.cursorStyle,
				visible: (term.extattr & 2) !== 0,
			});
		};
		frame = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(frame);
	}, []);

	// The elapsed-time ticker.
	useEffect(() => {
		const id = setInterval(() => {
			if (state === 'connected') setElapsed((n) => n + 1);
		}, 1000);
		return () => clearInterval(id);
	}, [state]);

	// Clean up on unmount.
	useEffect(
		() => () => {
			connRef.current?.close();
			rendererRef.current?.destroy();
		},
		[],
	);

	const connect = useCallback(
		(options2: ConnectOptions) => {
			const term = termRef.current;
			if (!term) return;
			const conn = new ConnectionManager({
				onData: (data) => {
					term.write(data);
					setBytesIn((n) => n + data.length);
				},
				onState: (next, why) => {
					setState(next);
					setDetail(why ?? '');
					if (next === 'disconnected') setElapsed(0);
				},
				onMessage: (message) => {
					if (message.type === 'hostkey') {
						// The host key is accepted automatically in the web app.
						// A stricter deployment should verify the fingerprint
						// server-side before allowing the connection.
						conn.sendControl({ type: 'hostkey-ok', accept: true });
					}
				},
			});
			connRef.current = conn;
			conn.connect(options2);
		},
		[],
	);

	const disconnect = useCallback(() => {
		connRef.current?.close();
	}, []);

	const send = useCallback((data: Uint8Array) => {
		connRef.current?.send(data);
		setBytesOut((n) => n + data.length);
	}, []);

	const setMode = useCallback((name: string) => {
		setModeName(name);
		const mode = VIDEO_MODE_LIST.find((m) => m.name === name);
		const term = termRef.current;
		if (!mode || !term) return;
		term.resize(mode.cols, mode.rows);
		rendererRef.current?.setMode(mode);
	}, []);

	const setFont = useCallback((slot: number) => {
		setFontSlot(slot);
		const height = VIDEO_MODE_LIST.find((m) => m.name === modeName)?.cellH ?? 16;
		const font: BitmapFont | null =
			builtinRef.current?.getFont(slot, height as 8 | 14 | 16 | 20) ?? null;
		if (font) rendererRef.current?.setFont(font);
	}, [modeName]);

	return {
		term: termRef.current,
		connect,
		disconnect,
		send,
		state,
		detail,
		setMode,
		setFont,
		builtinFonts,
		videoModes: VIDEO_MODE_LIST,
		elapsed,
		bytesIn,
		bytesOut,
	};
}
