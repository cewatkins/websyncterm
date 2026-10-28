import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CTerm } from '@websyncterm/core';
import { byteToUnicode } from '@websyncterm/core';

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = resolve(here, './corpus');
const goldenDir = resolve(here, './golden');

/** Render a screen as a comparable string. */
function render(term: CTerm): string {
	const rows: string[] = [];
	for (let y = 0; y < term.rows; y++) {
		let line = '';
		for (let x = 0; x < term.cols; x++) {
			const code = term.screen.chars[y * term.cols + x];
			line += String.fromCodePoint(byteToUnicode(code));
		}
		rows.push(line.replace(/\s+$/, ''));
	}
	// The attributes are part of the golden output.
	const attrs: string[] = [];
	for (let i = 0; i < term.screen.chars.length; i++) {
		attrs.push(`${term.screen.fg[i]},${term.screen.bg[i]},${term.screen.flags[i]}`);
	}
	return `${rows.join('\n')}\n---\n${attrs.join(' ')}`;
}

const fixtures = readdirSync(corpusDir).filter((name) => name.endsWith('.ans')).sort();

describe('conformance corpus', () => {
	it('has fixtures', () => {
		expect(fixtures.length).toBeGreaterThan(0);
	});

	for (const name of fixtures) {
		it(`replays ${name} identically`, () => {
			const bytes = readFileSync(join(corpusDir, name));
			const term = new CTerm({ cols: 80, rows: 25 });
			term.write(new Uint8Array(bytes));
			const actual = render(term);
			const goldenPath = join(goldenDir, `${name}.txt`);
			let expected: string | null = null;
			try {
				expected = readFileSync(goldenPath, 'utf8');
			} catch {
				expected = null;
			}
			if (expected === null) {
				// Record the golden output on the first run.
				mkdirSync(goldenDir, { recursive: true });
				writeFileSync(goldenPath, actual, 'utf8');
				return;
			}
			expect(actual).toBe(expected);
		});
	}
});
