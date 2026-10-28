/**
 * The transfer hook.
 *
 * Watches the incoming byte stream for a ZMODEM/YMODEM/XMODEM handshake and
 * drives the corresponding protocol engine, storing the received file in the
 * locker.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
	TransferSession,
	type DetectedTransfer,
	type FileSink,
	type TransferError,
	type TransferProgress,
	type TransferResult,
} from '@websyncterm/xfer';
import { CollectingSink, FileStore, guessMimeType, type ReceivedFile } from './fileStore.js';

/** The state of the transfer UI. */
export interface TransferState {
	/** The detected protocol, or null when nothing is happening. */
	detected: DetectedTransfer | null;
	/** The progress of the running transfer. */
	progress: TransferProgress | null;
	/** The result, once the transfer has finished. */
	result: TransferResult | null;
	/** The error, if the transfer failed. */
	error: TransferError | null;
	/** The files that have been received. */
	files: ReceivedFile[];
	/** True while a transfer is running. */
	active: boolean;
}

/** The API returned by {@link useTransfers}. */
export interface TransfersApi {
	state: TransferState;
	/** Begin a transfer that the remote host has started. */
	start: (detected: DetectedTransfer) => void;
	/** Feed bytes received from the remote host. */
	receive: (data: Uint8Array) => void;
	/** Abort the running transfer. */
	abort: () => void;
	/** Remove a received file. */
	removeFile: (id: string) => void;
	/** Clear the locker. */
	clearFiles: () => void;
	/** Download a received file to the user's machine. */
	downloadFile: (id: string) => void;
}

/**
 * Manage the file transfers for a session.
 */
export function useTransfers(send: (data: Uint8Array) => void): TransfersApi {
	const sessionRef = useRef<TransferSession | null>(null);
	const sinkRef = useRef<CollectingSink | null>(null);
	const store = useRef(new FileStore());
	const progressRef = useRef<TransferProgress | null>(null);
	const [state, setState] = useState<TransferState>({
		detected: null,
		progress: null,
		result: null,
		error: null,
		files: [],
		active: false,
	});

	const refreshFiles = useCallback(() => {
		void store.current.list().then((files) => setState((s) => ({ ...s, files })));
	}, []);

	useEffect(() => {
		refreshFiles();
	}, [refreshFiles]);

	/**
	 * Begin a transfer.
	 *
	 * The remote host has already sent the handshake, so the protocol engine
	 * is created with an explicit protocol rather than by auto-detection.
	 */
	const start = useCallback(
		(detected: DetectedTransfer) => {
			if (sessionRef.current) return;
			const direction = detected === 'zmodem-upload' ? 'send' : 'receive';
			const protocol =
				detected === 'zmodem-download' || detected === 'zmodem-upload'
					? 'zmodem'
					: detected === 'ymodem-g'
						? 'ymodem-g'
						: detected === 'xmodem-chksum'
							? 'xmodem-chksum'
							: 'xmodem-crc';
			const session = new TransferSession({
				protocol,
				direction,
				sink: undefined,
				sinkFactory: () => {
					const sink = new CollectingSink();
					sinkRef.current = sink;
					return sink as unknown as FileSink;
				},
				onOutput: (bytes) => send(bytes),
				onProgress: (progress) => {
					progressRef.current = progress;
					setState((s) => ({ ...s, progress, active: true }));
				},
				onDone: (result) => {
					const sink = sinkRef.current;
					const name = result.fileNames?.[0] || progressRef.current?.fileName || 'received.bin';
					if (sink && sink.size > 0) {
						void store.current
							.put(
								{
									id: crypto.randomUUID(),
									name,
									size: sink.size,
									type: guessMimeType(name),
									receivedAt: Date.now(),
								},
								sink.toBlob(guessMimeType(name)),
							)
							.then(refreshFiles);
					}
					setState((s) => ({ ...s, result, error: null, active: false }));
				},
				onError: (error) => {
					setState((s) => ({ ...s, error, active: false }));
				},
			});
			sessionRef.current = session;
			setState((s) => ({ ...s, detected, active: true }));
			// The engine emits its first frame (ZRINIT for ZMODEM).
			const out = session.poll();
			if (out.length > 0) send(out);
		},
		[send, refreshFiles],
	);

	const receive = useCallback(
		(data: Uint8Array) => {
			const session = sessionRef.current;
			if (!session) return;
			session.receive(data);
			const out = session.poll();
			if (out.length > 0) send(out);
		},
		[send],
	);

	useEffect(() => {
		progressRef.current = state.progress;
	}, [state.progress]);

	const abort = useCallback(() => {
		sessionRef.current?.abort();
		const out = sessionRef.current?.poll();
		if (out && out.length > 0) send(out);
	}, [send]);

	const removeFile = useCallback(
		(id: string) => {
			void store.current.remove(id).then(refreshFiles);
		},
		[refreshFiles],
	);

	const clearFiles = useCallback(() => {
		void store.current.clear().then(refreshFiles);
	}, [refreshFiles]);

	const downloadFile = useCallback(
		(id: string) => {
			void store.current.get(id).then((blob) => {
				if (!blob) return;
				const url = URL.createObjectURL(blob);
				const link = document.createElement('a');
				link.href = url;
				link.download = id;
				link.click();
				URL.revokeObjectURL(url);
			});
		},
		[],
	);

	useEffect(
		() => () => {
			sessionRef.current?.dispose();
		},
		[],
	);

	return { state, start, receive, abort, removeFile, clearFiles, downloadFile };
}
