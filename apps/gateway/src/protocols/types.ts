/** Protocols the gateway can speak to a remote BBS. */
export type ProtocolName = 'telnet' | 'telnets' | 'ssh' | 'rlogin' | 'raw';

export const PROTOCOLS: readonly ProtocolName[] = ['telnet', 'telnets', 'ssh', 'rlogin', 'raw'];

export function isProtocolName(value: string): value is ProtocolName {
	return (PROTOCOLS as readonly string[]).includes(value);
}

export interface ConnectOptions {
	host: string;
	port: number;
	/** Remote login name for SSH, or the "terminal type/speed" field for RLogin. */
	user?: string;
	/** Remote password for SSH, or the "server user name" field for RLogin. */
	password?: string;
	/** SyncTERM-style system password (kept for parity; not sent in-band). */
	systemPassword?: string;
	/** OpenSSH private key in PEM format. Never logged. */
	privateKey?: string;
	term: string;
	cols: number;
	rows: number;
	mode?: number;
	/** RLogin terminal speed, defaults to 115200. */
	bps: number;
	/** RLogin reversed mode: swap the two credential fields. */
	reversed?: boolean;
	/** When true, private/loopback destinations are permitted (trusted LAN). */
	allowPrivate: boolean;
	/** Verify remote TLS certificates (telnets). */
	tlsVerify: boolean;
	/**
	 * True when the client performs its own NAWS negotiation.
	 *
	 * The browser-side TelnetNegotiator owns IAC negotiation, so the gateway
	 * must not inject its own NAWS frames or the server may end up with a
	 * stale window size.
	 */
	clientOwnsNaws: boolean;
}

/**
 * Callbacks a protocol implementation invokes. `onData`, `onClose` and
 * `onError` may each fire more than once only if the underlying socket does;
 * the caller is responsible for making its handlers idempotent.
 */
export interface ConnectHandlers {
	onData(data: Buffer): void;
	onClose(reason: string): void;
	onError(error: Error): void;
	/**
	 * Ask the user to accept a host key. Resolves true when accepted.
	 * Only used by the SSH protocol.
	 */
	requestHostKey?(fingerprint: string): Promise<boolean>;
}

export interface RemoteConnection {
	/** Send raw bytes to the remote host. */
	write(data: Buffer): void;
	/** Tell the remote host about a new window size. */
	resize(cols: number, rows: number): void;
	/** Pause reading from the remote host (backpressure). */
	pause?(): void;
	/** Resume reading from the remote host. */
	resume?(): void;
	/** Tear the connection down. */
	close(): void;
}

export type ConnectFunction = (
	options: ConnectOptions,
	handlers: ConnectHandlers,
) => Promise<RemoteConnection>;
