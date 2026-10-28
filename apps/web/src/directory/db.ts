/**
 * The shared IndexedDB database.
 *
 * The dialing directory and the received-file locker live in the same
 * database so that a single version upgrade keeps them in step.
 */

const DB_NAME = 'websyncterm';
const DB_VERSION = 2;

/** The object store names. */
export const DIRECTORY_STORE = 'directory';
export const FILES_STORE = 'files';

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Open (and if necessary create or upgrade) the database.
 */
export function openDatabase(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	const promise = new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(DIRECTORY_STORE)) {
				const store = db.createObjectStore(DIRECTORY_STORE, { keyPath: 'id' });
				store.createIndex('folder', 'folder');
				store.createIndex('name', 'name');
			}
			if (!db.objectStoreNames.contains(FILES_STORE)) {
				db.createObjectStore(FILES_STORE, { keyPath: 'id' });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error('The database upgrade is blocked by another tab.'));
	});
	dbPromise = promise;
	promise.catch(() => {
		dbPromise = null;
	});
	return promise;
}
