import { openTlsSocket } from './util.js';
import { createTelnetConnection } from './telnet.js';
import type { ConnectFunction, ConnectHandlers, ConnectOptions, RemoteConnection } from './types.js';

/** Telnet over TLS (default port 992). */
export const connect: ConnectFunction = async (
	options: ConnectOptions,
	handlers: ConnectHandlers,
): Promise<RemoteConnection> => {
	const socket = await openTlsSocket(
		options.host,
		options.port,
		options.allowPrivate,
		options.tlsVerify,
	);
	return createTelnetConnection(socket, handlers);
};
