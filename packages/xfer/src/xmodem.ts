/**
 * XMODEM / XMODEM-CRC / XMODEM-1K / YMODEM / YMODEM-G.
 *
 * Mirrors `src/sbbs3/xmodem.c` from Synchronet and the receiver loop in
 * SyncTERM's `term.c`:
 *
 *   SOH | blk | ~blk | data[128] | crc-hi | crc-lo
 *   STX | blk | ~blk | data[1024] | ...
 *
 * The checksum variant sends a single byte: the low 8 bits of the sum.
 * Short final blocks are padded with CPMEOF (0x1A); a YMODEM block 0 is
 * padded with NUL.  Block numbers wrap at 256.
 */

import { ByteQueue, ascii, asciiString, concatBytes } from './bytes.js';
import { crc16, crc16Update } from './crc.js';
import { TransferEngine } from './engine.js';
import { SinkWriter } from './files.js';
import type { EngineOptions, FileSink, TransferFile } from './types.js';

export const SOH = 0x01;
export const STX = 0x02;
export const EOT = 0x04;
export const ACK = 0x06;
export const NAK = 0x15;
export const CAN = 0x18;
/** CP/M end-of-file; pad byte for short XMODEM data blocks. */
export const CPMEOF = 0x1a;
/** CRC-mode request byte. */
export const CRC_REQUEST = 0x43; // 'C'
/** YMODEM-G streaming request byte. */
export const G_REQUEST = 0x47; // 'G'

/** Upstream `xm.c` defaults, in milliseconds. */
export const XMODEM_TIMEOUTS = {
	/** Header timeout for blocks 0 and 1. */
	header: 3000,
	/** Header timeout for later blocks. */
	headerLater: 10000,
	/** Per-byte / per-block receive timeout. */
	byte: 3000,
	/** Wait for an ACK after sending a block. */
	ack: 10000,
	/** Wait for the receiver's initial mode request. */
	handshake: 3000,
} as const;

export type XModemVariant = 'xmodem-crc' | 'xmodem-chksum' | 'xmodem-1k' | 'xmodem-128' | 'ymodem' | 'ymodem-g';

/** Parsed YMODEM block-0 metadata. */
export interface XModemFileInfo {
	name: string;
	size: number;
	mtime: number;
	mode: number;
	serial: number;
	filesRemaining: number;
	bytesRemaining: number;
	/** 0-based index of this file in the batch. */
	index: number;
}

/** The local cancel sequence: 8 x CAN followed by 10 x BS. */
export function xmodemCancelSequence(): Uint8Array {
	const out = new Uint8Array(18);
	out.fill(CAN, 0, 8);
	out.fill(0x08, 8, 18);
	return out;
}

/** True when the variant uses YMODEM block 0 / batching. */
function isYModem(variant: XModemVariant): boolean {
	return variant === 'ymodem' || variant === 'ymodem-g';
}

/** True for the streaming (no per-block ACK) variant. */
function isGMode(variant: XModemVariant): boolean {
	return variant === 'ymodem-g';
}

/** Base name of a path (both separators accepted, as getfname() does). */
export function baseName(path: string): string {
	const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Build a YMODEM block-0 payload (padded to `size` with NULs). */
export function ymodemBlock0(
	name: string,
	size: number,
	mtime: number,
	filesRemaining: number,
	bytesRemaining: number,
	blockSize = 128,
): Uint8Array {
	const text =
		baseName(name) +
		'\0' +
		`${size} ${Math.floor(mtime).toString(8)} 0 0 ${filesRemaining} ${bytesRemaining}`;
	const data = new Uint8Array(blockSize);
	const encoded = ascii(text);
	data.set(encoded.subarray(0, Math.min(encoded.length, blockSize)));
	return data;
}

/** Parse a YMODEM block-0 payload.  Returns `null` for the empty batch end. */
export function parseYModemBlock0(data: Uint8Array, index = 0): XModemFileInfo | null {
	const name = asciiString(data);
	if (name.length === 0) return null;
	const rest = asciiString(data, Math.min(name.length + 1, data.length));
	const fields = rest.trim().split(/\s+/);
	const octal = (v: string | undefined) => {
		const n = parseInt(v ?? '0', 8);
		return Number.isFinite(n) ? n : 0;
	};
	const decimal = (v: string | undefined) => {
		const n = parseInt(v ?? '0', 10);
		return Number.isFinite(n) ? n : 0;
	};
	return {
		name: baseName(name),
		size: decimal(fields[0]),
		mtime: octal(fields[1]),
		mode: octal(fields[2]),
		serial: octal(fields[3]),
		filesRemaining: decimal(fields[4]),
		bytesRemaining: decimal(fields[5]),
		index,
	};
}

/** Encode one XMODEM data block. */
export function encodeXModemBlock(
	blockNumber: number,
	data: Uint8Array,
	blockSize: number,
	crc: boolean,
): Uint8Array {
	const out = new Uint8Array(3 + blockSize + (crc ? 2 : 1));
	out[0] = blockSize === 128 ? SOH : STX;
	out[1] = blockNumber & 0xff;
	out[2] = ~blockNumber & 0xff;
	out.set(data.subarray(0, blockSize), 3);
	if (crc) {
		const c = crc16(data.subarray(0, blockSize));
		out[3 + blockSize] = (c >> 8) & 0xff;
		out[4 + blockSize] = c & 0xff;
	} else {
		let sum = 0;
		for (let i = 0; i < blockSize; i++) sum = (sum + data[i]) & 0xff;
		out[3 + blockSize] = sum;
	}
	return out;
}

export interface XModemReceiverOptions extends EngineOptions {
	variant?: XModemVariant;
	/** Sink for a single-file transfer (XMODEM, or the first YMODEM file). */
	sink?: FileSink;
	/** Sink factory for YMODEM batches.  Takes precedence over `sink`. */
	sinkFactory?: (info: XModemFileInfo) => FileSink;
	/** Name to report for a raw XMODEM transfer (the wire has no filename). */
	fileName?: string;
	/** Maximum block size accepted; defaults from the variant. */
	blockSize?: number;
}

/**
 * Streaming X/YMODEM receiver.
 *
 * On construction it queues the initial mode request (`C`, `NAK` or `G`), so
 * the first `poll()` already contains the byte the remote needs.
 */
export class XModemReceiver extends TransferEngine {
	private crc: boolean;
	private readonly gMode: boolean;
	private readonly ymodem: boolean;
	private readonly maxBlockSize: number;
	private readonly timeouts: typeof XMODEM_TIMEOUTS;
	private readonly sinkFactory?: (info: XModemFileInfo) => FileSink;
	private readonly singleSink?: FileSink;

	private readonly queue = new ByteQueue();
	private writer: SinkWriter | null = null;
	private expectedBlock: number;
	private bytesLeft = Infinity;
	private errors = 0;
	private attempts = 0;
	private sawEot = false;
	private fileCount = 1;

	constructor(options: XModemReceiverOptions = {}) {
		const variant = options.variant ?? 'xmodem-crc';
		super(protocolForVariant(variant), 'receive', options);
		this.crc = variant !== 'xmodem-chksum';
		this.gMode = isGMode(variant);
		this.ymodem = isYModem(variant);
		this.maxBlockSize = options.blockSize ?? (variant === 'xmodem-1k' || this.ymodem ? 1024 : 128);
		this.timeouts = { ...XMODEM_TIMEOUTS };
		this.sinkFactory = options.sinkFactory;
		this.singleSink = options.sink;
		this.expectedBlock = this.ymodem ? 0 : 1;
		if (!this.ymodem && this.singleSink) {
			this.writer = new SinkWriter(this.singleSink);
		}
		this.updateProgress({
			fileName: options.fileName ?? '',
			bytesTotal: 0,
			phase: 'handshake',
			fileCount: 1,
		});
		this.setState({ phase: 'handshake', waitingFor: 'mode request' });
		this.requestBlock(0);
		this.arm(this.timeouts.handshake);
	}

	receive(data: Uint8Array): void {
		if (this.done) return;
		this.queue.push(data);
		this.process();
	}

	/** Await any queued sink writes. */
	get whenIdle(): Promise<void> {
		return this.writer?.idle ?? Promise.resolve();
	}

	private get requestByte(): number {
		if (this.gMode) return G_REQUEST;
		return this.crc ? CRC_REQUEST : NAK;
	}

	private requestBlock(blockNumber: number): void {
		if (blockNumber <= 1) this.emit([this.requestByte]);
		else this.emit([NAK]);
	}

	private process(): void {
		for (;;) {
			const view = this.queue.view;
			if (view.length === 0) return;
			const first = view[0];

			if (first === SOH || first === STX) {
				const size = first === SOH ? 128 : 1024;
				if (size > this.maxBlockSize) {
					// 1024-byte blocks were not negotiated: upstream fails outright.
					this.queue.consume(1);
					this.fail('block-size', 'received a 1024-byte block but only 128-byte blocks are allowed');
					return;
				}
				const need = 3 + size + (this.crc ? 2 : 1);
				if (view.length < need) return;
				const frame = view.subarray(0, need);
				this.queue.consume(need);
				this.handleBlock(frame, size);
				if (this.done) return;
				continue;
			}

			if (first === EOT) {
				this.queue.consume(1);
				this.handleEot();
				return;
			}

			if (first === CAN) {
				let cans = 0;
				while (cans < view.length && view[cans] === CAN) cans++;
				if (cans >= 2) {
					this.queue.consume(cans);
					this.emit(xmodemCancelSequence());
					this.finishAborted();
					return;
				}
				if (cans === 1 && view.length === 1) return; // need one more byte
				this.queue.consume(1);
				continue;
			}

			// Garbage between blocks: drop up to the next frame marker.
			let i = 1;
			while (i < view.length) {
				const b = view[i];
				if (b === SOH || b === STX || b === EOT || b === CAN) break;
				i++;
			}
			this.queue.consume(i);
		}
	}

	private handleBlock(frame: Uint8Array, size: number): void {
		const blockNumber = frame[1];
		const inverse = frame[2];
		const payload = frame.subarray(3, 3 + size);
		let good = false;

		if ((blockNumber ^ inverse) === 0xff) {
			if (this.crc) {
				const expected = (frame[3 + size] << 8) | frame[4 + size];
				let calc = 0;
				for (let i = 0; i < size; i++) calc = crc16Update(calc, payload[i]);
				good = expected === calc;
			} else {
				let sum = 0;
				for (let i = 0; i < size; i++) sum = (sum + payload[i]) & 0xff;
				good = frame[3 + size] === sum;
			}
		}

		if (!good) {
			this.blockError(blockNumber, 'checksum');
			return;
		}

		if (blockNumber !== (this.expectedBlock & 0xff)) {
			// A repeat of the previous block (ymodem.doc 7.3.2): ACK and drop it.
			if (this.expectedBlock > 0 && blockNumber === ((this.expectedBlock - 1) & 0xff)) {
				if (!this.gMode) this.emit([ACK]);
				this.arm(this.timeoutFor(this.expectedBlock));
				return;
			}
			this.blockError(blockNumber, 'block-number');
			return;
		}

		this.errors = 0;
		this.attempts = 0;
		this.sawEot = false;

		if (this.expectedBlock === 0) {
			this.handleFileHeader(payload);
			return;
		}

		const count = Math.min(size, this.bytesLeft);
		if (this.writer && count > 0) {
			this.writer.write(payload.subarray(0, count));
			this.addBytes(count);
			this.bytesLeft -= count;
		}

		this.expectedBlock++;
		this.updateProgress({
			blockNumber: this.expectedBlock - 1,
			bytesTransferred: this.progress.bytesTransferred,
			phase: 'transfer',
		});
		this.setState({
			phase: 'transfer',
			direction: 'receive',
			fileName: this.progress.fileName,
			blockNumber: this.expectedBlock - 1,
		});
		if (!this.gMode) this.emit([ACK]);
		this.arm(this.timeoutFor(this.expectedBlock));
	}

	private handleFileHeader(payload: Uint8Array): void {
		const info = parseYModemBlock0(payload, this.progress.fileIndex);
		if (info === null) {
			// YMODEM batch terminator: a block 0 whose first byte is NUL.
			if (!this.gMode) this.emit([ACK]);
			this.closeCurrentFile();
			this.finish();
			return;
		}

		this.bytesLeft = info.size;
		this.fileCount = info.filesRemaining || 1;
		this.updateProgress({
			fileName: info.name,
			bytesTotal: info.size,
			bytesTransferred: 0,
			blockNumber: 0,
			fileCount: this.fileCount,
			phase: 'transfer',
		});

		const sink = this.sinkFactory ? this.sinkFactory(info) : this.singleSink;
		if (!sink) {
			this.fail('no-sink', 'no file sink was supplied for the incoming file');
			return;
		}
		this.writer = new SinkWriter(sink);
		this.expectedBlock = 1;
		if (!this.gMode) this.emit([ACK]);
		this.arm(this.timeoutFor(1));
	}

	private handleEot(): void {
		if (!this.gMode && !this.sawEot) {
			// Chuck's double-EOT trick: NAK the first EOT, ACK the second.
			this.sawEot = true;
			this.emit([NAK]);
			this.arm(this.timeoutFor(this.expectedBlock));
			return;
		}

		this.emit([ACK]);
		this.sawEot = false;
		this.closeCurrentFile();

		if (!this.ymodem) {
			this.finish();
			return;
		}

		// Ask for the next YMODEM header (or the empty batch terminator).
		this.expectedBlock = 0;
		this.bytesLeft = Infinity;
		this.attempts = 0;
		this.setState({ phase: 'handshake', waitingFor: 'batch header' });
		this.setPhase('handshake');
		this.requestBlock(0);
		this.arm(this.timeouts.handshake);
	}

	private closeCurrentFile(): void {
		if (!this.writer) return;
		this.writer.close();
		this.writer = null;
		this.completeFile(this.progress.fileName);
		this.updateProgress({ bytesTransferred: 0 });
	}

	private blockError(blockNumber: number, reason: string): void {
		this.errors++;
		if (this.errors > this.maxErrors) {
			this.emit(xmodemCancelSequence());
			this.fail('too-many-errors', `too many errors (last: ${reason} on block ${blockNumber})`);
			return;
		}
		if (this.expectedBlock === 0) {
			// Still negotiating the header: re-request the mode.
			this.requestBlock(0);
		} else {
			// First-block errors downgrade CRC to the 8-bit checksum, as
			// SyncTERM does after max_errors/3 failures.
			if (this.expectedBlock === 1 && this.crc && !this.gMode && this.errors > Math.floor(this.maxErrors / 3)) {
				this.crc = false;
			}
			this.emit([NAK]);
		}
		this.arm(this.timeouts.byte);
	}

	private timeoutFor(blockNumber: number): number {
		return blockNumber <= 1 ? this.timeouts.header : this.timeouts.headerLater;
	}

	protected override onTimeout(): void {
		if (this.done) return;
		this.attempts++;
		if (this.attempts > this.maxErrors + 1) {
			this.emit(xmodemCancelSequence());
			this.fail('timeout', 'timed out waiting for data');
			return;
		}
		this.requestBlock(this.expectedBlock);
		this.arm(this.timeoutFor(this.expectedBlock));
	}

	protected override doAbort(): void {
		this.emit(xmodemCancelSequence());
		this.writer?.close();
		this.writer = null;
		this.finishAborted();
	}
}

export interface XModemSenderOptions extends EngineOptions {
	files: TransferFile[];
	variant?: XModemVariant;
	/** Data block size; defaults from the variant. */
	blockSize?: number;
	/** Advertise CRC support (XMODEM senders always honour the receiver). */
	crcSupported?: boolean;
	/** Advertise YMODEM-G support. */
	gModeSupported?: boolean;
}

/**
 * Streaming X/YMODEM sender.
 *
 * It never chooses CRC vs checksum: it waits for the receiver's `C` / `NAK` /
 * `G` request exactly like `xmodem_get_mode()`.
 *
 * Driving the sender is cooperative: `receive()` stores the peer's bytes, then
 * the caller awaits `pump()` to produce the next block.
 */
export class XModemSender extends TransferEngine {
	private readonly files: TransferFile[];
	private readonly variant: XModemVariant;
	private readonly maxBlockSize: number;
	private readonly timeouts: typeof XMODEM_TIMEOUTS;
	private readonly crcSupported: boolean;
	private readonly gModeSupported: boolean;

	private crc: boolean;
	private gMode: boolean;
	private phase: 'mode' | 'header' | 'data' | 'eot' | 'term' | 'done' = 'mode';
	private awaiting: 'mode' | 'header' | 'data' | 'eot' | 'term' | null = 'mode';
	private fileIndex = 0;
	private blockNumber = 1;
	private pending: { data: Uint8Array; size: number; block: number } | null = null;
	private carry: Uint8Array = new Uint8Array(0);
	private sentInFile = 0;
	private needHeader: boolean;
	private terminating = false;
	private cans = 0;
	private errors = 0;
	private eotNaks = 0;
	private modeAttempts = 0;
	private pumping: Promise<void> = Promise.resolve();

	constructor(options: XModemSenderOptions) {
		const variant = options.variant ?? 'xmodem-crc';
		super(protocolForVariant(variant), 'send', options);
		this.files = options.files;
		this.variant = variant;
		this.timeouts = { ...XMODEM_TIMEOUTS };
		this.maxBlockSize = options.blockSize ?? (variant === 'xmodem-1k' || isYModem(variant) ? 1024 : 128);
		this.crcSupported = options.crcSupported ?? true;
		this.gModeSupported = options.gModeSupported ?? true;
		this.gMode = isGMode(variant);
		this.crc = variant !== 'xmodem-chksum';
		this.needHeader = isYModem(variant);
		this.updateProgress({
			fileName: this.files[0]?.name ?? '',
			bytesTotal: this.files[0]?.size ?? 0,
			fileIndex: 0,
			fileCount: this.files.length,
			phase: 'handshake',
		});
		this.setState({ phase: 'handshake', waitingFor: 'mode request' });
		this.arm(this.timeouts.handshake);
	}

	receive(data: Uint8Array): void {
		if (this.done) return;
		for (let i = 0; i < data.length; i++) {
			const byte = data[i];
			if (byte === CAN) {
				this.cans++;
				if (this.cans >= 2) {
					this.emit(xmodemCancelSequence());
					this.finishAborted();
					return;
				}
				continue;
			}
			this.cans = 0;
			this.handleByte(byte);
			if (this.done) return;
		}
	}

	private handleByte(byte: number): void {
		if (this.awaiting === 'mode') {
			if (byte === CRC_REQUEST && this.crcSupported) {
				this.crc = true;
				this.gMode = false;
				this.begin();
			} else if (byte === NAK) {
				this.crc = false;
				this.gMode = false;
				this.begin();
			} else if (byte === G_REQUEST && this.gModeSupported) {
				this.crc = true;
				this.gMode = true;
				this.begin();
			}
			return;
		}

		if (this.awaiting === null) return;

		if (byte === ACK) this.handleAck();
		else if (byte === NAK) this.handleNak();
	}

	private begin(): void {
		this.awaiting = null;
		this.errors = 0;
		this.modeAttempts = 0;
		if (this.terminating) {
			this.phase = 'term';
			return;
		}
		this.phase = this.needHeader ? 'header' : 'data';
		this.setPhase('transfer');
	}

	private handleAck(): void {
		const awaiting = this.awaiting;
		this.awaiting = null;
		this.errors = 0;

		switch (awaiting) {
			case 'header':
				this.needHeader = false;
				this.phase = 'data';
				this.blockNumber = 1;
				this.sentInFile = 0;
				break;
			case 'data':
				if (this.pending) {
					this.addBytes(this.pending.size);
					this.sentInFile += this.pending.size;
					this.updateProgress({
						bytesTransferred: this.sentInFile,
						blockNumber: this.pending.block,
						fileName: this.files[this.fileIndex]?.name ?? '',
						bytesTotal: this.files[this.fileIndex]?.size ?? 0,
						fileIndex: this.fileIndex,
						fileCount: this.files.length,
						phase: 'transfer',
					});
					this.setState({
						phase: 'transfer',
						direction: 'send',
						fileName: this.progress.fileName,
						blockNumber: this.pending.block,
					});
					this.blockNumber++;
					this.pending = null;
				}
				break;
			case 'eot':
				this.completeFile(this.progress.fileName);
				this.eotNaks = 0;
				if (this.fileIndex + 1 < this.files.length) {
					this.startNextFile();
				} else if (isYModem(this.variant)) {
					this.terminating = true;
					this.phase = 'mode';
					this.awaiting = 'mode';
					this.setPhase('handshake');
					this.setState({ phase: 'handshake', waitingFor: 'termination request' });
					this.arm(this.timeouts.handshake);
				} else {
					this.finish();
				}
				return;
			case 'term':
				this.finish();
				return;
			case 'mode':
			default:
				return;
		}
		this.arm(this.timeouts.ack);
		void this.pump();
	}

	private handleNak(): void {
		switch (this.awaiting) {
			case 'eot':
				if (this.eotNaks++ <= this.maxErrors) {
					this.awaiting = null;
					this.phase = 'eot';
					void this.pump();
				} else {
					this.emit(xmodemCancelSequence());
					this.fail('eot-timeout', 'receiver kept rejecting EOT');
				}
				return;
			case 'header':
			case 'data':
			case 'term':
				this.errors++;
				this.awaiting = null;
				if (this.errors > this.maxErrors) {
					this.emit(xmodemCancelSequence());
					this.fail('too-many-errors', 'too many NAKs');
					return;
				}
				void this.pump();
				return;
			default:
				return;
		}
	}

	private startNextFile(): void {
		this.fileIndex++;
		this.needHeader = isYModem(this.variant);
		this.phase = 'mode';
		this.awaiting = 'mode';
		this.pending = null;
		this.carry = new Uint8Array(0);
		this.updateProgress({
			fileName: this.files[this.fileIndex]?.name ?? '',
			bytesTotal: this.files[this.fileIndex]?.size ?? 0,
			bytesTransferred: 0,
			blockNumber: 0,
			fileIndex: this.fileIndex,
			fileCount: this.files.length,
			phase: 'handshake',
		});
		this.setPhase('handshake');
		this.setState({ phase: 'handshake', waitingFor: 'mode request' });
		this.arm(this.timeouts.handshake);
	}

	/**
	 * Produce whatever can be produced without more input from the peer.
	 * Resolves once the sender is waiting for an ACK (or is done).
	 *
	 * Calls are serialised: awaiting a later `pump()` also waits for any
	 * still-running earlier one.
	 */
	pump(): Promise<void> {
		this.pumping = this.pumping.then(() => this.pumpInternal());
		return this.pumping;
	}

	private async pumpInternal(): Promise<void> {
		if (this.done) return;
		for (;;) {
			if (this.awaiting !== null) return;
			switch (this.phase) {
				case 'mode':
					return;
				case 'header': {
					const file = this.files[this.fileIndex];
					if (!file) {
						this.fail('no-file', 'no file to send');
						return;
					}
					const filesRemaining = this.files.length - this.fileIndex;
					let bytesRemaining = 0;
					for (let i = this.fileIndex; i < this.files.length; i++) bytesRemaining += this.files[i].size;
					const payload = ymodemBlock0(
						file.name,
						file.size,
						file.mtime ?? 0,
						filesRemaining,
						bytesRemaining,
						128,
					);
					this.emit(encodeXModemBlock(0, payload, 128, this.crc));
					this.updateProgress({ blockNumber: 0, fileName: file.name, bytesTotal: file.size });
					if (this.gMode) {
						this.needHeader = false;
						this.phase = 'data';
						this.blockNumber = 1;
						continue;
					}
					this.awaiting = 'header';
					this.arm(this.timeouts.ack);
					return;
				}
				case 'data': {
					if (this.pending === null) {
						const block = await this.readBlock();
						if (block === null) {
							this.phase = 'eot';
							continue;
						}
						this.pending = block;
					}
					const { data, block } = this.pending;
					this.emit(encodeXModemBlock(block, data, data.length, this.crc));
					this.updateProgress({ blockNumber: block, phase: 'transfer' });
					this.setState({
						phase: 'transfer',
						direction: 'send',
						fileName: this.files[this.fileIndex]?.name ?? '',
						blockNumber: block,
					});
					if (this.gMode) {
						this.sentInFile += this.pending.size;
						this.pending = null;
						this.blockNumber++;
						continue;
					}
					this.awaiting = 'data';
					this.arm(this.timeouts.ack);
					return;
				}
				case 'eot': {
					this.emit([EOT]);
					this.awaiting = 'eot';
					this.arm(this.timeouts.ack);
					return;
				}
				case 'term': {
					const empty = new Uint8Array(128);
					this.emit(encodeXModemBlock(0, empty, 128, this.crc));
					this.awaiting = 'term';
					this.arm(this.timeouts.ack);
					return;
				}
				case 'done':
					return;
			}
		}
	}

	private async readBlock(): Promise<{ data: Uint8Array; size: number; block: number } | null> {
		const file = this.files[this.fileIndex];
		if (!file) return null;
		const max = this.maxBlockSize;
		while (this.carry.length < max) {
			const chunk = await file.source.read();
			if (chunk === null) break;
			this.carry = concatBytes([this.carry, chunk]);
		}
		if (this.carry.length === 0) return null;

		const size = Math.min(max, this.carry.length);
		const blockSize = max > 128 && size <= 128 ? 128 : max;
		const data = new Uint8Array(blockSize);
		data.fill(CPMEOF);
		data.set(this.carry.subarray(0, size));
		this.carry = this.carry.slice(size);
		const block = this.blockNumber;
		return { data, size, block };
	}

	protected override onTimeout(): void {
		if (this.done) return;
		if (this.awaiting === 'mode') {
			if (++this.modeAttempts > this.maxErrors + 1) {
				this.fail('mode-timeout', 'timed out waiting for the receiver to request a transfer mode');
				return;
			}
			this.arm(this.timeouts.handshake);
			return;
		}
		if (this.awaiting === 'eot') {
			this.awaiting = null;
			this.phase = 'eot';
			void this.pump();
			return;
		}
		if (this.awaiting === 'data' || this.awaiting === 'header' || this.awaiting === 'term') {
			this.errors++;
			if (this.errors > this.maxErrors) {
				this.emit(xmodemCancelSequence());
				this.fail('timeout', 'timed out waiting for an ACK');
				return;
			}
			// Clearing `awaiting` makes pump() retransmit the retained block.
			this.awaiting = null;
			void this.pump();
		}
	}

	protected override doAbort(): void {
		this.emit(xmodemCancelSequence());
		this.finishAborted();
	}
}

function protocolForVariant(variant: XModemVariant): 'xmodem-crc' | 'xmodem-chksum' | 'xmodem-1k' | 'xmodem-128' | 'ymodem' | 'ymodem-g' {
	return variant;
}
