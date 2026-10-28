#!/usr/bin/env node
/**
 * Guard against compiled output landing next to the sources.
 *
 * A stray `.js` file in a package's `src/` directory shadows the `.ts` file
 * of the same name when Vite resolves the import, so the browser silently
 * runs stale code. This check fails the build if that happens.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['packages', 'apps'];

/** The compiled extensions that must never appear in a source tree. */
const BAD = ['.js', '.jsx', '.mjs', '.cjs', '.map'];

let offenders = 0;

function walk(dir) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (name === 'node_modules' || name === 'dist' || name === 'build') continue;
		const path = join(dir, name);
		let info;
		try {
			info = statSync(path);
		} catch {
			continue;
		}
		if (info.isDirectory()) {
			walk(path);
			continue;
		}
		if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue;
		// A .d.ts is fine; anything else with a compiled extension is not.
		if (name.endsWith('.d.ts')) continue;
		const ext = name.slice(name.lastIndexOf('.'));
		if (BAD.includes(ext)) {
			console.error(`compiled output in a source tree: ${path.slice(root.length + 1)}`);
			offenders += 1;
		}
	}
}

for (const dir of roots) walk(join(root, dir));

if (offenders > 0) {
	console.error(
		`\n${offenders} compiled file(s) found next to the sources.\n` +
			'This shadows the TypeScript source in the dev server. Delete them and\n' +
			'check that the package tsconfig does not map another package\'s source\n' +
			'through "paths" (use a project reference instead).',
	);
	process.exit(1);
}

console.error('source trees are clean');
