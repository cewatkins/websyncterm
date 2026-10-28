import net from 'node:net';
import tls from 'node:tls';
import { isRemoteAddressAllowed } from '../security.js';
import type { ConnectHandlers, ProtocolName, RemoteConnection } from './types.js';

export const DEFAULT_PORTS: Record<ProtocolName, number> = {
	telnet: 23,
	telnets: 992,
	ssh: 22,
	rlogin: 513,
	raw: 23,
};

const SSRF_MESSAGE = 'Destination address is blocked by SSRF protection';

function socketError(message: string, cause?: unknown): Error {
	const error = new Error(message);
	if (cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
	return error;
}

/**
 * Open a plain TCP connection and re-check the peer address after connect to
 * defend against DNS rebinding.
 */
export async function openTcpSocket(
	host: string,
	port: number,
	allowPrivate: boolean,
): Promise<net.Socket> {
	const socket = net.connect({ host, port });
	try {
		await new Promise<void>((resolve, reject) => {
			const onConnect = (): void => {
				socket.off('error', onError);
				resolve();
			};
			const onError = (error: Error): void => {
				socket.off('connect', onConnect);
				reject(error);
			};
			socket.once('connect', onConnect);
			socket.once('error', onError);
		});
	} catch (error) {
		socket.destroy();
		throw error;
	}

	if (!isRemoteAddressAllowed(socket.remoteAddress, allowPrivate)) {
		socket.destroy();
		throw socketError(SSRF_MESSAGE);
	}
	return socket;
}

/** Open a TLS connection (used by `telnets`). */
export async function openTlsSocket(
	host: string,
	port: number,
	allowPrivate: boolean,
	verify: boolean,
): Promise<tls.TLSSocket> {
	const socket = tls.connect({
		host,
		port,
		servername: net.isIP(host) ? undefined : host,
		rejectUnauthorized: verify,
	});
	try {
		await new Promise<void>((resolve, reject) => {
			const onConnect = (): void => {
				socket.off('error', onError);
				resolve();
			};
			const onError = (error: Error): void => {
				socket.off('secureConnect', onConnect);
				reject(error);
			};
			socket.once('secureConnect', onConnect);
			socket.once('error', onError);
		});
	} catch (error) {
		socket.destroy();
		throw error;
	}

	if (!isRemoteAddressAllowed(socket.remoteAddress, allowPrivate)) {
		socket.destroy();
		throw socketError(SSRF_MESSAGE);
	}
	return socket;
}

/**
 * Attach the shared data/error/close wiring to a connected socket and expose
 * it through the protocol-neutral connection interface.
 */
export function wireSocket(
	socket: net.Socket,
	handlers: ConnectHandlers,
	remoteCloseReason = 'remote closed the connection',
): RemoteConnection {
	let notifiedClose = false;
	socket.setNoDelay(true);
	socket.on('data', (data: Buffer) => handlers.onData(data));
	socket.on('error', (error: Error) => handlers.onError(error));
	socket.on('close', () => {
		if (notifiedClose) return;
		notifiedClose = true;
		handlers.onClose(remoteCloseReason);
	});

	return {
		write(data: Buffer): void {
			if (socket.destroyed || !socket.writable) return;
			socket.write(data);
		},
		resize(): void {
			// Plain sockets have no out-of-band resize channel.
		},
		pause(): void {
			socket.pause();
		},
		resume(): void {
			socket.resume();
		},
		close(): void {
			notifiedClose = true;
			socket.destroy();
		},
	};
}

/** Clamp a terminal dimension to a sane range. */
export function clampDimension(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(1, Math.min(1000, Math.trunc(value)));
}

/** Human-readable error message with credentials never included. */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
