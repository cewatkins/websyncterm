import type { JSX } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
	emptyEntry,
	exportSynctermLst,
	parseSynctermLst,
	type DirectoryEntry,
} from './directory.js';
import type { Protocol } from '@websyncterm/core';

/** The protocols offered in the editor. */
const PROTOCOLS: { value: Protocol; label: string }[] = [
	{ value: 'telnet', label: 'Telnet' },
	{ value: 'telnets', label: 'TelnetS (TLS)' },
	{ value: 'ssh', label: 'SSH' },
	{ value: 'rlogin', label: 'RLogin' },
	{ value: 'raw', label: 'Raw TCP' },
];

/** Props for {@link DirectoryView}. */
export interface DirectoryViewProps {
	entries: DirectoryEntry[];
	onSelect: (entry: DirectoryEntry) => void;
	onSave: (entry: DirectoryEntry) => void;
	onDelete: (id: string) => void;
	onConnect: (entry: DirectoryEntry) => void;
	onImport: (entries: DirectoryEntry[]) => void;
	/** The id of the currently selected entry. */
	selectedId: string | null;
}

/**
 * The dialing directory: a searchable list plus an entry editor.
 */
export function DirectoryView({
	entries,
	onSelect,
	onSave,
	onDelete,
	onConnect,
	onImport,
	selectedId,
}: DirectoryViewProps): JSX.Element {
	const [query, setQuery] = useState('');
	const [draft, setDraft] = useState<DirectoryEntry | null>(null);
	const fileInput = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (!selectedId) {
			setDraft(null);
			return;
		}
		const found = entries.find((e) => e.id === selectedId);
		if (found) setDraft({ ...found });
	}, [selectedId, entries]);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const list = entries.filter((e) => !e.isFolder);
		if (needle === '') return list;
		return list.filter(
			(e) =>
				e.name.toLowerCase().includes(needle) ||
				e.address.toLowerCase().includes(needle) ||
				e.notes.toLowerCase().includes(needle),
		);
	}, [entries, query]);

	const update = (patch: Partial<DirectoryEntry>): void => {
		setDraft((current) => (current ? { ...current, ...patch } : current));
	};

	const handleImportFile = async (file: File): Promise<void> => {
		const text = await file.text();
		try {
			onImport(parseSynctermLst(text));
		} catch {
			// The caller surfaces the error.
		}
	};

	return (
		<div className="directory">
			<div className="directory__list">
				<div className="directory__toolbar">
					<input
						className="directory__search"
						type="search"
						placeholder="Search systems…"
						aria-label="Search the dialing directory"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<button
						type="button"
						className="btn"
						onClick={() => {
							const entry = emptyEntry();
							setDraft(entry);
							onSelect(entry);
						}}
					>
						Add
					</button>
					<button
						type="button"
						className="btn"
						onClick={() => fileInput.current?.click()}
					>
						Import
					</button>
					<button
						type="button"
						className="btn"
						onClick={() => {
							const blob = new Blob([exportSynctermLst(entries)], { type: 'text/plain' });
							const url = URL.createObjectURL(blob);
							const link = document.createElement('a');
							link.href = url;
							link.download = 'syncterm.lst';
							link.click();
							URL.revokeObjectURL(url);
						}}
					>
						Export
					</button>
					<input
						ref={fileInput}
						type="file"
						accept=".lst,text/plain"
						hidden
						onChange={(event) => {
							const file = event.target.files?.[0];
							if (file) void handleImportFile(file);
							event.target.value = '';
						}}
					/>
				</div>

				{filtered.length === 0 ? (
					<p className="directory__empty">No systems yet. Choose “Add” to create one.</p>
				) : (
					<div role="listbox" aria-label="Dialing directory">
						{filtered.map((entry) => (
							<div
								key={entry.id}
								role="option"
								tabIndex={0}
								aria-selected={entry.id === selectedId}
								className="entry"
								onClick={() => onSelect(entry)}
								onKeyDown={(event) => {
									if (event.key === 'Enter' || event.key === ' ') {
										event.preventDefault();
										onSelect(entry);
									}
								}}
								onDoubleClick={() => onConnect(entry)}
							>
								<span className="entry__name">{entry.name}</span>
								<span className="entry__meta">
									{entry.address}:{entry.port} · {entry.protocol}
									{entry.username ? ` · ${entry.username}` : ''}
								</span>
								<span className="entry__actions">
									<button
										type="button"
										className="btn btn--primary"
										onClick={(event) => {
											event.stopPropagation();
											onConnect(entry);
										}}
									>
										Connect
									</button>
								</span>
							</div>
						))}
					</div>
				)}
			</div>

			<div className="directory__editor">
				{draft ? (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							onSave(draft);
						}}
					>
						<div className="field">
							<label htmlFor="entry-name">Name</label>
							<input
								id="entry-name"
								value={draft.name}
								onChange={(event) => update({ name: event.target.value })}
							/>
						</div>
						<div className="field">
							<label htmlFor="entry-address">Address</label>
							<input
								id="entry-address"
								value={draft.address}
								onChange={(event) => update({ address: event.target.value })}
							/>
						</div>
						<div className="field">
							<label htmlFor="entry-port">Port</label>
							<input
								id="entry-port"
								type="number"
								min={1}
								max={65535}
								value={draft.port}
								onChange={(event) => update({ port: Number(event.target.value) || 23 })}
							/>
						</div>
						<div className="field">
							<label htmlFor="entry-protocol">Protocol</label>
							<select
								id="entry-protocol"
								value={draft.protocol}
								onChange={(event) => update({ protocol: event.target.value as Protocol })}
							>
								{PROTOCOLS.map((p) => (
									<option key={p.value} value={p.value}>
										{p.label}
									</option>
								))}
							</select>
						</div>
						<div className="field">
							<label htmlFor="entry-user">Username</label>
							<input
								id="entry-user"
								autoComplete="username"
								value={draft.username}
								onChange={(event) => update({ username: event.target.value })}
							/>
						</div>
						<div className="field">
							<label htmlFor="entry-pass">Password</label>
							<input
								id="entry-pass"
								type="password"
								autoComplete="current-password"
								value={draft.password}
								onChange={(event) => update({ password: event.target.value })}
							/>
						</div>
						<div className="field">
							<label htmlFor="entry-syspass">System password</label>
							<input
								id="entry-syspass"
								type="password"
								autoComplete="off"
								value={draft.systemPassword}
								onChange={(event) => update({ systemPassword: event.target.value })}
							/>
						</div>
						<div className="field">
							<label htmlFor="entry-mode">Screen mode</label>
							<input
								id="entry-mode"
								value={draft.screenMode}
								onChange={(event) => update({ screenMode: event.target.value })}
							/>
						</div>
						<div className="field">
							<label htmlFor="entry-font">Font</label>
							<input
								id="entry-font"
								value={draft.font}
								onChange={(event) => update({ font: event.target.value })}
							/>
						</div>
						<div className="field">
							<label htmlFor="entry-speed">Speed (bps, 0 = unlimited)</label>
							<input
								id="entry-speed"
								type="number"
								min={0}
								value={draft.speed}
								onChange={(event) => update({ speed: Number(event.target.value) || 0 })}
							/>
						</div>
						<div className="field field--row">
							<input
								id="entry-ansi"
								type="checkbox"
								checked={draft.ansi}
								onChange={(event) => update({ ansi: event.target.checked })}
							/>
							<label htmlFor="entry-ansi">ANSI</label>
							<input
								id="entry-rip"
								type="checkbox"
								checked={draft.rip}
								onChange={(event) => update({ rip: event.target.checked })}
							/>
							<label htmlFor="entry-rip">RIP</label>
							<input
								id="entry-music"
								type="checkbox"
								checked={draft.music}
								onChange={(event) => update({ music: event.target.checked })}
							/>
							<label htmlFor="entry-music">Music</label>
						</div>
						<div className="field">
							<label htmlFor="entry-notes">Notes</label>
							<textarea
								id="entry-notes"
								rows={3}
								value={draft.notes}
								onChange={(event) => update({ notes: event.target.value })}
							/>
						</div>
						<div className="dialog__actions">
							<button
								type="button"
								className="btn btn--danger"
								onClick={() => {
									onDelete(draft.id);
									setDraft(null);
								}}
							>
								Delete
							</button>
							<button type="submit" className="btn btn--primary">
								Save
							</button>
						</div>
					</form>
				) : (
					<p className="directory__empty">Select a system to edit it.</p>
				)}
			</div>
		</div>
	);
}
