import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { GatewayConfig } from './config.js';
import { isHostAllowed, normaliseHost, resolveAndValidateHost } from './security.js';
import { connectors, DEFAULT_PORTS, isProtocolName } from './protocols/index.js';
import type { ProtocolName } from './protocols/types.js';
import { errorMessage } from './protocols/util.js';
import type { RemoteConnection } from './protocols/types.js';

export interface SessionLogger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface SessionRequest {
	host?: string;
	port?: number;
	proto?: ProtocolName;
	user?: string;
	password?: string;
	systemPassword?: string;
	privateKey?: string;
	term?: string;
	cols?: number;
	rows?: number;
	mode?: number;
	bps?: number;
	reversed?: boolean;
	/**
	 * True when the client performs its own NAWS negotiation, in which case
	 * the gateway must not inject NAWS frames of its own.
	 */
	clientOwnsNaws?: boolean;
}

const WAITING_TIMEOUT_MS = 60_000;

function asRecord(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Expected a JSON object');
	}
	return value as Record<string, unknown>;
}

function rawValue(raw: Record<string, unknown>, keys: readonly string[]): unknown {
	for (const key of keys) {
		const value = raw[key];
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			if (value.length === 0) continue;
			return value[value.length - 1];
		}
		return value;
	}
	return undefined;
}

function readString(raw: Record<string, unknown>, keys: readonly string[]): string | undefined {
	const value = rawValue(raw, keys);
	if (value === undefined) return undefined;
	if (typeof value === 'string') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	throw new Error(`Invalid value for ${keys[0] ?? 'parameter'}`);
}

function readInteger(
	raw: Record<string, unknown>,
	keys: readonly string[],
	min: number,
	max: number,
): number | undefined {
	const value = rawValue(raw, keys);
	if (value === undefined) return undefined;
	const parsed =
		typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN;
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(`Invalid value for ${keys[0] ?? 'parameter'}`);
	}
	return parsed;
}

function readBoolean(
	raw: Record<string, unknown>,
	keys: readonly string[],
): boolean | undefined {
	const value = rawValue(raw, keys);
	if (value === undefined) return undefined;
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return value !== 0;
	if (typeof value === 'string') {
		const normalised = value.trim().toLowerCase();
		if (['1', 'true', 'yes', 'on'].includes(normalised)) return true;
		if (['0', 'false', 'no', 'off'].includes(normalised)) return false;
	}
	throw new Error(`Invalid value for ${keys[0] ?? 'parameter'}`);
}

/**
 * Parse query-string or `connect`-message parameters. Throws a
 * user-presentable error when a value is malformed. Credential values are
 * retained in memory for the connection attempt only.
 */
export function parseSessionRequest(raw: Record<string, unknown>): SessionRequest {
	const request: SessionRequest = {};

	const host = readString(raw, ['host']);
	if (host !== undefined) {
		if (host.trim().length === 0) throw new Error('Missing host');
		request.host = host.trim();
	}

	const port = readInteger(raw, ['port'], 1, 65_535);
	if (port !== undefined) request.port = port;

	const proto = readString(raw, ['proto', 'protocol']);
	if (proto !== undefined) {
		const normalised = proto.trim().toLowerCase();
		if (!isProtocolName(normalised)) throw new Error('Unsupported protocol');
		request.proto = normalised;
	}

	const user = readString(raw, ['user', 'username']);
	if (user !== undefined) request.user = user;

	const password = readString(raw, ['password', 'pass']);
	if (password !== undefined) request.password = password;

	const systemPassword = readString(raw, ['systemPassword', 'syspass']);
	if (systemPassword !== undefined) request.systemPassword = systemPassword;

	const privateKey = readString(raw, ['privateKey', 'key']);
	if (privateKey !== undefined) request.privateKey = privateKey;

	const term = readString(raw, ['term']);
	if (term !== undefined) request.term = term;

	const cols = readInteger(raw, ['cols'], 1, 1000);
	if (cols !== undefined) request.cols = cols;

	const rows = readInteger(raw, ['rows'], 1, 1000);
	if (rows !== undefined) request.rows = rows;

	const mode = readInteger(raw, ['mode'], 0, 2 ** 31 - 1);
	if (mode !== undefined) request.mode = mode;

	const bps = readInteger(raw, ['bps', 'speed'], 1, 2 ** 31 - 1);
	if (bps !== undefined) request.bps = bps;

	const reversed = readBoolean(raw, ['reversed']);
	if (reversed !== undefined) request.reversed = reversed;

	const clientOwnsNaws = raw['naws'];
	if (clientOwnsNaws !== undefined) {
		request.clientOwnsNaws = clientOwnsNaws === true || clientOwnsNaws === '1' || clientOwnsNaws === 1;
	}

	return request;
}

/** Overlay defined fields of `patch` onto `base`. */
export function mergeSessionRequests(base: SessionRequest, patch: SessionRequest): SessionRequest {
	return { ...base, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
}

interface HostKeyWaiter {
	resolve(accepted: boolean): void;
	timer: NodeJS.Timeout;
}

export interface SessionManagerOptions {
	config: GatewayConfig;
	logger: SessionLogger;
}

export class SessionManager {
	readonly config: GatewayConfig;
	private readonly logger: SessionLogger;
	private readonly sessions = new Map<string, Session>();
	private readonly attempts = new Map<string, number[]>();
	private readonly sweepTimer: NodeJS.Timeout;

	constructor(options: SessionManagerOptions) {
		this.config = options.config;
		this.logger = options.logger;
		const interval = Math.max(1000, Math.min(30_000, Math.floor(this.config.idleTimeoutMs / 2)));
		this.sweepTimer = setInterval(() => this.sweep(), interval);
		this.sweepTimer.unref();
	}

	get count(): number {
		return this.sessions.size;
	}

	/** Create a session for an upgraded WebSocket, enforcing global and per-IP limits. */
	accept(socket: WebSocket, ip: string, request: SessionRequest): void {
		if (this.sessions.size >= this.config.maxSessions) {
			this.rejectSocket(socket, 'Gateway is at capacity; try again later');
			return;
		}
		if (!this.recordAttempt(ip)) {
			this.rejectSocket(socket, 'Too many connection attempts; try again later');
			return;
		}

		const session = new Session({
			id: randomUUID(),
			socket,
			ip,
			request,
			manager: this,
			config: this.config,
			logger: this.logger,
		});
		this.sessions.set(session.id, session);
		this.logger.info(
			`session ${session.id} opened from ${ip} for ${request.proto ?? 'telnet'} ${request.host ?? '(pending)'}`,
		);
		session.start();
	}

	remove(id: string): void {
		this.sessions.delete(id);
	}

	closeAll(): void {
		for (const session of [...this.sessions.values()]) {
			session.terminate('gateway shutting down');
		}
		this.sessions.clear();
	}

	dispose(): void {
		clearInterval(this.sweepTimer);
		this.closeAll();
	}

	private recordAttempt(ip: string): boolean {
		const now = Date.now();
		const windowStart = now - 60_000;
		const recent = (this.attempts.get(ip) ?? []).filter((time) => time > windowStart);
		if (recent.length >= this.config.sessionRateLimit) {
			this.attempts.set(ip, recent);
			return false;
		}
		recent.push(now);
		this.attempts.set(ip, recent);
		return true;
	}

	private rejectSocket(socket: WebSocket, message: string): void {
		try {
			if (socket.readyState === socket.OPEN) {
				socket.send(JSON.stringify({ type: 'error', message }));
				socket.close(1013, 'try again later');
			}
		} catch {
			// The socket may already be gone.
		}
	}

	private sweep(): void {
		const now = Date.now();
		const windowStart = now - 60_000;
		for (const [ip, times] of this.attempts) {
			const recent = times.filter((time) => time > windowStart);
			if (recent.length === 0) this.attempts.delete(ip);
			else this.attempts.set(ip, recent);
		}
		for (const session of [...this.sessions.values()]) {
			session.checkIdle(now);
		}
	}
}

interface SessionOptions {
	id: string;
	socket: WebSocket;
	ip: string;
	request: SessionRequest;
	manager: SessionManager;
	config: GatewayConfig;
	logger: SessionLogger;
}

type SessionState = 'waiting' | 'connecting' | 'connected' | 'closed';

class Session {
	readonly id: string;
	readonly ip: string;
	readonly createdAt = Date.now();
	lastActivity = Date.now();

	private readonly socket: WebSocket;
	private readonly manager: SessionManager;
	private readonly config: GatewayConfig;
	private readonly logger: SessionLogger;
	private request: SessionRequest;
	private state: SessionState = 'waiting';
	private connection: RemoteConnection | null = null;
	private pendingInput: Buffer[] = [];
	private pendingBytes = 0;
	private outboundPaused = false;
	private hostKeyWaiter: HostKeyWaiter | null = null;
	private cols: number;
	private rows: number;

	constructor(options: SessionOptions) {
		this.id = options.id;
		this.ip = options.ip;
		this.socket = options.socket;
		this.manager = options.manager;
		this.config = options.config;
		this.logger = options.logger;
		this.request = options.request;
		this.cols = options.request.cols ?? 80;
		this.rows = options.request.rows ?? 24;

		this.socket.on('message', (data: unknown, isBinary: boolean) => {
			this.onMessage(data, isBinary);
		});
		this.socket.on('close', () => {
			this.shutdown('client disconnected', false);
		});
		this.socket.on('error', () => {
			this.shutdown('socket error', false);
		});
		this.socket.on('ping', () => {
			this.touch();
		});
	}

	start(): void {
		if (this.request.host) {
			void this.startConnection();
		}
	}

	checkIdle(now: number): void {
		if (this.state === 'closed') return;
		const timeout = this.state === 'waiting' ? Math.min(WAITING_TIMEOUT_MS, this.config.idleTimeoutMs) : this.config.idleTimeoutMs;
		if (now - this.lastActivity < timeout) return;

		const reason = this.state === 'waiting' ? 'timed out waiting for connect' : 'idle timeout';
		this.sendJson({ type: 'disconnected', reason });
		this.shutdown(reason, false);
	}

	/** Force-close from the manager (shutdown, capacity, etc.). */
	terminate(reason: string): void {
		this.shutdown(reason, true);
	}

	private touch(): void {
		this.lastActivity = Date.now();
	}

	private onMessage(data: unknown, isBinary: boolean): void {
		if (this.state === 'closed') return;
		this.touch();

		const buffer = this.toBuffer(data);
		if (isBinary) {
			this.handleBinary(buffer);
			return;
		}
		this.handleText(buffer.toString('utf8'));
	}

	private toBuffer(data: unknown): Buffer {
		if (Buffer.isBuffer(data)) return data;
		if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
		if (data instanceof ArrayBuffer) return Buffer.from(data);
		if (ArrayBuffer.isView(data)) {
			return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
		}
		return Buffer.from(String(data));
	}

	private handleBinary(data: Buffer): void {
		if (this.connection) {
			this.connection.write(data);
			return;
		}
		if (this.state === 'waiting' || this.state === 'connecting') {
			if (this.pendingBytes + data.length > this.config.maxMessageBytes) {
				this.fail('Input buffer exceeded before the connection was established');
				return;
			}
			this.pendingInput.push(Buffer.from(data));
			this.pendingBytes += data.length;
		}
	}

	private handleText(text: string): void {
		let message: Record<string, unknown>;
		try {
			message = asRecord(JSON.parse(text) as unknown);
		} catch {
			this.sendJson({ type: 'error', message: 'Invalid JSON control message' });
			return;
		}

		const type = typeof message.type === 'string' ? message.type : '';
		switch (type) {
			case 'connect': {
				if (this.state !== 'waiting') {
					this.sendJson({ type: 'error', message: 'Already connected or connecting' });
					return;
				}
				try {
					const patch = parseSessionRequest(message);
					this.request = mergeSessionRequests(this.request, patch);
					if (patch.cols !== undefined) this.cols = patch.cols;
					if (patch.rows !== undefined) this.rows = patch.rows;
				} catch (error) {
					this.fail(errorMessage(error));
					return;
				}
				if (!this.request.host) {
					this.fail('Missing host');
					return;
				}
				void this.startConnection();
				return;
			}
			case 'resize': {
				let cols: number | undefined;
				let rows: number | undefined;
				try {
					cols = readInteger(message, ['cols'], 1, 1000);
					rows = readInteger(message, ['rows'], 1, 1000);
				} catch (error) {
					this.sendJson({ type: 'error', message: errorMessage(error) });
					return;
				}
				if (cols !== undefined) this.cols = cols;
				if (rows !== undefined) this.rows = rows;
				try {
					this.connection?.resize(this.cols, this.rows);
				} catch (error) {
					this.logger.warn(`session ${this.id} resize failed: ${errorMessage(error)}`);
				}
				return;
			}
			case 'disconnect': {
				this.shutdown('client disconnected', true);
				return;
			}
			case 'hostkey-ok': {
				this.resolveHostKey(message.accept === true);
				return;
			}
			case 'ping': {
				this.sendJson({ type: 'pong' });
				return;
			}
			default: {
				this.sendJson({ type: 'error', message: 'Unknown control message type' });
			}
		}
	}

	private async startConnection(): Promise<void> {
		if (this.state !== 'waiting') return;
		this.state = 'connecting';

		const request = this.request;
		const hostInput = request.host;
		if (!hostInput) {
			this.fail('Missing host');
			return;
		}

		const proto = request.proto ?? 'telnet';
		const host = normaliseHost(hostInput);
		const port = request.port ?? DEFAULT_PORTS[proto];

		if (!isHostAllowed(host, port, this.config.allowlist)) {
			this.fail('Host is not permitted by this gateway allowlist');
			return;
		}

		try {
			await resolveAndValidateHost(host, this.config.allowPrivate);
		} catch (error) {
			if (this.isClosed()) return;
			this.logger.warn(`session ${this.id} refused ${host}:${port}: ${errorMessage(error)}`);
			this.fail(errorMessage(error));
			return;
		}

		if (this.isClosed()) return;

		const connect = connectors[proto];
		const options = {
			host,
			port,
			...(request.user !== undefined ? { user: request.user } : {}),
			...(request.password !== undefined ? { password: request.password } : {}),
			...(request.systemPassword !== undefined ? { systemPassword: request.systemPassword } : {}),
			...(request.privateKey !== undefined ? { privateKey: request.privateKey } : {}),
			term: request.term && request.term.length > 0 ? request.term : 'syncterm',
			cols: this.cols,
			rows: this.rows,
			...(request.mode !== undefined ? { mode: request.mode } : {}),
			bps: request.bps ?? 115200,
			reversed: request.reversed === true,
			allowPrivate: this.config.allowPrivate,
			tlsVerify: this.config.tlsVerifyRemote,
			clientOwnsNaws: request.clientOwnsNaws === true,
		};

		try {
			const connection = await connect(options, {
				onData: (data) => this.onRemoteData(data),
				onClose: (reason) => this.onRemoteClose(reason),
				onError: (error) => this.onRemoteError(error),
				requestHostKey: (fingerprint) => this.requestHostKey(fingerprint),
			});

			if (this.isClosed()) {
				connection.close();
				return;
			}

			this.connection = connection;
			this.state = 'connected';
			this.logger.info(`session ${this.id} connected to ${proto} ${host}:${port}`);

			const pending = this.pendingInput;
			this.pendingInput = [];
			this.pendingBytes = 0;
			for (const chunk of pending) connection.write(chunk);

			this.sendJson({ type: 'connected' });
		} catch (error) {
			if (this.isClosed()) return;
			this.logger.warn(`session ${this.id} failed to connect to ${host}:${port}: ${errorMessage(error)}`);
			this.fail(errorMessage(error));
		}
	}

	private isClosed(): boolean {
		return this.state === 'closed';
	}

	private onRemoteData(data: Buffer): void {
		this.touch();
		if (this.state === 'closed') return;
		if (this.socket.readyState !== this.socket.OPEN) return;

		const limit = this.config.maxBufferedOutputBytes;
		if (this.socket.bufferedAmount + data.length > limit) {
			this.pauseRemote();
		}

		try {
			this.socket.send(data, { binary: true }, (error?: Error) => {
				if (!error) this.maybeResumeRemote();
			});
		} catch (error) {
			this.logger.warn(`session ${this.id} send failed: ${errorMessage(error)}`);
			this.shutdown('socket send failed', false);
		}
	}

	private onRemoteClose(reason: string): void {
		if (this.state === 'closed') return;
		this.sendJson({ type: 'disconnected', reason });
		this.shutdown(reason, false);
	}

	private onRemoteError(error: Error): void {
		if (this.state === 'closed') return;
		this.sendJson({ type: 'error', message: errorMessage(error) });
	}

	private pauseRemote(): void {
		if (this.outboundPaused) return;
		this.outboundPaused = true;
		try {
			this.connection?.pause?.();
		} catch {
			// Ignore; the socket may be closing.
		}
	}

	private maybeResumeRemote(): void {
		if (!this.outboundPaused || !this.connection) return;
		if (this.socket.bufferedAmount > this.config.maxBufferedOutputBytes / 8) return;
		this.outboundPaused = false;
		try {
			this.connection.resume?.();
		} catch {
			// Ignore.
		}
	}

	private requestHostKey(fingerprint: string): Promise<boolean> {
		if (this.state === 'closed') return Promise.resolve(false);
		this.resolveHostKey(false);

		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				if (this.hostKeyWaiter?.timer === timer) {
					this.hostKeyWaiter = null;
					resolve(false);
				}
			}, this.config.hostKeyTimeoutMs);
			timer.unref();

			this.hostKeyWaiter = { resolve, timer };
			this.sendJson({ type: 'hostkey', fingerprint });
		});
	}

	private resolveHostKey(accepted: boolean): void {
		const waiter = this.hostKeyWaiter;
		if (!waiter) return;
		this.hostKeyWaiter = null;
		clearTimeout(waiter.timer);
		waiter.resolve(accepted);
	}

	private fail(message: string): void {
		this.sendJson({ type: 'error', message });
		this.shutdown(message, true);
	}

	private sendJson(payload: Record<string, unknown>): void {
		if (this.socket.readyState !== this.socket.OPEN) return;
		try {
			this.socket.send(JSON.stringify(payload));
		} catch {
			// Socket closed between the check and the send.
		}
	}

	private shutdown(reason: string, notify: boolean): void {
		if (this.state === 'closed') return;
		this.state = 'closed';

		if (notify) this.sendJson({ type: 'disconnected', reason });
		this.resolveHostKey(false);

		const connection = this.connection;
		this.connection = null;
		if (connection) {
			try {
				connection.close();
			} catch {
				// Ignore.
			}
		}

		this.pendingInput = [];
		this.pendingBytes = 0;
		this.manager.remove(this.id);

		if (this.socket.readyState === this.socket.OPEN) {
			try {
				this.socket.close(1000, reason.slice(0, 120));
			} catch {
				// Ignore.
			}
		}
		this.logger.info(`session ${this.id} closed: ${reason}`);
	}
}
