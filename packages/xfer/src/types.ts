/**
 * Shared types for the WebSyncTERM file-transfer engines.
 *
 * Every engine is a *pure* state machine: it never touches a socket, a file
 * system or a real timer.  The caller feeds received bytes in with
 * `receive()`, collects the bytes to transmit with `poll()` (or `onOutput`),
 * and supplies files through {@link FileSink} / {@link FileSource}.
 *
 * Timeouts are driven by an injected {@link Timers} implementation so tests
 * can advance time deterministically.  `ManualTimers` (see `timers.ts`) is
 * provided for exactly that.
 */

/** The transfer protocols SyncTERM offers in its pickers. */
export type XferProtocol =
	| 'zmodem'
	| 'ymodem'
	| 'ymodem-g'
	| 'xmodem-crc'
	| 'xmodem-chksum'
	| 'xmodem-1k'
	| 'xmodem-128'
	| 'ascii'
	| 'raw';

/** Every protocol, in the order SyncTERM's pickers present them. */
export const TRANSFER_PROTOCOLS: readonly XferProtocol[] = [
	'zmodem',
	'ymodem',
	'ymodem-g',
	'xmodem-crc',
	'xmodem-chksum',
	'xmodem-1k',
	'xmodem-128',
	'ascii',
	'raw',
] as const;

/** Direction of a transfer, from the local endpoint's point of view. */
export type TransferDirection = 'send' | 'receive';

/** Coarse transfer phase, mirrored in {@link TransferProgress.phase}. */
export type TransferPhase = 'idle' | 'handshake' | 'transfer' | 'finishing' | 'done' | 'aborted' | 'error';

/** Snapshot of a transfer's progress. */
export interface TransferProgress {
	/** Bytes of the current (or only) file moved so far. */
	bytesTransferred: number;
	/** Total bytes expected, or 0 when the protocol does not say. */
	bytesTotal: number;
	/** Base name of the current file, when known. */
	fileName: string;
	/** 1-based block/packet number of the current protocol. */
	blockNumber: number;
	/** 0-based index of the current file within a batch. */
	fileIndex: number;
	/** Number of files in the batch, or 1 when not a batch. */
	fileCount: number;
	phase: TransferPhase;
}

/** A writable file supplied by the caller (IndexedDB in the browser). */
export interface FileSink {
	write(chunk: Uint8Array): void | Promise<void>;
	close(): void | Promise<void>;
}

/** A readable file supplied by the caller (IndexedDB in the browser). */
export interface FileSource {
	/** Return the next chunk, or `null` at end of file. */
	read(): Promise<Uint8Array | null>;
	close(): void;
	/** Optional seek, needed for ZMODEM crash recovery. */
	seek?(offset: number): void;
}

/** Metadata describing one file of a batch. */
export interface TransferFile {
	name: string;
	size: number;
	/** Modification time; the wire format uses Unix seconds. */
	mtime?: number;
	source: FileSource;
}

/**
 * A discriminated union describing what the engine is currently doing.
 * `phase` matches {@link TransferProgress.phase}.
 */
export type TransferState =
	| { readonly phase: 'idle' }
	| { readonly phase: 'handshake'; readonly waitingFor: string }
	| {
			readonly phase: 'transfer';
			readonly direction: TransferDirection;
			readonly fileName: string;
			readonly blockNumber: number;
	  }
	| { readonly phase: 'finishing' }
	| { readonly phase: 'done'; readonly ok: boolean }
	| { readonly phase: 'aborted' }
	| { readonly phase: 'error'; readonly code: string; readonly message: string };

/** A failure reported through `onError`. */
export interface TransferError {
	code: string;
	message: string;
}

/** Summary handed to `onDone`. */
export interface TransferResult {
	ok: boolean;
	/** Number of files transferred successfully. */
	files: number;
	/** Number of payload bytes moved (excluding protocol overhead). */
	bytes: number;
	protocol: XferProtocol;
	direction: TransferDirection;
	/** Per-file outcomes, in order. */
	fileNames: string[];
}

/** Monotonic millisecond clock. */
export interface Clock {
	now(): number;
}

/** Opaque timer handle returned by {@link Timers.setTimeout}. */
export type TimerHandle = unknown;

/** Injectable timer/clock API. */
export interface Timers extends Clock {
	setTimeout(handler: () => void, ms: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
}

/** Options shared by every engine. */
export interface EngineOptions {
	timers?: Timers;
	maxErrors?: number;
	/** Receives every byte the engine wants to transmit (in addition to poll()). */
	onOutput?: (data: Uint8Array) => void;
	onProgress?: (progress: TransferProgress) => void;
	onDone?: (result: TransferResult) => void;
	onError?: (error: TransferError) => void;
}
