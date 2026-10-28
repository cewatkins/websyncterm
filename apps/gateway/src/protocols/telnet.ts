import { openTcpSocket, wireSocket } from './util.js';
import type { ConnectFunction, ConnectHandlers, ConnectOptions, RemoteConnection } from './types.js';

/** IAC SB NAWS ... IAC SE */
export function buildNawsFrame(cols: number, rows: number): Buffer {
	const safeCols = Math.max(0, Math.min(0xffff, Math.trunc(cols)));
	const safeRows = Math.max(0, Math.min(0xffff, Math.trunc(rows)));
	return Buffer.from([
		0xff,
		0xfa,
		0x1f,
		(safeCols >> 8) & 0xff,
		safeCols & 0xff,
		(safeRows >> 8) & 0xff,
		safeRows & 0xff,
		0xff,
		0xf0,
	]);
}

/**
 * Passively watches the server→client stream for `IAC DO NAWS` so we know
 * when it is safe to emit window-size reports. The gateway performs no
 * negotiation itself; the browser does that.
 */
class NawsTracker {
	enabled = false;
	private tail = Buffer.alloc(0);

	push(chunk: Buffer): void {
		if (this.enabled) return;
		const data = this.tail.length > 0 ? Buffer.concat([this.tail, chunk]) : chunk;
		for (let i = 0; i + 2 < data.length; i += 1) {
			if (data[i] === 0xff && data[i + 1] === 0xfd && data[i + 2] === 0x1f) {
				this.enabled = true;
				this.tail = Buffer.alloc(0);
				return;
			}
		}
		this.tail = Buffer.from(data.subarray(Math.max(0, data.length - 2)));
	}
}

/**
 * Attach the shared telnet handling to an already-connected socket.
 * Exported so `telnets` can reuse it once TLS is established.
 */
export function createTelnetConnection(
	socket: import('node:net').Socket,
	handlers: ConnectHandlers,
	clientOwnsNaws = false,
): RemoteConnection {
	const tracker = new NawsTracker();
	let latestSize: { cols: number; rows: number } | null = null;

	const connection = wireSocket(
		socket,
		{
			onData(data: Buffer): void {
				tracker.push(data);
				if (!clientOwnsNaws && tracker.enabled && latestSize) {
					socket.write(buildNawsFrame(latestSize.cols, latestSize.rows));
					latestSize = null;
				}
				handlers.onData(data);
			},
			onClose: handlers.onClose,
			onError: handlers.onError,
		},
		'remote closed the connection',
	);

	return {
		...connection,
		resize(cols: number, rows: number): void {
			if (clientOwnsNaws) return;
			if (tracker.enabled) {
				socket.write(buildNawsFrame(cols, rows));
			} else {
				latestSize = { cols, rows };
			}
		},
	};
}

/**
 * Plain telnet. Bytes are forwarded verbatim in both directions, including
 * 0xFF, so the browser-side TelnetNegotiator can own IAC negotiation.
 */
export const connect: ConnectFunction = async (
	options: ConnectOptions,
	handlers: ConnectHandlers,
): Promise<RemoteConnection> => {
	const socket = await openTcpSocket(options.host, options.port, options.allowPrivate);
	return createTelnetConnection(socket, handlers, options.clientOwnsNaws);
};
