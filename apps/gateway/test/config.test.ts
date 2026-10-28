import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
	it('uses documented defaults', () => {
		const config = loadConfig({});

		expect(config.port).toBe(8023);
		expect(config.listenHost).toBe('0.0.0.0');
		expect(config.allowlist).toEqual([]);
		expect(config.openDirectory).toBe(true);
		expect(config.allowedOrigins).toEqual([]);
		expect(config.allowPrivate).toBe(false);
		expect(config.maxSessions).toBe(64);
		expect(config.idleTimeoutMs).toBe(30 * 60 * 1000);
		expect(config.rateLimit).toBe(100);
		expect(config.sessionRateLimit).toBe(10);
		expect(config.maxMessageBytes).toBe(1024 * 1024);
		expect(config.maxBufferedOutputBytes).toBe(8 * 1024 * 1024);
		expect(config.tlsCertPath).toBeUndefined();
		expect(config.tlsKeyPath).toBeUndefined();
		expect(config.tlsVerifyRemote).toBe(false);
		expect(config.trustProxy).toBe(false);
	});

	it('parses the allowlist, origins and limits', () => {
		const config = loadConfig({
			GATEWAY_PORT: '9000',
			GATEWAY_ALLOWLIST: 'bbs1.example.com, bbs2.example.com:2323,*.example.net',
			GATEWAY_ALLOWED_ORIGINS: 'https://bbs.example.com,https://embed.example.com',
			GATEWAY_ALLOW_PRIVATE: '1',
			GATEWAY_MAX_SESSIONS: '8',
			GATEWAY_IDLE_TIMEOUT_MS: '60000',
			GATEWAY_RATE_LIMIT: '250',
			GATEWAY_SESSION_RATE_LIMIT: '3',
			GATEWAY_TLS_CERT: '/etc/ssl/gw.crt',
			GATEWAY_TLS_KEY: '/etc/ssl/gw.key',
			GATEWAY_TLS_VERIFY: 'true',
			GATEWAY_TRUST_PROXY: 'yes',
			GATEWAY_EMBED_DIST: '/srv/embed',
		});

		expect(config.port).toBe(9000);
		expect(config.allowlist).toEqual([
			'bbs1.example.com',
			'bbs2.example.com:2323',
			'*.example.net',
		]);
		expect(config.openDirectory).toBe(false);
		expect(config.allowedOrigins).toEqual([
			'https://bbs.example.com',
			'https://embed.example.com',
		]);
		expect(config.allowPrivate).toBe(true);
		expect(config.maxSessions).toBe(8);
		expect(config.idleTimeoutMs).toBe(60000);
		expect(config.rateLimit).toBe(250);
		expect(config.sessionRateLimit).toBe(3);
		expect(config.tlsCertPath).toBe('/etc/ssl/gw.crt');
		expect(config.tlsKeyPath).toBe('/etc/ssl/gw.key');
		expect(config.tlsVerifyRemote).toBe(true);
		expect(config.trustProxy).toBe(true);
		expect(config.embedDistPath).toBe('/srv/embed');
	});

	it('falls back to PORT when GATEWAY_PORT is unset', () => {
		expect(loadConfig({ PORT: '8123' }).port).toBe(8123);
		expect(loadConfig({ PORT: '8123', GATEWAY_PORT: '9123' }).port).toBe(9123);
	});

	it('rejects malformed numeric values', () => {
		expect(() => loadConfig({ GATEWAY_MAX_SESSIONS: 'many' })).toThrow(/GATEWAY_MAX_SESSIONS/);
		expect(() => loadConfig({ PORT: '0' })).toThrow(/PORT/);
	});
});
