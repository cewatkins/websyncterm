/**
 * Top-level session: owns transfer auto-detection and dispatches to the
 * protocol engine that matches the negotiated protocol and direction.
 */

import { TransferDetector, type DetectedTransfer } from './detect.js';
import type { TransferEngine } from './engine.js';
import { PassthroughEngine } from './passthrough.js';
import { XModemReceiver, XModemSender, type XModemFileInfo, type XModemVariant } from './xmodem.js';
import { ZModemReceiver, ZModemSender, type ZModemFileInfo } from './zmodem.js';
import type {
	EngineOptions,
	FileSink,
	TransferDirection,
	TransferFile,
	TransferProgress,
	TransferResult,
	TransferState,
	XferProtocol,
} from './types.js';

export interface TransferSessionOptions extends EngineOptions {
	/**
	 * The protocol the user picked.  When omitted, the session auto-detects
	 * from the first bytes the remote sends.
	 */
	protocol?: XferProtocol;
	/** Direction from the local endpoint's point of view (default: receive). */
	direction?: TransferDirection;
	/** Sink for single-file downloads. */
	sink?: FileSink;
	/** Per-file sink factory, for YMODEM / ZMODEM batches. */
	sinkFactory?: (info: XModemFileInfo | ZModemFileInfo) => FileSink;
	/** Files to send. */
	files?: TransferFile[];
	/** Name to report for a filename-less XMODEM download. */
	fileName?: string;
	/** Existing bytes of the first file (ZMODEM crash recovery). */
	resumeFrom?: number;
	/** ZMODEM: escape control characters. */
	escapeCtrl?: boolean;
	/** ZMODEM: escape 0xFF as ZDLE ZRUB1. */
	escapeTelnetIac?: boolean;
	/** ZMODEM/XMODEM: data block size. */
	blockSize?: number;
}

/** How a detected transfer maps onto a local direction. */
export function directionFor(detected: DetectedTransfer): TransferDirection {
	switch (detected) {
		case 'zmodem-upload':
			// The remote sent ZRINIT: it wants to receive, so we send.
			return 'send';
		case 'xmodem-crc':
		case 'xmodem-chksum':
		case 'ymodem-g':
			// The remote requested a mode: it is the receiver.
			return 'send';
		case 'zmodem-download':
		default:
			return 'receive';
	}
}

/** The protocols SyncTERM's download picker offers (ZMODEM first). */
export const DOWNLOAD_PROTOCOLS: readonly XferProtocol[] = [
	'zmodem',
	'ymodem-g',
	'ymodem',
	'xmodem-crc',
	'xmodem-chksum',
] as const;

/**
 * The protocols SyncTERM's upload picker offers.  Note there is no CRC vs
 * checksum choice when sending: the sender honours whatever the receiver asks
 * for.  XMODEM-128 is upload-only in SyncTERM.
 */
export const UPLOAD_PROTOCOLS: readonly XferProtocol[] = [
	'zmodem',
	'ymodem',
	'xmodem-1k',
	'xmodem-128',
	'ascii',
	'raw',
] as const;

/** True when SyncTERM offers `protocol` for the given direction. */
export function isProtocolSupported(protocol: XferProtocol, direction: TransferDirection): boolean {
	return (direction === 'send' ? UPLOAD_PROTOCOLS : DOWNLOAD_PROTOCOLS).includes(protocol);
}

/**
 * A complete transfer, from auto-detection through protocol dispatch.
 *
 * ```ts
 * const session = new TransferSession({ sink });
 * session.receive(incomingBytes);
 * send(session.poll());
 * ```
 */
export class TransferSession {
	readonly detector = new TransferDetector();
	engine: TransferEngine | null = null;

	private readonly options: TransferSessionOptions;

	constructor(options: TransferSessionOptions = {}) {
		this.options = options;
		if (options.protocol) {
			const direction = options.direction ?? 'receive';
			this.engine = this.createEngine(options.protocol, direction);
		}
	}

	/** True while the session is still waiting for the remote's prefix. */
	get detecting(): boolean {
		return this.engine === null;
	}

	get protocol(): XferProtocol | null {
		return this.engine?.protocol ?? this.options.protocol ?? null;
	}

	get direction(): TransferDirection {
		return this.engine?.direction ?? this.options.direction ?? 'receive';
	}

	get state(): TransferState {
		return this.engine?.state ?? { phase: 'idle' };
	}

	get progress(): TransferProgress {
		return (
			this.engine?.progress ?? {
				bytesTransferred: 0,
				bytesTotal: 0,
				fileName: '',
				blockNumber: 0,
				fileIndex: 0,
				fileCount: 1,
				phase: 'idle',
			}
		);
	}

	get done(): boolean {
		return this.engine?.done ?? false;
	}

	get result(): TransferResult | null {
		return this.engine?.result ?? null;
	}

	/** Feed bytes from the remote.  While detecting, they are buffered. */
	receive(data: Uint8Array): void {
		if (this.engine) {
			this.engine.receive(data);
			return;
		}
		const found = this.detector.pushBytes(data);
		if (!found) return;
		const direction = this.options.direction ?? directionFor(found);
		const protocol = this.options.protocol ?? protocolFor(found);
		this.engine = this.createEngine(protocol, direction);
		this.engine.receive(this.detector.bytes);
	}

	/** Bytes the engine wants to send to the remote. */
	poll(): Uint8Array {
		return this.engine?.poll() ?? new Uint8Array(0);
	}

	abort(): void {
		this.engine?.abort();
	}

	dispose(): void {
		this.engine?.dispose();
	}

	private createEngine(protocol: XferProtocol, direction: TransferDirection): TransferEngine {
		const common: EngineOptions = {
			timers: this.options.timers,
			maxErrors: this.options.maxErrors,
			onOutput: this.options.onOutput,
			onProgress: this.options.onProgress,
			onDone: this.options.onDone,
			onError: this.options.onError,
		};
		const variant = xmodemVariant(protocol);

		if (protocol === 'zmodem') {
			if (direction === 'receive') {
				return new ZModemReceiver({
					...common,
					sink: this.options.sink,
					sinkFactory: this.options.sinkFactory as (info: ZModemFileInfo) => FileSink,
					resumeFrom: this.options.resumeFrom,
					escapeCtrl: this.options.escapeCtrl,
				});
			}
			return new ZModemSender({
				...common,
				files: this.options.files ?? [],
				escapeCtrl: this.options.escapeCtrl,
				escapeTelnetIac: this.options.escapeTelnetIac,
				blockSize: this.options.blockSize,
			});
		}

		if (protocol === 'ascii' || protocol === 'raw') {
			return new PassthroughEngine({
				...common,
				protocol,
				direction,
				sink: this.options.sink,
				files: this.options.files,
				translateNewlines: protocol === 'ascii',
			});
		}

		if (direction === 'receive') {
			return new XModemReceiver({
				...common,
				variant,
				sink: this.options.sink,
				sinkFactory: this.options.sinkFactory as (info: XModemFileInfo) => FileSink,
				fileName: this.options.fileName,
				blockSize: this.options.blockSize,
			});
		}
		return new XModemSender({
			...common,
			files: this.options.files ?? [],
			variant,
			blockSize: this.options.blockSize,
		});
	}
}

function xmodemVariant(protocol: XferProtocol): XModemVariant {
	switch (protocol) {
		case 'ymodem':
			return 'ymodem';
		case 'ymodem-g':
			return 'ymodem-g';
		case 'xmodem-1k':
			return 'xmodem-1k';
		case 'xmodem-128':
			return 'xmodem-128';
		case 'xmodem-chksum':
			return 'xmodem-chksum';
		default:
			return 'xmodem-crc';
	}
}

function protocolFor(detected: DetectedTransfer): XferProtocol {
	switch (detected) {
		case 'zmodem-download':
		case 'zmodem-upload':
			return 'zmodem';
		case 'ymodem-g':
			return 'ymodem-g';
		case 'xmodem-chksum':
			return 'xmodem-chksum';
		case 'xmodem-crc':
		default:
			return 'xmodem-crc';
	}
}
