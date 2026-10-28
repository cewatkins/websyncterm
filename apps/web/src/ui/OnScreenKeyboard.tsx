import type { JSX } from 'react';
import { useCallback } from 'react';
import { encodeKey, Key } from '@websyncterm/core';

/** The keys shown on the touch keyboard. */
const ROWS: string[][] = [
	['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
	['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
	['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';'],
	['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/'],
];

/** The named keys shown on the touch keyboard. */
const SPECIAL: { label: string; key: string }[] = [
	{ label: 'Tab', key: Key.Tab },
	{ label: 'Esc', key: Key.Escape },
	{ label: '←', key: Key.Left },
	{ label: '↑', key: Key.Up },
	{ label: '↓', key: Key.Down },
	{ label: '→', key: Key.Right },
	{ label: '⌫', key: Key.Backspace },
	{ label: 'Enter', key: Key.Enter },
];

/** Props for {@link OnScreenKeyboard}. */
export interface OnScreenKeyboardProps {
	onKey: (bytes: Uint8Array) => void;
	onDismiss: () => void;
}

/**
 * A touch keyboard for mobile devices.
 */
export function OnScreenKeyboard({ onKey, onDismiss }: OnScreenKeyboardProps): JSX.Element {
	const press = useCallback(
		(char: string) => {
			onKey(encodeKey({ char }));
		},
		[onKey],
	);
	const pressNamed = useCallback(
		(key: string) => {
			onKey(encodeKey({ key: key as never }));
		},
		[onKey],
	);

	return (
		<div className="keyboard" role="group" aria-label="On-screen keyboard">
			{ROWS.map((row, rowIndex) => (
				<div key={rowIndex} style={{ display: 'flex', gap: '0.25rem', width: '100%' }}>
					{row.map((char) => (
						<button key={char} type="button" onClick={() => press(char)}>
							{char}
						</button>
					))}
				</div>
			))}
			<div style={{ display: 'flex', gap: '0.25rem', width: '100%' }}>
				{SPECIAL.map((item) => (
					<button key={item.key} type="button" onClick={() => pressNamed(item.key)}>
						{item.label}
					</button>
				))}
				<button type="button" onClick={onDismiss}>
					Hide
				</button>
			</div>
		</div>
	);
}
