/**
 * The connection manager.
 *
 * Owns the WebSocket to the gateway, performs the telnet negotiation in the
 * browser, applies the output speed emulation and exposes the byte stream to
 * the terminal engine.
 */

import { TelnetNegotiator, type TelnetOptions } from '@websyncterm/core';

/** The protocols the gateway understands. */
export type Protocol = 'telnet' | 'telnets' | 'ssh' | 'rlogin' | 'raw';

/** The state of a connection. */
export type ConnectionState =
	| 'idle'
	| 'connecting'
	| 'connected'
	| 'disconnecting'
	| 'disconnected'
	| 'error';

/** Options for opening a connection. */
export interface ConnectOptions {
	host: string;
	port: number;
	protocol?: Protocol;
	username?: string;
	password?: string;
	systemPassword?: string;
	terminalType?: string;
	cols?: number;
	rows?: number;
	/** Output speed emulation in bits per second; 0 = unlimited. */
	speed?: number;
	/** The gateway's WebSocket URL. */
	gatewayUrl?: string;
	/** An optional bearer token for a locked-down gateway. */
	token?: string;
}

/** A message from the gateway. */
export interface GatewayMessage {
	type: string;
	[key: string]: unknown;
}

/** Callbacks fired by the connection manager. */
export interface ConnectionHandlers {
	/** Bytes received from the remote host, after telnet negotiation. */
	onData?: (data: Uint8Array) => void;
	/** Bytes to send to the remote host. */
	onSend?: (data: Uint8Array) => void;
	/** The connection state changed. */
	onState?: (state: ConnectionState, detail?: string) => void;
	/** A control message arrived from the gateway. */
	onMessage?: (message: GatewayMessage) => void;
	/** The terminal size changed (so NAWS can be sent). */
	onResize?: (cols: number, rows: number) => void;
}

/** The default gateway URL. */
export const DEFAULT_GATEWAY_URL =
	typeof location !== 'undefined' && location.port === '5173'
		? 'ws://localhost:8023'
		: `${typeof location !== 'undefined' ? location.protocol : 'http:'}//${typeof location !== 'undefined' ? location.host : 'localhost:8023'}`;

/**
 * Manages one connection to a BBS.
 */
export class ConnectionManager {
	private socket: WebSocket | null = null;
	private telnet: TelnetNegotiator | null = null;
	private state: ConnectionState = 'idle';
	private opts: ConnectOptions | null = null;

	/** Bytes waiting to be sent, with the time they should be sent. */
	private sendQueue: Uint8Array[] = [];
	private sendTimer: ReturnType<typeof setTimeout> | null = null;
	private nextSendAt = 0;

	constructor(private readonly handlers: ConnectionHandlers = {}) {}

	/** The current state. */
	getState(): ConnectionState {
		return this.state;
	}

	/** Whether the connection is usable. */
	get connected(): boolean {
		return this.state === 'connected' && this.socket?.readyState === WebSocket.OPEN;
	}

	/** Open a connection. */
	connect(options: ConnectOptions): void {
		this.close();
		this.opts = options;
		this.setState('connecting');

		const params = new URLSearchParams();
		params.set('host', options.host);
		params.set('port', String(options.port));
		params.set('proto', options.protocol ?? 'telnet');
		if (options.username) params.set('user', options.username);
		if (options.password) params.set('pass', options.password);
		if (options.systemPassword) params.set('syspass', options.systemPassword);
		if (options.terminalType) params.set('term', options.terminalType);
		if (options.cols) params.set('cols', String(options.cols));
		if (options.rows) params.set('rows', String(options.rows));
		if (options.token) params.set('token', options.token);

		const base = options.gatewayUrl ?? DEFAULT_GATEWAY_URL;
		const url = `${base.replace(/\/$/, '')}/ws?${params.toString()}`;

		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch (err) {
			this.setState('error', String(err));
			return;
		}
		socket.binaryType = 'arraybuffer';
		this.socket = socket;

		const telnetOptions: TelnetOptions = {
			terminalType: options.terminalType ?? 'syncterm',
			cols: options.cols ?? 80,
			rows: options.rows ?? 25,
		};
		this.telnet = new TelnetNegotiator((data) => this.rawSend(data), telnetOptions);

		socket.onopen = () => {
			this.telnet?.start();
			this.setState('connected');
		};
		socket.onmessage = (event) => {
			if (typeof event.data === 'string') {
				try {
					this.handlers.onMessage?.(JSON.parse(event.data) as GatewayMessage);
				} catch {
					/* ignore malformed control frames */
				}
				return;
			}
			const bytes = new Uint8Array(event.data as ArrayBuffer);
			if (this.telnet) {
				const payload = this.telnet.process(bytes);
				if (payload.length > 0) this.handlers.onData?.(payload);
			} else {
				this.handlers.onData?.(bytes);
			}
		};
		socket.onerror = () => {
			this.setState('error', 'The gateway reported a connection error.');
		};
		socket.onclose = (event) => {
			this.setState('disconnected', event.reason || undefined);
		};
	}

	/** Send bytes to the remote host. */
	send(data: Uint8Array): void {
		if (!this.telnet || !this.socket) return;
		const encoded = this.telnet.encodeOutgoing(data);
		if (encoded.length === 0) return;
		const speed = this.opts?.speed ?? 0;
		if (!speed) {
			this.rawSend(encoded);
			return;
		}
		this.enqueue(encoded, speed);
	}

	/**
	 * Queue bytes, honouring the simulated line speed.
	 *
	 * At 9600 baud a byte takes roughly 1.04 ms to transmit, so a 1 KiB chunk
	 * takes about a second.
	 */
	private enqueue(data: Uint8Array, bitsPerSecond: number): void {
		const bytesPerSecond = bitsPerSecond / 8;
		this.sendQueue.push(data);
		const now = Date.now();
		this.nextSendAt = Math.max(this.nextSendAt, now);
		this.pump(bytesPerSecond);
	}

	private pump(bytesPerSecond: number): void {
		if (this.sendTimer !== null) return;
		const tick = (): void => {
			this.sendTimer = null;
			const now = Date.now();
			let budget = Math.max(1, Math.floor(((now - this.nextSendAt) / 1000) * bytesPerSecond));
			while (this.sendQueue.length > 0 && budget > 0) {
				const head = this.sendQueue[0];
				const take = Math.min(head.length, budget);
				this.rawSend(head.subarray(0, take));
				budget -= take;
				if (take === head.length) this.sendQueue.shift();
				else this.sendQueue[0] = head.subarray(take);
			}
			if (this.sendQueue.length > 0) {
				const now2 = Date.now();
				this.nextSendAt = now2 + Math.max(0, this.nextSendAt - now2);
				const wait = Math.max(1, Math.ceil((this.sendQueue[0].length / bytesPerSecond) * 1000));
				this.sendTimer = setTimeout(tick, wait);
			}
		};
		this.sendTimer = setTimeout(tick, 0);
	}

	/** Send bytes straight to the socket, bypassing the throttle. */
	private rawSend(data: Uint8Array): void {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
		this.socket.send(data);
	}

	/** Tell the gateway that the terminal size changed. */
	resize(cols: number, rows: number): void {
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
		}
		if (this.telnet) {
			this.telnet.sendWindowChange();
		}
	}

	/** Close the connection. */
	close(): void {
		if (this.sendTimer !== null) {
			clearTimeout(this.sendTimer);
			this.sendTimer = null;
		}
		this.sendQueue = [];
		if (this.socket) {
			try {
				if (this.socket.readyState === WebSocket.OPEN) {
					this.socket.send(JSON.stringify({ type: 'disconnect' }));
				}
				this.socket.close();
			} catch {
				/* ignore */
			}
			this.socket = null;
		}
		this.telnet = null;
		if (this.state !== 'idle') this.setState('disconnected');
	}

	private setState(state: ConnectionState, detail?: string): void {
		this.state = state;
		this.handlers.onState?.(state, detail);
	}
}
