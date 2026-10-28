import { openTcpSocket, wireSocket } from './util.js';
import type { ConnectFunction, ConnectHandlers, ConnectOptions, RemoteConnection } from './types.js';

/** Raw TCP with no negotiation at all. */
export const connect: ConnectFunction = async (
	options: ConnectOptions,
	handlers: ConnectHandlers,
): Promise<RemoteConnection> => {
	const socket = await openTcpSocket(options.host, options.port, options.allowPrivate);
	return wireSocket(socket, handlers, 'remote closed the connection');
};
