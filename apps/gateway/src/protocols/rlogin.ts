import { openTcpSocket, wireSocket } from './util.js';
import type { ConnectFunction, ConnectHandlers, ConnectOptions, RemoteConnection } from './types.js';

export interface RloginHandshakeOptions {
	user?: string;
	password?: string;
	term: string;
	bps?: number;
	reversed?: boolean;
}

/**
 * Build the RFC 1282 rlogin handshake exactly as SyncTERM does
 * (`src/syncterm/rlogin.c`): four NUL-terminated strings written back to
 * back. The first two are empty and the credentials, then the terminal
 * type/speed advertised by the `user` field, then `<emulation>/<speed>`.
 *
 * In reversed mode the two credential values are swapped, matching
 * `CONN_TYPE_RLOGIN_REVERSED` upstream.
 */
export function buildRloginHandshake(options: RloginHandshakeOptions): Buffer {
	const user = options.user ?? '';
	const password = options.password ?? '';
	const speed = options.bps && Number.isFinite(options.bps) ? Math.trunc(options.bps) : 115200;

	const serverUser = options.reversed ? user : password;
	const terminalField = options.reversed ? password : user;

	const parts = [
		Buffer.from([0x00]), // client user name: intentionally empty
		Buffer.from(`${serverUser}\0`, 'utf8'),
		Buffer.from(`${terminalField}\0`, 'utf8'),
		Buffer.from(`${options.term}/${speed}\0`, 'utf8'),
	];
	return Buffer.concat(parts);
}

/** RLogin (TCP 513). Bytes after the handshake are forwarded transparently. */
export const connect: ConnectFunction = async (
	options: ConnectOptions,
	handlers: ConnectHandlers,
): Promise<RemoteConnection> => {
	const socket = await openTcpSocket(options.host, options.port, options.allowPrivate);

	socket.write(
		buildRloginHandshake({
			...(options.user !== undefined ? { user: options.user } : {}),
			...(options.password !== undefined ? { password: options.password } : {}),
			term: options.term,
			bps: options.bps,
			reversed: options.reversed === true,
		}),
	);

	let firstChunk = true;
	return wireSocket(
		socket,
		{
			onData(data: Buffer): void {
				let payload = data;
				// RFC 1282: the server acknowledges the handshake with a single
				// NUL byte. Do not show it in the terminal.
				if (firstChunk) {
					firstChunk = false;
					if (payload.length > 0 && payload[0] === 0x00) payload = payload.subarray(1);
				}
				if (payload.length > 0) handlers.onData(payload);
			},
			onClose: handlers.onClose,
			onError: handlers.onError,
		},
		'remote closed the connection',
	);
};
