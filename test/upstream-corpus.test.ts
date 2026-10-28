import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CTerm } from '@websyncterm/core';

/**
 * The location of an upstream Synchronet checkout.
 *
 * Set `WST_SBBS` to point at one; the test is skipped when it is absent.
 */
const sbbsRoot = process.env.WST_SBBS ?? '/tmp/opencode/ref/sbbs';

/** Collect the upstream `.ans`/`.asc` corpus. */
function collectCorpus(root: string, limit = 40): string[] {
	const found: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 6 || found.length >= limit) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const path = join(dir, name);
			let isDir = false;
			try {
				isDir = statSync(path).isDirectory();
			} catch {
				continue;
			}
			if (isDir) {
				walk(path, depth + 1);
			} else if (/\.(ans|asc)$/i.test(name)) {
				found.push(path);
			}
			if (found.length >= limit) return;
		}
	};
	walk(root, 0);
	return found.sort();
}

/** A stable hash of the rendered screen. */
function hashScreen(term: CTerm): string {
	let hash = 0x811c9dc5;
	const mix = (value: number): void => {
		hash ^= value & 0xff;
		hash = Math.imul(hash, 0x01000193) >>> 0;
		hash ^= (value >> 8) & 0xff;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	};
	for (let i = 0; i < term.screen.chars.length; i++) {
		mix(term.screen.chars[i]);
		mix(term.screen.fg[i]);
		mix(term.screen.bg[i]);
		mix(term.screen.flags[i]);
	}
	return hash.toString(16).padStart(8, '0');
}

const corpus = existsSync(sbbsRoot) ? collectCorpus(sbbsRoot) : [];

describe.skipIf(corpus.length === 0)('upstream ANSI corpus', () => {
	it('finds corpus files', () => {
		expect(corpus.length).toBeGreaterThan(0);
	});

	for (const path of corpus) {
		it(`replays ${path.slice(sbbsRoot.length + 1)} without crashing`, () => {
			const bytes = readFileSync(path);
			const term = new CTerm({ cols: 80, rows: 25 });
			expect(() => term.write(new Uint8Array(bytes))).not.toThrow();
			// The cursor must remain inside the screen.
			expect(term.xpos).toBeGreaterThanOrEqual(0);
			expect(term.xpos).toBeLessThanOrEqual(term.cols);
			expect(term.ypos).toBeLessThanOrEqual(term.rows);
			// The screen must contain printable text.
			let printable = 0;
			for (let i = 0; i < term.screen.chars.length; i++) {
				const code = term.screen.chars[i];
				if (code >= 0x20 && code < 0x7f) printable++;
			}
			expect(printable).toBeGreaterThan(0);
			expect(hashScreen(term)).toMatch(/^[0-9a-f]{8}$/);
		});
	}
});

describe('the corpus hash is stable', () => {
	it('produces the same hash for the same input', () => {
		const term = new CTerm({ cols: 80, rows: 25 });
		term.writeString('\x1b[2J\x1b[Hhello');
		const first = hashScreen(term);
		const again = new CTerm({ cols: 80, rows: 25 });
		again.writeString('\x1b[2J\x1b[Hhello');
		expect(hashScreen(again)).toBe(first);
	});
});
