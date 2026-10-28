/**
 * Encrypted dialing directory.
 *
 * SyncTERM 1.8 added support for an encrypted dialing directory; the browser
 * implementation uses WebCrypto AES-GCM with a PBKDF2-derived key, which
 * provides the same protection without shipping a cipher implementation.
 */

/** The magic header written at the start of an encrypted file. */
const MAGIC = 'WSTENC1';

/** The PBKDF2 iteration count. */
const ITERATIONS = 210000;

/** The salt length in bytes. */
const SALT_LENGTH = 16;

/** The IV length in bytes. */
const IV_LENGTH = 12;

/** An encrypted directory file. */
export interface EncryptedDirectory {
	version: 1;
	salt: string;
	iv: string;
	ciphertext: string;
}

/** Derive an AES-GCM key from a password. */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveKey'],
	);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' },
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}

function toBase64(data: Uint8Array): string {
	let binary = '';
	for (const byte of data) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/**
 * Encrypt a JSON-serialisable value with a password.
 */
export async function encryptDirectory(
	data: unknown,
	password: string,
): Promise<EncryptedDirectory> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const key = await deriveKey(password, salt);
	const plaintext = new TextEncoder().encode(JSON.stringify(data));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: iv as BufferSource },
		key,
		plaintext as BufferSource,
	);
	return {
		version: 1,
		salt: toBase64(salt),
		iv: toBase64(iv),
		ciphertext: toBase64(new Uint8Array(ciphertext)),
	};
}

/**
 * Decrypt a value previously encrypted with {@link encryptDirectory}.
 *
 * Throws when the password is wrong or the data has been tampered with.
 */
export async function decryptDirectory<T>(
	file: EncryptedDirectory,
	password: string,
): Promise<T> {
	if (file.version !== 1) throw new Error(`Unsupported directory version ${file.version}`);
	const salt = fromBase64(file.salt);
	const iv = fromBase64(file.iv);
	const key = await deriveKey(password, salt);
	let plaintext: ArrayBuffer;
	try {
		plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: iv as BufferSource },
			key,
			fromBase64(file.ciphertext) as BufferSource,
		);
	} catch {
		throw new Error('The password is incorrect or the file has been modified.');
	}
	return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/**
 * Serialise an encrypted directory to a file.
 */
export function serializeEncryptedDirectory(file: EncryptedDirectory): string {
	return `${MAGIC}\n${JSON.stringify(file)}`;
}

/**
 * Parse an encrypted directory file.
 */
export function parseEncryptedDirectory(text: string): EncryptedDirectory {
	const trimmed = text.trim();
	if (!trimmed.startsWith(MAGIC)) {
		throw new Error('This is not a WebSyncTERM encrypted directory.');
	}
	const payload = trimmed.slice(MAGIC.length).trim();
	return JSON.parse(payload) as EncryptedDirectory;
}
