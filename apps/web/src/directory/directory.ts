/**
 * The dialing directory.
 *
 * SyncTERM stores its dialing directory in an INI file (`syncterm.lst`).
 * The browser keeps an equivalent structure in IndexedDB, with the same
 * fields, plus folders, sort order and an optional last-called timestamp.
 */

import type { Protocol } from '@websyncterm/core';
import { DIRECTORY_STORE, openDatabase } from './db.js';

/** One dialing directory entry. */
export interface DirectoryEntry {
	id: string;
	/** The folder this entry lives in; empty for the root. */
	folder: string;
	/** The display name. */
	name: string;
	/** The host name or IP address. */
	address: string;
	port: number;
	protocol: Protocol;
	username: string;
	password: string;
	systemPassword: string;
	/** The screen mode, e.g. `80x25`. */
	screenMode: string;
	/** The font name (an empty string means the default). */
	font: string;
	/** The connection speed in bits per second; 0 means unlimited. */
	speed: number;
	/** Whether ANSI music is enabled. */
	music: boolean;
	/** Whether RIP is enabled. */
	rip: boolean;
	/** Whether ANSI colour is enabled. */
	ansi: boolean;
	/** Free-form notes. */
	notes: string;
	/** The last time this entry was dialled (epoch ms), or 0. */
	lastCalled: number;
	/** The sort order within the folder. */
	sortOrder: number;
	/** Whether the entry is a folder. */
	isFolder: boolean;
}

/** The default entry for a new connection. */
export function emptyEntry(partial: Partial<DirectoryEntry> = {}): DirectoryEntry {
	return {
		id: crypto.randomUUID(),
		folder: '',
		name: 'New BBS',
		address: '',
		port: 23,
		protocol: 'telnet',
		username: '',
		password: '',
		systemPassword: '',
		screenMode: '80x25',
		font: '',
		speed: 0,
		music: false,
		rip: false,
		ansi: true,
		notes: '',
		lastCalled: 0,
		sortOrder: 0,
		isFolder: false,
		...partial,
	};
}

/**
 * An IndexedDB-backed directory.
 */
export class DirectoryStore {
	private db: IDBDatabase | null = null;

	/** Open (and if necessary create) the database. */
	async open(): Promise<void> {
		if (this.db) return;
		this.db = await openDatabase();
	}

	/** Every entry. */
	async list(): Promise<DirectoryEntry[]> {
		await this.open();
		const db = this.db!;
		return new Promise((resolve, reject) => {
			const tx = db.transaction(DIRECTORY_STORE, 'readonly');
			const request = tx.objectStore(DIRECTORY_STORE).getAll();
			request.onsuccess = () => resolve(request.result as DirectoryEntry[]);
			request.onerror = () => reject(request.error);
		});
	}

	/** Insert or update an entry. */
	async save(entry: DirectoryEntry): Promise<void> {
		await this.open();
		const db = this.db!;
		return new Promise((resolve, reject) => {
			const tx = db.transaction(DIRECTORY_STORE, 'readwrite');
			tx.objectStore(DIRECTORY_STORE).put(entry);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}

	/** Delete an entry. */
	async remove(id: string): Promise<void> {
		await this.open();
		const db = this.db!;
		return new Promise((resolve, reject) => {
			const tx = db.transaction(DIRECTORY_STORE, 'readwrite');
			tx.objectStore(DIRECTORY_STORE).delete(id);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}

	/** Record that an entry was just dialled. */
	async markCalled(id: string): Promise<void> {
		const entries = await this.list();
		const entry = entries.find((e) => e.id === id);
		if (!entry) return;
		entry.lastCalled = Date.now();
		await this.save(entry);
	}
}

/**
 * Parse a SyncTERM `syncterm.lst` file.
 *
 * The upstream format is an INI file with a `[DialDirectory]` section where
 * each entry is keyed by its name and the values are `key=value` pairs
 * separated by commas (`src/syncterm/bbslist.c`).
 */
export function parseSynctermLst(text: string): DirectoryEntry[] {
	const entries: DirectoryEntry[] = [];
	let inSection = false;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith('[')) {
			inSection = /^\[DialDirectory\]/i.test(line);
			continue;
		}
		if (!inSection) continue;
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		const name = line.slice(0, eq).trim();
		const body = line.slice(eq + 1);
		const fields = new Map<string, string>();
		for (const part of body.split(',')) {
			const idx = part.indexOf(';');
			if (idx === -1) continue;
			fields.set(part.slice(0, idx).trim().toLowerCase(), part.slice(idx + 1).trim());
		}
		const port = parseInt(fields.get('port') ?? '23', 10);
		entries.push(
			emptyEntry({
				name: name || 'Unnamed',
				address: fields.get('address') ?? fields.get('host') ?? '',
				port: Number.isFinite(port) ? port : 23,
				protocol: normaliseProtocol(fields.get('protocol')),
				username: fields.get('username') ?? fields.get('user') ?? '',
				password: fields.get('password') ?? fields.get('pass') ?? '',
				systemPassword: fields.get('systempassword') ?? fields.get('syspass') ?? '',
				screenMode: fields.get('screenmode') ?? '80x25',
				font: fields.get('font') ?? '',
				speed: parseInt(fields.get('speed') ?? '0', 10) || 0,
				music: /^(1|true|yes)$/i.test(fields.get('music') ?? ''),
				rip: /^(1|true|yes)$/i.test(fields.get('rip') ?? ''),
				ansi: !/^(0|false|no)$/i.test(fields.get('ansi') ?? '1'),
				notes: fields.get('notes') ?? '',
			}),
		);
	}
	return entries;
}

function normaliseProtocol(value: string | undefined): Protocol {
	switch ((value ?? '').toLowerCase()) {
		case 'ssh':
			return 'ssh';
		case 'rlogin':
			return 'rlogin';
		case 'raw':
			return 'raw';
		case 'telnets':
		case 'tls':
			return 'telnets';
		default:
			return 'telnet';
	}
}

/**
 * Export a directory as a SyncTERM `syncterm.lst` file.
 */
export function exportSynctermLst(entries: DirectoryEntry[]): string {
	const lines = ['[DialDirectory]'];
	for (const entry of entries) {
		if (entry.isFolder) continue;
		const fields = [
			`Address;${entry.address}`,
			`Port;${entry.port}`,
			`Protocol;${entry.protocol}`,
			`UserName;${entry.username}`,
			`Password;${entry.password}`,
			`SystemPassword;${entry.systemPassword}`,
			`ScreenMode;${entry.screenMode}`,
			`Font;${entry.font}`,
			`Speed;${entry.speed}`,
			`Music;${entry.music ? 1 : 0}`,
			`RIP;${entry.rip ? 1 : 0}`,
			`ANSI;${entry.ansi ? 1 : 0}`,
			`Notes;${entry.notes}`,
		];
		lines.push(`${entry.name}=${fields.join(',')}`);
	}
	return lines.join('\r\n') + '\r\n';
}
