/**
 * The terminal hook.
 *
 * Wires the core terminal engine, the render package, the RIP interpreter and
 * the file-transfer engine together, and exposes a small imperative API to
 * the React layer.
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
	scaledWinSize,
	type BitmapFont,
	type VideoMode,
} from '@websyncterm/render';
import { RipInterpreter } from '@websyncterm/rip';
import { detectTransfer, detectXModem } from '@websyncterm/xfer';
import { loadBuiltinFonts } from './fonts.js';
import { useTransfers, type TransfersApi } from '../transfer/useTransfers.js';

/** The font the terminal starts with. */
const DEFAULT_FONT_SLOT = 0;

/**
 * How many incoming bytes are held back before being displayed.
 *
 * The hold-back lets the transfer detector recognise a ZMODEM or XMODEM
 * handshake and remove it from the screen, exactly as SyncTERM does.
 */
const LOOKBEHIND = 64;

/** Options for {@link useTerminal}. */
export interface UseTerminalOptions {
	/** The initial screen mode name, e.g. `C80`. */
	mode?: string;
	/** The initial emulation. */
	emulation?: TermEmulationName;
	/** Whether the RIP interpreter is enabled. */
	rip?: boolean;
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
	transfers: TransfersApi;
	/**
	 * Attach the canvas to the renderer.
	 *
	 * This must be called from the canvas element's ref callback; without it
	 * nothing is ever painted.
	 */
	attachCanvas: (canvas: HTMLCanvasElement | null) => void;
}

/**
 * Create and own a terminal session.
 */
export function useTerminal(options: UseTerminalOptions = {}): TerminalApi {
	const termRef = useRef<CTerm | null>(null);
	const connRef = useRef<ConnectionManager | null>(null);
	const rendererRef = useRef<Renderer | null>(null);
	const resizeObserverRef = useRef<ResizeObserver | null>(null);
	const builtinRef = useRef<BuiltinFontSet | null>(null);
	const ripRef = useRef<RipInterpreter | null>(null);
	const ripVersionRef = useRef(0);
	const lookbehindRef = useRef<number[]>([]);
	const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const transferActiveRef = useRef(false);

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

	const send = useCallback((data: Uint8Array) => {
		connRef.current?.send(data);
		setBytesOut((n) => n + data.length);
	}, []);

	const transfers = useTransfers(send);

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

	// Create the RIP interpreter when RIP is enabled.
	useEffect(() => {
		if (!options.rip) {
			ripRef.current = null;
			rendererRef.current?.setRipLayer(null);
			return;
		}
		const term = termRef.current;
		if (!term) return;
		const mode = VIDEO_MODE_LIST.find((m) => m.name === modeName) ?? VIDEO_MODE_LIST[3];
		ripRef.current = new RipInterpreter({
			width: mode.cols * mode.cellW,
			height: mode.rows * mode.cellH,
		});
		ripVersionRef.current = 0;
		return () => {
			ripRef.current = null;
		};
	}, [options.rip, modeName]);

	// Attach the renderer to the canvas.
	const attachCanvas = useCallback(
		(canvas: HTMLCanvasElement | null) => {
			if (!canvas) {
				resizeObserverRef.current?.disconnect();
				resizeObserverRef.current = null;
				rendererRef.current?.destroy();
				rendererRef.current = null;
				return;
			}
			// Recreate the renderer when the mode or the font changes so that
			// the new geometry is applied.
			if (rendererRef.current) {
				rendererRef.current.destroy();
				rendererRef.current = null;
			}
			const renderer = new Renderer(canvas);
			rendererRef.current = renderer;
			const font = builtinRef.current?.getFont(fontSlot, 16);
			if (font) renderer.setFont(font);
			renderer.setMode(modeName);
			renderer.resize();

			// Scale the terminal by the largest whole multiple that fits the
			// available space, so the pixels stay square.
			const container = canvas.parentElement;
			if (container && typeof ResizeObserver !== 'undefined') {
				resizeObserverRef.current?.disconnect();
				const observer = new ResizeObserver(() => {
					const active = rendererRef.current;
					if (!active) return;
					const mode = active.getMode();
					const width = container.clientWidth;
					const height = container.clientHeight;
					if (width <= 0 || height <= 0) return;
					// The largest whole multiple of the (aspect-corrected)
					// screen that fits the available space.
					let scale = 1;
					for (let candidate = 1; candidate <= 32; candidate++) {
						const display = scaledWinSize(mode, candidate);
						if (display.width > width || display.height > height) break;
						scale = candidate;
					}
					if (scale === active.getScale()) return;
					active.setScale(scale);
					active.resize();
				});
				observer.observe(container);
				resizeObserverRef.current = observer;
			}
		},
		[modeName, fontSlot],
	);

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
				visible: term.cursorVisible,
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
			resizeObserverRef.current?.disconnect();
			rendererRef.current?.destroy();
		},
		[],
	);

	/**
	 * Route incoming bytes.
	 *
	 * The bytes go through the RIP interpreter (when enabled) and are held
	 * back briefly so that a ZMODEM handshake can be removed from the screen.
	 */
	const handleIncoming = useCallback(
		(data: Uint8Array) => {
			const term = termRef.current;
			if (!term) return;
			let payload = data;

			const rip = ripRef.current;
			if (rip) {
				rip.feed(data);
				const text = rip.takeText();
				payload = text ? new TextEncoder().encode(text) : new Uint8Array(0);
				ripVersionRef.current += 1;
				const buffer = rip.pixelBuffer;
				rendererRef.current?.setRipLayer({
					data: buffer.data,
					width: buffer.width,
					height: buffer.height,
					version: ripVersionRef.current,
				});
			}

			if (transferActiveRef.current) {
				// The bytes belong to the transfer protocol.
				transfers.receive(payload);
				return;
			}

			// Hold back the tail so that a transfer handshake can be removed.
			const held = lookbehindRef.current;
			for (const byte of payload) held.push(byte);

			// The held bytes are flushed once the remote goes quiet, so a
			// static screen is never left with a partial last line.
			if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current);
			flushTimerRef.current = setTimeout(() => {
				flushTimerRef.current = null;
				const pending = lookbehindRef.current;
				if (pending.length === 0 || transferActiveRef.current) return;
				const display = pending.splice(0, pending.length);
				termRef.current?.write(Uint8Array.from(display));
			}, 150);

			// Look for a transfer handshake at the end of the held bytes.
			if (held.length >= 4) {
				const tail = Uint8Array.from(held.slice(-4));
				const kind = detectTransfer(tail);
				if (kind) {
					const display = held.slice(0, held.length - 4);
					held.length = 0;
					if (display.length > 0) term.write(Uint8Array.from(display));
					transferActiveRef.current = true;
					transfers.start(kind);
					return;
				}
			}
			if (held.length >= 2) {
				const tail = Uint8Array.from(held.slice(-2));
				const kind = detectXModem(tail);
				if (kind) {
					const display = held.slice(0, held.length - 2);
					held.length = 0;
					if (display.length > 0) term.write(Uint8Array.from(display));
					transferActiveRef.current = true;
					transfers.start(kind);
					return;
				}
			}

			if (held.length <= LOOKBEHIND) return;
			const display = held.slice(0, held.length - LOOKBEHIND);
			held.splice(0, display.length);
			term.write(Uint8Array.from(display));
		},
		[transfers],
	);

	const connect = useCallback(
		(options2: ConnectOptions) => {
			const term = termRef.current;
			if (!term) return;
			lookbehindRef.current = [];
			transferActiveRef.current = false;
			const conn = new ConnectionManager({
				onData: (data) => {
					handleIncoming(data);
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
		[handleIncoming],
	);

	const disconnect = useCallback(() => {
		connRef.current?.close();
	}, []);

	const setMode = useCallback((name: string) => {
		setModeName(name);
		const mode = VIDEO_MODE_LIST.find((m) => m.name === name);
		const term = termRef.current;
		if (!mode || !term) return;
		term.resize(mode.cols, mode.rows);
		rendererRef.current?.setMode(mode);
	}, []);

	const setFont = useCallback(
		(slot: number) => {
			setFontSlot(slot);
			const height = VIDEO_MODE_LIST.find((m) => m.name === modeName)?.cellH ?? 16;
			const font: BitmapFont | null =
				builtinRef.current?.getFont(slot, height as 8 | 14 | 16 | 20) ?? null;
			if (font) rendererRef.current?.setFont(font);
		},
		[modeName],
	);

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
		transfers,
		attachCanvas,
	};
}
