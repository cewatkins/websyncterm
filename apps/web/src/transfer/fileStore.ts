import { FILES_STORE, openDatabase } from '../directory/db.js';

/**
 * The received-file locker.
 *
 * Files received over ZMODEM/YMODEM are stored in IndexedDB so that they
 * survive a page reload and can be exported as a ZIP.
 */

/** A received file. */
export interface ReceivedFile {
	id: string;
	name: string;
	size: number;
	/** The MIME type, guessed from the extension. */
	type: string;
	/** The time the file was received. */
	receivedAt: number;
}

/** Guess a MIME type from a file name. */
export function guessMimeType(name: string): string {
	const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
	const types: Record<string, string> = {
		txt: 'text/plain',
		ans: 'text/plain',
		asc: 'text/plain',
		bin: 'application/octet-stream',
		xb: 'application/octet-stream',
		zip: 'application/zip',
		gz: 'application/gzip',
		tgz: 'application/gzip',
		png: 'image/png',
		gif: 'image/gif',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		ics: 'text/calendar',
		html: 'text/html',
		htm: 'text/html',
	};
	return types[ext] ?? 'application/octet-stream';
}

/**
 * A store of received files.
 */
export class FileStore {
	private db: IDBDatabase | null = null;

	/** Open the database. */
	async open(): Promise<void> {
		if (this.db) return;
		this.db = await openDatabase();
	}

	/** Every stored file's metadata. */
	async list(): Promise<ReceivedFile[]> {
		await this.open();
		const db = this.db!;
		return new Promise((resolve, reject) => {
			const request = db.transaction(FILES_STORE, 'readonly').objectStore(FILES_STORE).getAll();
			request.onsuccess = () => resolve(request.result as ReceivedFile[]);
			request.onerror = () => reject(request.error);
		});
	}

	/** Store a file. */
	async put(file: ReceivedFile, blob: Blob): Promise<void> {
		await this.open();
		const db = this.db!;
		return new Promise((resolve, reject) => {
			const tx = db.transaction(FILES_STORE, 'readwrite');
			const store = tx.objectStore(FILES_STORE);
			store.put({ ...file, blob });
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}

	/** Read a file's contents. */
	async get(id: string): Promise<Blob | null> {
		await this.open();
		const db = this.db!;
		return new Promise((resolve, reject) => {
			const request = db.transaction(FILES_STORE, 'readonly').objectStore(FILES_STORE).get(id);
			request.onsuccess = () => {
				const value = request.result as { blob?: Blob } | undefined;
				resolve(value?.blob ?? null);
			};
			request.onerror = () => reject(request.error);
		});
	}

	/** Delete a file. */
	async remove(id: string): Promise<void> {
		await this.open();
		const db = this.db!;
		return new Promise((resolve, reject) => {
			const tx = db.transaction(FILES_STORE, 'readwrite');
			tx.objectStore(FILES_STORE).delete(id);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}

	/** Delete every file. */
	async clear(): Promise<void> {
		await this.open();
		const db = this.db!;
		return new Promise((resolve, reject) => {
			const tx = db.transaction(FILES_STORE, 'readwrite');
			tx.objectStore(FILES_STORE).clear();
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}
}

/**
 * A file sink that collects the received bytes in memory.
 *
 * The transfer is written to the locker once it completes.
 */
export class CollectingSink {
	private chunks: Uint8Array[] = [];
	private total = 0;

	/** Write a chunk. */
	write(chunk: Uint8Array): void {
		this.chunks.push(chunk);
		this.total += chunk.length;
	}

	/** Finish the file. */
	close(): void {
		/* nothing to do */
	}

	/** The number of bytes received. */
	get size(): number {
		return this.total;
	}

	/** The collected bytes. */
	toBlob(type = 'application/octet-stream'): Blob {
		return new Blob(this.chunks as BlobPart[], { type });
	}
}
