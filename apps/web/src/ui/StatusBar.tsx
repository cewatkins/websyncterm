import type { JSX } from 'react';
import type { ConnectionState } from '@websyncterm/core';

/** Props for {@link StatusBar}. */
export interface StatusBarProps {
	state: ConnectionState;
	detail: string;
	/** The BBS name. */
	system: string;
	/** The current screen mode. */
	mode: string;
	/** The simulated line speed in bits per second (0 = unlimited). */
	speed: number;
	/** The number of seconds connected. */
	elapsed: number;
	bytesIn: number;
	bytesOut: number;
}

/** Format a duration as `HH:MM:SS`. */
export function formatElapsed(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * The status bar.
 *
 * The information mirrors SyncTERM's status row: the connection state, the
 * system name, the screen mode, the speed and the time online.
 */
export function StatusBar({
	state,
	detail,
	system,
	mode,
	speed,
	elapsed,
	bytesIn,
	bytesOut,
}: StatusBarProps): JSX.Element {
	const dotClass =
		state === 'connected' ? 'status-dot status-dot--connected' : state === 'error' ? 'status-dot status-dot--error' : 'status-dot';
	const label =
		state === 'connected'
			? 'Connected'
			: state === 'connecting'
				? 'Connecting…'
				: state === 'error'
					? 'Error'
					: state === 'disconnecting'
						? 'Disconnecting…'
						: 'Not connected';

	return (
		<div className="app__status">
			<span>
				<span className={dotClass} aria-hidden="true" /> <strong>{label}</strong>
			</span>
			<span>
				System: <strong>{system || '—'}</strong>
			</span>
			<span>
				Mode: <strong>{mode}</strong>
			</span>
			<span>
				Speed: <strong>{speed ? `${speed} bps` : 'unlimited'}</strong>
			</span>
			<span>
				Online: <strong>{formatElapsed(elapsed)}</strong>
			</span>
			<span>
				In <strong>{bytesIn}</strong> / Out <strong>{bytesOut}</strong>
			</span>
			{detail ? (
				<span role="status" aria-live="polite">
					{detail}
				</span>
			) : null}
		</div>
	);
}
