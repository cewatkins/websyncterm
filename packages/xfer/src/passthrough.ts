/**
 * "ASCII" and "raw" transfers: no framing, no error checking, no
 * acknowledgement.  The caller decides when the transfer ends.
 */

import { TransferEngine } from './engine.js';
import { SinkWriter } from './files.js';
import type { EngineOptions, FileSink, TransferDirection, TransferFile, XferProtocol } from './types.js';

export interface PassthroughOptions extends EngineOptions {
	direction: TransferDirection;
	protocol?: Extract<XferProtocol, 'ascii' | 'raw'>;
	sink?: FileSink;
	files?: TransferFile[];
	/** Send LF as CR LF (ASCII mode only, matching a text upload). */
	translateNewlines?: boolean;
}

export class PassthroughEngine extends TransferEngine {
	private readonly writer?: SinkWriter;
	private readonly files: TransferFile[];
	private readonly translateNewlines: boolean;
	private fileIndex = 0;
	private pumping: Promise<void> = Promise.resolve();
	private started = false;

	constructor(options: PassthroughOptions) {
		super(options.protocol ?? 'raw', options.direction, options);
		this.writer = options.sink ? new SinkWriter(options.sink) : undefined;
		this.files = options.files ?? [];
		this.translateNewlines = options.translateNewlines ?? false;
		this.setPhase('transfer');
		this.setState({ phase: 'transfer', direction: options.direction, fileName: '', blockNumber: 0 });
	}

	receive(data: Uint8Array): void {
		if (this.done) return;
		if (!this.writer) return;
		const chunk = this.translateNewlines ? crlfToLf(data) : data;
		this.writer.write(chunk);
		this.addBytes(chunk.length);
	}

	/** Finish the transfer (the caller decides when the stream ended). */
	end(): void {
		this.writer?.close();
		this.finish();
	}

	/** Await queued writes. */
	get whenIdle(): Promise<void> {
		return this.writer?.idle ?? Promise.resolve();
	}

	/** Send every file, then finish. */
	pump(): Promise<void> {
		this.pumping = this.pumping.then(() => this.pumpInternal());
		return this.pumping;
	}

	private async pumpInternal(): Promise<void> {
		if (this.done) return;
		if (!this.started) {
			this.started = true;
			if (this.files.length === 0) this.finish();
		}
		while (this.fileIndex < this.files.length) {
			const file = this.files[this.fileIndex];
			this.updateProgress({
				fileName: file.name,
				bytesTotal: file.size,
				bytesTransferred: 0,
				fileIndex: this.fileIndex,
				fileCount: this.files.length,
			});
			for (;;) {
				const chunk = await file.source.read();
				if (chunk === null) break;
				const out = this.translateNewlines ? lfToCrlf(chunk) : chunk;
				this.emit(out);
				this.addBytes(chunk.length);
				this.updateProgress({ bytesTransferred: this.progress.bytesTransferred });
			}
			this.completeFile(file.name);
			this.fileIndex++;
		}
		this.finish();
	}

	protected override doAbort(): void {
		this.writer?.close();
		this.finishAborted();
	}
}

function lfToCrlf(data: Uint8Array): Uint8Array {
	const out: number[] = [];
	for (let i = 0; i < data.length; i++) {
		if (data[i] === 0x0a) out.push(0x0d);
		out.push(data[i]);
	}
	return new Uint8Array(out);
}

function crlfToLf(data: Uint8Array): Uint8Array {
	const out: number[] = [];
	for (let i = 0; i < data.length; i++) {
		if (data[i] === 0x0d && data[i + 1] === 0x0a) continue;
		out.push(data[i]);
	}
	return new Uint8Array(out);
}
