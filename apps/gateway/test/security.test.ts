import { describe, expect, it } from 'vitest';
import {
	isBlockedAddress,
	isHostAllowed,
	redactUrl,
	validateOrigin,
} from '../src/security.js';

describe('isBlockedAddress', () => {
	it.each([
		'127.0.0.1',
		'10.1.2.3',
		'192.168.1.1',
		'169.254.1.1',
		'0.0.0.0',
		'100.64.0.1',
		'172.16.0.1',
		'224.0.0.1',
		'255.255.255.255',
		'::1',
		'::',
		'fc00::1',
		'fd12:3456::1',
		'fe80::1',
		'ff02::1',
		'::ffff:127.0.0.1',
		'::ffff:10.0.0.1',
		'64:ff9b::7f00:1',
	])('blocks %s', (address) => {
		expect(isBlockedAddress(address)).toBe(true);
	});

	it.each([
		'8.8.8.8',
		'93.184.216.34',
		'172.32.0.1',
		'2606:4700::1111',
		'::ffff:8.8.8.8',
		'64:ff9b::808:808',
	])('allows %s', (address) => {
		expect(isBlockedAddress(address)).toBe(false);
	});

	it('ignores non-IP strings', () => {
		expect(isBlockedAddress('bbs.example.com')).toBe(false);
	});
});

describe('isHostAllowed', () => {
	it('allows every host in open-directory mode', () => {
		expect(isHostAllowed('anything.example', 23, [])).toBe(true);
	});

	it('matches exact hosts case-insensitively', () => {
		const allowlist = ['bbs.example.com'];
		expect(isHostAllowed('bbs.example.com', 23, allowlist)).toBe(true);
		expect(isHostAllowed('BBS.EXAMPLE.COM', 23, allowlist)).toBe(true);
		expect(isHostAllowed('other.example.com', 23, allowlist)).toBe(false);
	});

	it('honours host:port entries', () => {
		const allowlist = ['bbs.example.com:2323'];
		expect(isHostAllowed('bbs.example.com', 2323, allowlist)).toBe(true);
		expect(isHostAllowed('bbs.example.com', 23, allowlist)).toBe(false);
	});

	it('matches wildcard subdomains but not the apex', () => {
		const allowlist = ['*.example.com'];
		expect(isHostAllowed('bbs.example.com', 23, allowlist)).toBe(true);
		expect(isHostAllowed('deep.bbs.example.com', 23, allowlist)).toBe(true);
		expect(isHostAllowed('example.com', 23, allowlist)).toBe(false);
		expect(isHostAllowed('badexample.com', 23, allowlist)).toBe(false);
	});

	it('combines wildcards with ports', () => {
		const allowlist = ['*.example.com:2323'];
		expect(isHostAllowed('bbs.example.com', 2323, allowlist)).toBe(true);
		expect(isHostAllowed('bbs.example.com', 23, allowlist)).toBe(false);
	});

	it('matches IPv6 literals', () => {
		expect(isHostAllowed('::1', 23, ['[::1]:23'])).toBe(true);
		expect(isHostAllowed('::1', 2323, ['[::1]:23'])).toBe(false);
	});
});

describe('validateOrigin', () => {
	it('allows any origin when no allowlist is configured', () => {
		expect(validateOrigin('https://anything.example', [])).toBe(true);
		expect(validateOrigin(undefined, [])).toBe(true);
	});

	it('requires a listed origin when an allowlist is configured', () => {
		const allowed = ['https://bbs.example.com'];
		expect(validateOrigin('https://bbs.example.com', allowed)).toBe(true);
		expect(validateOrigin('https://bbs.example.com/', allowed)).toBe(true);
		expect(validateOrigin('https://evil.example', allowed)).toBe(false);
		expect(validateOrigin(undefined, allowed)).toBe(false);
	});

	it('supports wildcard and * entries', () => {
		expect(validateOrigin('https://bbs.example.com', ['https://*.example.com'])).toBe(true);
		expect(validateOrigin('https://example.com', ['https://*.example.com'])).toBe(false);
		expect(validateOrigin('https://anything.example', ['*'])).toBe(true);
	});
});

describe('redactUrl', () => {
	it('masks credentials in a request target', () => {
		const redacted = redactUrl(
			'/ws?host=bbs.example.com&port=23&user=alice&pass=hunter2&syspass=s3cret&key=PRIVATEKEY',
		);

		expect(redacted).toContain('host=bbs.example.com');
		expect(redacted).toContain('port=23');
		expect(redacted).toContain('pass=[redacted]');
		expect(redacted).toContain('syspass=[redacted]');
		expect(redacted).toContain('key=[redacted]');
		expect(redacted).not.toContain('hunter2');
		expect(redacted).not.toContain('s3cret');
		expect(redacted).not.toContain('PRIVATEKEY');
		expect(redacted).not.toContain('alice');
	});

	it('preserves the fragment and handles encoded names', () => {
		const redacted = redactUrl('https://gw.example/ws?%70ass=hunter2&proto=ssh#top');
		expect(redacted).toBe('https://gw.example/ws?%70ass=[redacted]&proto=ssh#top');
	});

	it('returns URLs without a query unchanged', () => {
		expect(redactUrl('/health')).toBe('/health');
	});
});
