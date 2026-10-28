import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';

/**
 * Addresses we refuse to dial when SSRF protection is enabled.
 *
 * Keep this list conservative: anything that is not clearly public unicast
 * should be blocked. IPv4 entries are [a, b, c, d, prefixLength].
 */
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [number, number, number, number, number]> = [
	[0, 0, 0, 0, 8], // "this network"
	[10, 0, 0, 0, 8], // private
	[100, 64, 0, 0, 10], // carrier-grade NAT
	[127, 0, 0, 0, 8], // loopback
	[169, 254, 0, 0, 16], // link-local
	[172, 16, 0, 0, 12], // private
	[192, 0, 0, 0, 24], // IETF protocol assignments
	[192, 0, 2, 0, 24], // TEST-NET-1
	[192, 88, 99, 0, 24], // 6to4 relay anycast (deprecated)
	[192, 168, 0, 0, 16], // private
	[198, 18, 0, 0, 15], // benchmarking
	[198, 51, 100, 0, 24], // TEST-NET-2
	[203, 0, 113, 0, 24], // TEST-NET-3
	[224, 0, 0, 0, 4], // multicast
	[240, 0, 0, 0, 4], // reserved (includes 255.255.255.255)
];

const SECRET_QUERY_PARAMS = new Set([
	'pass',
	'password',
	'syspass',
	'systempassword',
	'key',
	'privatekey',
	'passphrase',
	'user',
	'username',
	'token',
	'secret',
	'auth',
]);

function parseIPv4(value: string): number[] | null {
	const parts = value.split('.');
	if (parts.length !== 4) return null;
	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		octets.push(octet);
	}
	return octets;
}

function ipv4ToNumber(octets: readonly number[]): number {
	return (
		(((octets[0] ?? 0) << 24) |
			((octets[1] ?? 0) << 16) |
			((octets[2] ?? 0) << 8) |
			(octets[3] ?? 0)) >>>
		0
	);
}

function ipv4InRange(octets: readonly number[], base: readonly number[], prefix: number): boolean {
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return (ipv4ToNumber(octets) & mask) === (ipv4ToNumber(base) & mask);
}

function isBlockedIPv4(octets: readonly number[]): boolean {
	return BLOCKED_IPV4_RANGES.some(([a, b, c, d, prefix]) =>
		ipv4InRange(octets, [a, b, c, d], prefix),
	);
}

function parseIPv6(value: string): number[] | null {
	let address = value.trim().toLowerCase();
	const zoneIndex = address.indexOf('%');
	if (zoneIndex >= 0) address = address.slice(0, zoneIndex);
	if (!address.includes(':')) return null;

	// Rewrite a trailing embedded IPv4 address ("::ffff:127.0.0.1") into
	// two hexadecimal groups so the regular parser can handle it.
	const lastColon = address.lastIndexOf(':');
	const tail = address.slice(lastColon + 1);
	if (tail.includes('.')) {
		const embedded = parseIPv4(tail);
		if (!embedded) return null;
		const hi = (((embedded[0] ?? 0) << 8) | (embedded[1] ?? 0)).toString(16);
		const lo = (((embedded[2] ?? 0) << 8) | (embedded[3] ?? 0)).toString(16);
		address = `${address.slice(0, lastColon + 1)}${hi}:${lo}`;
	}

	const halves = address.split('::');
	if (halves.length > 2) return null;

	const parseGroups = (part: string): number[] | null => {
		if (part === '') return [];
		const groups: number[] = [];
		for (const group of part.split(':')) {
			if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
			groups.push(parseInt(group, 16));
		}
		return groups;
	};

	const left = parseGroups(halves[0] ?? '');
	const right = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
	if (!left || !right) return null;

	if (halves.length === 1) {
		return left.length === 8 ? left : null;
	}

	const missing = 8 - left.length - right.length;
	if (missing < 0) return null;
	return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function groupsToIPv4(high: number, low: number): number[] {
	return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isBlockedIPv6(groups: readonly number[]): boolean {
	const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;

	// Unspecified (::) and loopback (::1).
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 0) {
		return true;
	}
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
		return true;
	}

	// Unique local (fc00::/7) and link-local (fe80::/10).
	if ((g0 & 0xfe00) === 0xfc00) return true;
	if ((g0 & 0xffc0) === 0xfe80) return true;

	// Multicast (ff00::/8).
	if ((g0 & 0xff00) === 0xff00) return true;

	// IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96).
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
		return isBlockedIPv4(groupsToIPv4(g6, g7));
	}

	// IPv4-embedded NAT64 well-known prefix (64:ff9b::/96).
	if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
		return isBlockedIPv4(groupsToIPv4(g6, g7));
	}

	return false;
}

/** Strip brackets and a trailing root dot from a hostname. */
export function normaliseHost(host: string): string {
	let value = host.trim().toLowerCase();
	if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
	if (!value.includes(':')) value = value.replace(/\.+$/, '');
	return value;
}

/**
 * True when an IP address is private, loopback, link-local, multicast,
 * reserved, or otherwise unsuitable as a public BBS destination.
 *
 * Non-IP strings return false; callers should resolve hostnames first.
 */
export function isBlockedAddress(address: string): boolean {
	const value = address.trim();
	if (value.length === 0) return false;

	const ipv4 = parseIPv4(value);
	if (ipv4) return isBlockedIPv4(ipv4);

	const ipv6 = parseIPv6(value);
	if (ipv6) return isBlockedIPv6(ipv6);

	return false;
}

interface AllowlistEntry {
	host: string;
	port?: number;
	wildcard: boolean;
}

function parseAllowlistEntry(raw: string): AllowlistEntry | null {
	let entry = raw.trim();
	if (entry.length === 0) return null;

	let host = entry;
	let port: number | undefined;

	if (entry.startsWith('[')) {
		const end = entry.indexOf(']');
		if (end > 0) {
			host = entry.slice(0, end + 1);
			const rest = entry.slice(end + 1);
			if (rest.startsWith(':')) {
				const parsed = Number(rest.slice(1));
				if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535) port = parsed;
			}
		}
	} else if (entry.indexOf(':') === entry.lastIndexOf(':') && entry.includes(':')) {
		const index = entry.lastIndexOf(':');
		const parsed = Number(entry.slice(index + 1));
		if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535) {
			host = entry.slice(0, index);
			port = parsed;
		}
	}

	host = normaliseHost(host);
	const wildcard = host.startsWith('*.');
	if (wildcard) host = host.slice(2);
	if (host.length === 0) return null;

	return port === undefined ? { host, wildcard } : { host, port, wildcard };
}

/**
 * Check a destination host against the configured allowlist.
 *
 * - An empty allowlist means "open directory" and allows everything (the
 *   separate SSRF check still applies).
 * - `host:port` entries restrict the port as well as the host.
 * - `*.example.com` matches subdomains of example.com, but not the apex.
 */
export function isHostAllowed(
	host: string,
	port: number | undefined,
	allowlist: readonly string[],
): boolean {
	if (allowlist.length === 0) return true;

	const candidate = normaliseHost(host);
	for (const raw of allowlist) {
		const entry = parseAllowlistEntry(raw);
		if (!entry) continue;
		if (entry.port !== undefined && port !== undefined && entry.port !== port) continue;

		if (entry.wildcard) {
			if (candidate.endsWith(`.${entry.host}`)) return true;
		} else if (candidate === entry.host) {
			return true;
		}
	}
	return false;
}

function normaliseOrigin(origin: string): string {
	return origin.trim().toLowerCase().replace(/\/+$/, '');
}

function originMatches(pattern: string, origin: string): boolean {
	if (pattern === '*') return true;
	const normalisedPattern = normaliseOrigin(pattern);
	if (normalisedPattern === origin) return true;

	// Support wildcard host patterns such as `https://*.example.com`.
	const star = normalisedPattern.indexOf('*');
	if (star < 0) return false;
	const prefix = normalisedPattern.slice(0, star);
	const suffix = normalisedPattern.slice(star + 1);
	return (
		origin.length > prefix.length + suffix.length &&
		origin.startsWith(prefix) &&
		origin.endsWith(suffix)
	);
}

/**
 * Validate a WebSocket `Origin` header.
 *
 * An empty allowlist permits every origin (the caller logs a warning at
 * startup). Otherwise a missing Origin is refused — only browsers set the
 * header, and non-browser clients must opt in explicitly.
 */
export function validateOrigin(
	origin: string | undefined,
	allowedOrigins: readonly string[],
): boolean {
	if (allowedOrigins.length === 0) return true;
	if (!origin) return false;
	const normalised = normaliseOrigin(origin);
	return allowedOrigins.some((pattern) => originMatches(pattern, normalised));
}

/**
 * Remove credential-bearing query parameters from a URL before logging it.
 * Works for both absolute URLs and request-target paths.
 */
export function redactUrl(url: string): string {
	const queryStart = url.indexOf('?');
	if (queryStart < 0) return url;
	const fragmentStart = url.indexOf('#', queryStart);
	const path = url.slice(0, queryStart);
	const query = url.slice(queryStart + 1, fragmentStart < 0 ? undefined : fragmentStart);
	const fragment = fragmentStart < 0 ? '' : url.slice(fragmentStart);

	const redacted = query
		.split('&')
		.map((pair) => {
			if (pair.length === 0) return pair;
			const equals = pair.indexOf('=');
			const rawName = equals < 0 ? pair : pair.slice(0, equals);
			let name = rawName;
			try {
				name = decodeURIComponent(rawName);
			} catch {
				// Keep the raw name when it is not valid percent-encoding.
			}
			if (SECRET_QUERY_PARAMS.has(name.toLowerCase())) {
				return `${rawName}=[redacted]`;
			}
			return pair;
		})
		.join('&');

	return `${path}?${redacted}${fragment}`;
}

/**
 * Resolve a hostname and reject it if any result is in a blocked range.
 * Throws with a user-safe message (no credentials involved).
 */
export async function resolveAndValidateHost(
	host: string,
	allowPrivate: boolean,
): Promise<LookupAddress[]> {
	const addresses = await lookup(host, { all: true, verbatim: true });
	if (addresses.length === 0) {
		throw new Error('Host did not resolve to any address');
	}
	if (!allowPrivate) {
		const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
		if (blocked) {
			throw new Error('Destination resolves to a blocked address (SSRF protection)');
		}
	}
	return addresses;
}

/** Post-connect DNS-rebinding check. */
export function isRemoteAddressAllowed(
	remoteAddress: string | undefined,
	allowPrivate: boolean,
): boolean {
	if (allowPrivate) return true;
	if (!remoteAddress) return false;
	return !isBlockedAddress(remoteAddress);
}
