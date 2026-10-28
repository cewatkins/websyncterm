import { concatBytes } from './bytes.js';
import { systemTimers } from './timers.js';
import type {
	EngineOptions,
	TimerHandle,
	Timers,
	TransferDirection,
	TransferError,
	TransferPhase,
	TransferProgress,
	TransferResult,
	TransferState,
	XferProtocol,
} from './types.js';

/**
 * Base class for the protocol engines.
 *
 * Subclasses implement `receive()` and queue outbound bytes with `emit()`.
 * The caller drains them with `poll()` or subscribes to `onOutput`.
 */
export abstract class TransferEngine {
	readonly protocol: XferProtocol;
	readonly direction: TransferDirection;
	protected readonly timers: Timers;
	protected readonly maxErrors: number;

	state: TransferState = { phase: 'idle' };
	progress: TransferProgress;
	done = false;
	result: TransferResult | null = null;
	error: TransferError | null = null;

	onOutput?: (data: Uint8Array) => void;
	onProgress?: (progress: TransferProgress) => void;
	onDone?: (result: TransferResult) => void;
	onError?: (error: TransferError) => void;

	private out: Uint8Array[] = [];
	private timer: TimerHandle | null = null;
	private bytesMoved = 0;
	private filesDone = 0;
	private readonly fileNames: string[] = [];
	protected aborted = false;

	protected constructor(protocol: XferProtocol, direction: TransferDirection, options: EngineOptions = {}) {
		this.protocol = protocol;
		this.direction = direction;
		this.timers = options.timers ?? systemTimers;
		this.maxErrors = options.maxErrors ?? 9;
		this.onOutput = options.onOutput;
		this.onProgress = options.onProgress;
		this.onDone = options.onDone;
		this.onError = options.onError;
		this.progress = {
			bytesTransferred: 0,
			bytesTotal: 0,
			fileName: '',
			blockNumber: 0,
			fileIndex: 0,
			fileCount: 1,
			phase: 'idle',
		};
	}

	/** Feed bytes received from the remote end. */
	abstract receive(data: Uint8Array): void;

	/** Bytes the engine wants to transmit; drains the internal queue. */
	poll(): Uint8Array {
		const data = concatBytes(this.out);
		this.out = [];
		return data;
	}

	/** True when there is outbound data waiting. */
	get hasOutput(): boolean {
		return this.out.length > 0;
	}

	/** Request cancellation. Emits the protocol's cancel sequence. */
	abort(): void {
		if (this.done || this.aborted) return;
		this.aborted = true;
		this.disarm();
		this.doAbort();
	}

	/** Release the pending timer. Safe to call at any time. */
	dispose(): void {
		this.disarm();
	}

	protected abstract doAbort(): void;

	/** Queue bytes for transmission. */
	protected emit(...chunks: (Uint8Array | number[])[]): void {
		for (const chunk of chunks) {
			const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
			if (bytes.length === 0) continue;
			this.out.push(bytes);
			this.onOutput?.(bytes);
		}
	}

	protected setState(state: TransferState): void {
		this.state = state;
	}

	protected setPhase(phase: TransferPhase): void {
		this.progress.phase = phase;
	}

	protected updateProgress(patch: Partial<TransferProgress>): void {
		this.progress = { ...this.progress, ...patch };
		this.onProgress?.(this.progress);
	}

	/** Record payload bytes moved in the current file. */
	protected addBytes(count: number): void {
		this.bytesMoved += count;
		this.progress.bytesTransferred += count;
	}

	/** Record a completed file. */
	protected completeFile(name?: string): void {
		this.filesDone++;
		this.fileNames.push(name ?? this.progress.fileName);
		this.progress.fileIndex = this.filesDone;
	}

	/** Complete the transfer successfully. */
	protected finish(): void {
		if (this.done) return;
		this.disarm();
		this.done = true;
		this.setPhase('done');
		this.state = { phase: 'done', ok: true };
		this.result = {
			ok: true,
			files: this.filesDone,
			bytes: this.bytesMoved,
			protocol: this.protocol,
			direction: this.direction,
			fileNames: this.fileNames.slice(),
		};
		this.onDone?.(this.result);
	}

	/** Complete the transfer after a local or remote cancel. */
	protected finishAborted(): void {
		if (this.done) return;
		this.disarm();
		this.done = true;
		this.aborted = true;
		this.setPhase('aborted');
		this.state = { phase: 'aborted' };
		this.result = {
			ok: false,
			files: this.filesDone,
			bytes: this.bytesMoved,
			protocol: this.protocol,
			direction: this.direction,
			fileNames: this.fileNames.slice(),
		};
		this.onDone?.(this.result);
	}

	/** Fail the transfer. */
	protected fail(code: string, message: string): void {
		if (this.done) return;
		this.disarm();
		this.done = true;
		this.error = { code, message };
		this.setPhase('error');
		this.state = { phase: 'error', code, message };
		this.result = {
			ok: false,
			files: this.filesDone,
			bytes: this.bytesMoved,
			protocol: this.protocol,
			direction: this.direction,
			fileNames: this.fileNames.slice(),
		};
		this.onError?.(this.error);
		this.onDone?.(this.result);
	}

	/** (Re)start the current timeout. */
	protected arm(ms: number): void {
		this.disarm();
		this.timer = this.timers.setTimeout(() => {
			this.timer = null;
			this.onTimeout();
		}, ms);
	}

	protected disarm(): void {
		if (this.timer !== null) {
			this.timers.clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/** Called when the armed timeout expires. */
	protected onTimeout(): void {}
}
