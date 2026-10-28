import { fileURLToPath } from 'node:url';

/** Default TCP port for the gateway HTTP/WebSocket listener. */
export const DEFAULT_PORT = 8023;

/** Hard cap on a single inbound WebSocket message (1 MiB). */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Hard cap on bytes buffered for a client before we pause the remote. */
export const MAX_BUFFERED_OUTPUT_BYTES = 8 * 1024 * 1024;

/** How long a client has to answer a host-key prompt, in milliseconds. */
export const HOST_KEY_TIMEOUT_MS = 30_000;

export interface GatewayConfig {
	/** TCP port the gateway listens on. */
	port: number;
	/** Interface to bind. */
	listenHost: string;
	/** Raw allowlist entries (`host`, `host:port`, `*.example.com`). */
	allowlist: string[];
	/** True when the allowlist is empty (any host may be dialled). */
	openDirectory: boolean;
	/** Allowed `Origin` values for WebSocket upgrades. Empty means "allow all". */
	allowedOrigins: string[];
	/** When false, private/loopback/link-local destinations are refused. */
	allowPrivate: boolean;
	maxSessions: number;
	idleTimeoutMs: number;
	/** HTTP requests per minute per IP. */
	rateLimit: number;
	/** New WebSocket sessions per minute per IP. */
	sessionRateLimit: number;
	maxMessageBytes: number;
	maxBufferedOutputBytes: number;
	/** Optional paths to a PEM certificate/key for built-in HTTPS. */
	tlsCertPath?: string;
	tlsKeyPath?: string;
	/** Verify remote TLS certificates for `telnets`. Off by default (BBS certs are typically self-signed). */
	tlsVerifyRemote: boolean;
	/** Directory containing a built embed bundle, if present. */
	embedDistPath: string;
	/** Trust `X-Forwarded-For` when behind a reverse proxy. */
	trustProxy: boolean;
	hostKeyTimeoutMs: number;
}

function envValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = env[name];
		if (value !== undefined && value !== '') return value;
	}
	return undefined;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
	if (value === undefined) return defaultValue;
	const normalised = value.trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(normalised)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalised)) return false;
	throw new Error(`Invalid boolean value: ${value}`);
}

function parseInteger(
	name: string,
	value: string | undefined,
	defaultValue: number,
	min: number,
	max: number,
): number {
	if (value === undefined) return defaultValue;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(`Invalid ${name}: expected an integer between ${min} and ${max}`);
	}
	return parsed;
}

function parseList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/**
 * Build a typed configuration from an environment object.
 *
 * No secret values live in the configuration: credentials arrive per
 * connection and are never stored globally.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
	const allowlist = parseList(envValue(env, 'GATEWAY_ALLOWLIST'));
	const allowedOrigins = parseList(envValue(env, 'GATEWAY_ALLOWED_ORIGINS'));
	const tlsCertPath = envValue(env, 'GATEWAY_TLS_CERT');
	const tlsKeyPath = envValue(env, 'GATEWAY_TLS_KEY');

	return {
		port: parseInteger(
			'PORT',
			envValue(env, 'GATEWAY_PORT', 'PORT'),
			DEFAULT_PORT,
			1,
			65_535,
		),
		listenHost: envValue(env, 'GATEWAY_HOST') ?? '0.0.0.0',
		allowlist,
		openDirectory: allowlist.length === 0,
		allowedOrigins,
		allowPrivate: parseBoolean(envValue(env, 'GATEWAY_ALLOW_PRIVATE'), false),
		maxSessions: parseInteger(
			'GATEWAY_MAX_SESSIONS',
			envValue(env, 'GATEWAY_MAX_SESSIONS'),
			64,
			1,
			100_000,
		),
		idleTimeoutMs: parseInteger(
			'GATEWAY_IDLE_TIMEOUT_MS',
			envValue(env, 'GATEWAY_IDLE_TIMEOUT_MS'),
			30 * 60 * 1000,
			1_000,
			Number.MAX_SAFE_INTEGER,
		),
		rateLimit: parseInteger(
			'GATEWAY_RATE_LIMIT',
			envValue(env, 'GATEWAY_RATE_LIMIT'),
			100,
			1,
			1_000_000,
		),
		sessionRateLimit: parseInteger(
			'GATEWAY_SESSION_RATE_LIMIT',
			envValue(env, 'GATEWAY_SESSION_RATE_LIMIT'),
			10,
			1,
			1_000_000,
		),
		maxMessageBytes: MAX_MESSAGE_BYTES,
		maxBufferedOutputBytes: MAX_BUFFERED_OUTPUT_BYTES,
		...(tlsCertPath ? { tlsCertPath } : {}),
		...(tlsKeyPath ? { tlsKeyPath } : {}),
		tlsVerifyRemote: parseBoolean(envValue(env, 'GATEWAY_TLS_VERIFY'), false),
		embedDistPath:
			envValue(env, 'GATEWAY_EMBED_DIST') ??
			fileURLToPath(new URL('../../embed/dist', import.meta.url)),
		trustProxy: parseBoolean(envValue(env, 'GATEWAY_TRUST_PROXY'), false),
		hostKeyTimeoutMs: HOST_KEY_TIMEOUT_MS,
	};
}
