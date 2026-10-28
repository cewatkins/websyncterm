import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { TerminalPane } from './terminal/TerminalPane.js';
import { useTerminal } from './terminal/useTerminal.js';
import { DirectoryStore, type DirectoryEntry } from './directory/directory.js';
import { DirectoryView } from './directory/DirectoryView.js';
import { StatusBar } from './ui/StatusBar.js';
import { TransferPanel } from './ui/TransferPanel.js';
import { Dialog } from './ui/Dialog.js';

/**
 * Read the `?bbs=host:port&proto=…` URL parameters.
 */
function readUrlTarget(): { host: string; port: number; proto: string } | null {
	if (typeof location === 'undefined') return null;
	const params = new URLSearchParams(location.search);
	const bbs = params.get('bbs');
	if (!bbs) return null;
	const [host, port] = bbs.split(':');
	return {
		host: host ?? '',
		port: port ? Number(port) : 23,
		proto: params.get('proto') ?? 'telnet',
	};
}

/**
 * The application root.
 */
export function App(): JSX.Element {
	const store = useMemo(() => new DirectoryStore(), []);
	const [entries, setEntries] = useState<DirectoryEntry[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [showDirectory, setShowDirectory] = useState(true);
	const [system, setSystem] = useState('');
	const [speed, setSpeed] = useState(0);
	const [linkPrompt, setLinkPrompt] = useState<string | null>(null);
	const [error, setError] = useState('');
	const [ripEnabled, setRipEnabled] = useState(false);
	// iCE colours are the default: the blink attribute selects a bright
	// background rather than blinking, which is what ANSI art and the
	// Synchronet ICE_COLOR terminal flag expect.
	const [iceColours, setIceColours] = useState<boolean>(() => {
		const stored = localStorage.getItem('websyncterm.iceColours');
		return stored === null ? true : stored === '1';
	});

	const api = useTerminal({
		rip: ripEnabled,
		iceColours,
		onOpenLink: (uri) => {
			if (/^(https?|telnet):/i.test(uri)) setLinkPrompt(uri);
		},
	});

	// Load the directory.
	useEffect(() => {
		void store.list().then(setEntries).catch(() => setError('The dialing directory could not be read.'));
	}, [store]);

	// Connect automatically when the URL names a system.
	useEffect(() => {
		const target = readUrlTarget();
		if (!target || !target.host) return;
		api.connect({
			host: target.host,
			port: target.port,
			protocol: target.proto as never,
		});
		setSystem(target.host);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const connect = useCallback(
		(entry: DirectoryEntry) => {
			setError('');
			setSystem(entry.name || entry.address);
			setSpeed(entry.speed);
			setRipEnabled(entry.rip);
			api.connect({
				host: entry.address,
				port: entry.port,
				protocol: entry.protocol,
				username: entry.username,
				password: entry.password,
				systemPassword: entry.systemPassword,
				speed: entry.speed,
			});
			void store.markCalled(entry.id);
			setShowDirectory(false);
		},
		[api, store],
	);

	// Expose a debug hook for the end-to-end tests and for troubleshooting.
	useEffect(() => {
		localStorage.setItem('websyncterm.iceColours', iceColours ? '1' : '0');
	}, [iceColours]);

	useEffect(() => {
		if (typeof location === 'undefined') return;
		if (!new URLSearchParams(location.search).has('debug')) return;
		(window as unknown as { __wst?: unknown }).__wst = { api, entries, connect };
	}, [api, entries, connect]);

	const save = useCallback(
		(entry: DirectoryEntry) => {
			void store.save(entry).then(() => {
				void store.list().then(setEntries);
			});
		},
		[store],
	);

	const remove = useCallback(
		(id: string) => {
			void store.remove(id).then(() => {
				void store.list().then(setEntries);
				setSelectedId(null);
			});
		},
		[store],
	);

	const importEntries = useCallback(
		(incoming: DirectoryEntry[]) => {
			void Promise.all(incoming.map((entry) => store.save(entry))).then(() => {
				void store.list().then(setEntries);
			});
		},
		[store],
	);

	const toggleFullscreen = useCallback(() => {
		if (document.fullscreenElement) {
			void document.exitFullscreen();
		} else {
			void document.documentElement.requestFullscreen?.();
		}
	}, []);

	const screenshot = useCallback(() => {
		const canvas = document.querySelector<HTMLCanvasElement>('.terminal__canvas');
		if (!canvas) return;
		canvas.toBlob((blob) => {
			if (!blob) return;
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = 'screen.png';
			link.click();
			URL.revokeObjectURL(url);
		});
	}, []);

	return (
		<div className="app">
			<div className="app__toolbar">
				<span className="app__title">WebSyncTERM</span>
				<button
					type="button"
					className="btn"
					onClick={() => setShowDirectory((v) => !v)}
					aria-pressed={showDirectory}
				>
					Directory
				</button>
				<label className="btn" htmlFor="mode-select">
					Mode
					<select
						id="mode-select"
						value={api.term ? modeOf(api) : ''}
						onChange={(event) => api.setMode(event.target.value)}
						style={{ background: 'transparent', color: 'inherit', border: 'none' }}
					>
						{api.videoModes.map((mode) => (
							<option key={mode.name} value={mode.name}>
								{mode.cols}×{mode.rows}
							</option>
						))}
					</select>
				</label>
				<label className="btn" htmlFor="ice-select">
					Colours
					<select
						id="ice-select"
						value={iceColours ? 'ice' : 'blink'}
						onChange={(event) => setIceColours(event.target.value === 'ice')}
						style={{ background: 'transparent', color: 'inherit', border: 'none' }}
					>
						<option value="ice">iCE (bright background)</option>
						<option value="blink">Blink</option>
					</select>
				</label>
				<label className="btn" htmlFor="font-select">
					Font
					<select
						id="font-select"
						onChange={(event) => api.setFont(Number(event.target.value))}
						style={{ background: 'transparent', color: 'inherit', border: 'none' }}
					>
						{api.builtinFonts
							? api.builtinFonts.names.map((name, index) => (
									<option key={index} value={index}>
										{name}
									</option>
								))
							: null}
					</select>
				</label>
				<button type="button" className="btn" onClick={toggleFullscreen}>
					Fullscreen
				</button>
			</div>

			{error ? (
				<div className="banner" role="alert">
					{error}
				</div>
			) : null}

			{api.detail && api.state !== 'connected' ? (
				<div className="banner" role="alert">
					{api.detail}
				</div>
			) : null}

			<div className="app__main">
				{showDirectory ? (
					<DirectoryView
						entries={entries}
						selectedId={selectedId}
						onSelect={(entry) => setSelectedId(entry.id)}
						onSave={save}
						onDelete={remove}
						onConnect={connect}
						onImport={importEntries}
					/>
				) : (
					<>
						<TerminalPane
							api={api}
							connected={api.state === 'connected'}
							onDisconnect={() => {
								api.disconnect();
								setShowDirectory(true);
							}}
							onToggleFullscreen={toggleFullscreen}
							onScreenshot={screenshot}
						/>
						<TransferPanel transfers={api.transfers} />
					</>
				)}
			</div>

			<StatusBar
				state={api.state}
				detail={api.detail}
				system={system}
				mode={api.term ? `${api.term.cols}×${api.term.rows}` : '—'}
				speed={speed}
				elapsed={api.elapsed}
				bytesIn={api.bytesIn}
				bytesOut={api.bytesOut}
			/>

			{linkPrompt ? (
				<Dialog
					title="Open this link?"
					onClose={() => setLinkPrompt(null)}
					confirmLabel="Open"
					onConfirm={() => {
						window.open(linkPrompt, '_blank', 'noopener,noreferrer');
						setLinkPrompt(null);
					}}
				>
					<p>The BBS asked to open an external link:</p>
					<p>
						<code>{linkPrompt}</code>
					</p>
				</Dialog>
			) : null}
		</div>
	);
}

function modeOf(api: ReturnType<typeof useTerminal>): string {
	const current = api.videoModes.find((m) => m.cols === api.term?.cols && m.rows === api.term?.rows);
	return current?.name ?? 'C80';
}
