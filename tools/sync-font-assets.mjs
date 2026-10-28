#!/usr/bin/env node
/**
 * Copy the font assets into the front-end bundles.
 *
 * The bitmap fonts live in `packages/render/assets/fonts` and are fetched at
 * runtime, so each app needs its own copy inside its `public` directory.
 */

import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'packages/render/assets/fonts');
const targets = [resolve(root, 'apps/web/public/assets/fonts'), resolve(root, 'apps/embed/public/assets/fonts')];

for (const target of targets) {
	await mkdir(target, { recursive: true });
	await cp(resolve(root, 'packages/render/assets/fonts'), target, { recursive: true });
	console.error(`copied fonts -> ${target}`);
}
