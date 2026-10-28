import { describe, expect, it } from 'vitest';
import { buildRloginHandshake } from '../src/protocols/rlogin.js';

describe('buildRloginHandshake', () => {
	it('matches the upstream byte sequence for ANSI at 115200', () => {
		const handshake = buildRloginHandshake({
			user: 'user',
			password: 'pass',
			term: 'syncterm',
			bps: 115200,
		});

		expect([...handshake]).toEqual([
			0x00, // empty local user name
			0x70, 0x61, 0x73, 0x73, 0x00, // "pass" + NUL (server user name)
			0x75, 0x73, 0x65, 0x72, 0x00, // "user" + NUL (terminal type/speed field)
			0x73, 0x79, 0x6e, 0x63, 0x74, 0x65, 0x72, 0x6d, 0x2f, 0x31, 0x31, 0x35, 0x32, 0x30,
			0x30, 0x00, // "syncterm/115200" + NUL
		]);
	});

	it('swaps the credential fields in reversed mode', () => {
		const handshake = buildRloginHandshake({
			user: 'user',
			password: 'pass',
			term: 'ansi',
			bps: 38400,
			reversed: true,
		});

		expect(handshake.toString('latin1')).toBe('\0user\0pass\0ansi/38400\0');
	});

	it('defaults the speed to 115200', () => {
		const handshake = buildRloginHandshake({ user: 'u', password: 'p', term: 'syncterm' });
		expect(handshake.toString('latin1')).toBe('\0p\0u\0syncterm/115200\0');
	});
});
