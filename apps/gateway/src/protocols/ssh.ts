import { createHash } from 'node:crypto';
import { Client, type ConnectConfig } from 'ssh2';
import { isRemoteAddressAllowed } from '../security.js';
import { errorMessage } from './util.js';
import type { ConnectFunction, ConnectHandlers, ConnectOptions, RemoteConnection } from './types.js';

/** Compute the OpenSSH-style SHA-256 fingerprint of a raw host key blob. */
export function hostKeyFingerprint(key: Buffer): string {
	return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

const SSRF_MESSAGE = 'Destination address is blocked by SSRF protection';

interface SshSocketCarrier {
	_sock?: { remoteAddress?: string };
}

/**
 * SSH via `ssh2`: password and/or public-key authentication, an interactive
 * shell with a PTY, and host-key acceptance surfaced to the browser.
 *
 * No SSH agent support: the key, when used, is supplied by the client.
 */
export const connect: ConnectFunction = async (
	options: ConnectOptions,
	handlers: ConnectHandlers,
): Promise<RemoteConnection> => {
	if (!options.user) {
		throw new Error('SSH requires a username');
	}
	if (!options.password && !options.privateKey) {
		throw new Error('SSH requires a password or private key');
	}

	const client = new Client();
	let established = false;
	let promiseSettled = false;
	let closed = false;
	let rejected = false;

	const config: ConnectConfig = {
		host: options.host,
		port: options.port,
		username: options.user,
		readyTimeout: 60_000,
		keepaliveInterval: 30_000,
		keepaliveCountMax: 3,
		...(options.password !== undefined ? { password: options.password } : {}),
		...(options.privateKey !== undefined ? { privateKey: options.privateKey } : {}),
		hostVerifier: (key: Buffer, verify: (valid: boolean) => void): void => {
			const fingerprint = hostKeyFingerprint(key);
			if (!handlers.requestHostKey) {
				verify(false);
				return;
			}
			handlers
				.requestHostKey(fingerprint)
				.then((accepted) => verify(accepted))
				.catch(() => verify(false));
		},
	};

	return await new Promise<RemoteConnection>((resolve, reject) => {
		const rejectOnce = (error: Error): void => {
			if (promiseSettled) return;
			promiseSettled = true;
			try {
				client.end();
			} catch {
				// already gone
			}
			reject(error);
		};

		const closeOnce = (reason: string): void => {
			if (closed) return;
			closed = true;
			if (!established) {
				if (!promiseSettled) {
					promiseSettled = true;
					reject(new Error(reason));
				}
				return;
			}
			handlers.onClose(reason);
		};

		client.on('connect', () => {
			const remoteAddress = (client as unknown as SshSocketCarrier)._sock?.remoteAddress;
			if (!isRemoteAddressAllowed(remoteAddress, options.allowPrivate)) {
				rejected = true;
				rejectOnce(new Error(SSRF_MESSAGE));
			}
		});

		client.on('ready', () => {
			if (rejected) return;
			client.shell(
				{
					term: options.term,
					cols: options.cols,
					rows: options.rows,
					width: options.cols,
					height: options.rows,
				},
				(error, channel) => {
					if (error) {
						rejectOnce(error);
						return;
					}
					established = true;
					if (!promiseSettled) promiseSettled = true;

					channel.on('data', (data: Buffer) => handlers.onData(data));
					channel.stderr.on('data', (data: Buffer) => handlers.onData(data));
					channel.on('close', () => closeOnce('remote closed the connection'));

					resolve({
						write(data: Buffer): void {
							if (channel.writable) channel.write(data);
						},
						resize(cols: number, rows: number): void {
							channel.setWindow(rows, cols, 0, 0);
						},
						pause(): void {
							channel.pause();
						},
						resume(): void {
							channel.resume();
						},
						close(): void {
							closed = true;
							try {
								channel.close();
							} catch {
								// ignore
							}
							try {
								client.end();
							} catch {
								// ignore
							}
						},
					});
				},
			);
		});

		client.on('error', (error: Error) => {
			if (!established) {
				rejectOnce(new Error(errorMessage(error)));
			} else {
				handlers.onError(error);
			}
		});

		client.on('close', () => closeOnce('remote closed the connection'));

		try {
			client.connect(config);
		} catch (error) {
			rejectOnce(new Error(errorMessage(error)));
		}
	});
};
