import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { encodeKey, type KeyEvent as TermKeyEvent } from '@websyncterm/core';
import type { TerminalApi } from './useTerminal.js';
import { OnScreenKeyboard } from '../ui/OnScreenKeyboard.js';

/** Map a browser keyboard event to the terminal's key model. */
export function toTermKeyEvent(event: React.KeyboardEvent): TermKeyEvent | null {
	const modifiers = {
		shift: event.shiftKey,
		alt: event.altKey,
		ctrl: event.ctrlKey,
	};
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
	const key = named[event.key];
	if (key) {
		// Shift+Tab is reported separately by the browser.
		if (event.key === 'Tab' && event.shiftKey) return { key: 'backTab', modifiers };
		return { key, modifiers };
	}
	if (event.key.length === 1) {
		return { char: event.key, modifiers };
	}
	return null;
}

/** Props for {@link TerminalPane}. */
export interface TerminalPaneProps {
	api: TerminalApi;
	/** Whether a session is active. */
	connected: boolean;
	/** Called when the user asks to disconnect. */
	onDisconnect: () => void;
	/** Called when the user asks to toggle fullscreen. */
	onToggleFullscreen: () => void;
	/** Called when the user asks to take a screenshot. */
	onScreenshot: () => void;
}

/**
 * The terminal canvas plus its keyboard handling.
 */
export function TerminalPane({
	api,
	connected,
	onDisconnect,
	onToggleFullscreen,
	onScreenshot,
}: TerminalPaneProps): JSX.Element {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const [keyboard, setKeyboard] = useState(false);
	const [message, setMessage] = useState('');

	// Depend on attachCanvas itself, not on the whole api object: the api is
	// a new object on every render, and that would tear down and rebuild the
	// renderer on every frame.
	const { attachCanvas } = api;
	const attach = useCallback(
		(node: HTMLCanvasElement | null) => {
			canvasRef.current = node;
			attachCanvas(node);
		},
		[attachCanvas],
	);

	// Keep the canvas focused so that keystrokes reach the terminal.
	useEffect(() => {
		canvasRef.current?.focus();
	}, []);

	const onKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLCanvasElement>) => {
			// Let the browser handle the browser-level shortcuts.
			if (event.altKey && event.key === 'Enter') {
				event.preventDefault();
				onToggleFullscreen();
				return;
			}
			if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') {
				return;
			}
			const termEvent = toTermKeyEvent(event);
			if (!termEvent) return;
			event.preventDefault();
			const bytes = encodeKey(termEvent, {
				emulation: api.term?.emulation,
				decBkm: api.term?.decBkm ?? true,
			});
			if (bytes.length > 0) api.send(bytes);
		},
		[api, onToggleFullscreen],
	);

	const onPaste = useCallback(
		(event: React.ClipboardEvent<HTMLCanvasElement>) => {
			const text = event.clipboardData.getData('text');
			if (!text) return;
			event.preventDefault();
			api.send(new TextEncoder().encode(text));
		},
		[api],
	);

	return (
		<div className="terminal">
			<canvas
				ref={attach}
				className="terminal__canvas"
				tabIndex={0}
				role="application"
				aria-label="BBS terminal"
				onKeyDown={onKeyDown}
				onPaste={onPaste}
			/>
			<div className="terminal__overlay">
				<button
					type="button"
					className="btn"
					onClick={() => canvasRef.current?.focus()}
				>
					Focus
				</button>
				<button type="button" className="btn" onClick={() => setKeyboard((v) => !v)}>
					{keyboard ? 'Hide keyboard' : 'Keyboard'}
				</button>
				<button type="button" className="btn" onClick={onScreenshot}>
					Screenshot
				</button>
				<button type="button" className="btn" onClick={onToggleFullscreen}>
					Fullscreen
				</button>
				<button type="button" className="btn btn--danger" onClick={onDisconnect} disabled={!connected}>
					Disconnect
				</button>
			</div>
			{message ? <div className="terminal__hint">{message}</div> : null}
			{keyboard ? (
				<OnScreenKeyboard
					onKey={(bytes) => api.send(bytes)}
					onDismiss={() => setKeyboard(false)}
				/>
			) : null}
		</div>
	);
}
