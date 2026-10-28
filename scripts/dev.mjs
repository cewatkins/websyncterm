#!/usr/bin/env node
/**
 * Development launcher: runs the gateway and the web app together.
 *
 * `pnpm dev` starts:
 *   - the Fastify gateway on http://localhost:8023
 *   - the Vite dev server for the web app on http://localhost:5173
 *   - the Vite dev server for the embed app on http://localhost:5174
 *
 * Ctrl-C stops everything.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {{name: string, cwd: string, cmd: string, args: string[], color: string}[]} */
const targets = [
	{
		name: 'gateway',
		cwd: resolve(root, 'apps/gateway'),
		cmd: 'node',
		args: ['--experimental-strip-types', '--watch', 'src/index.ts'],
		color: '\x1b[36m',
	},
	{
		name: 'web',
		cwd: resolve(root, 'apps/web'),
		cmd: 'npx',
		args: ['vite'],
		color: '\x1b[35m',
	},
	{
		name: 'embed',
		cwd: resolve(root, 'apps/embed'),
		cmd: 'npx',
		args: ['vite'],
		color: '\x1b[33m',
	},
];

const children = [];
let shuttingDown = false;

for (const target of targets) {
	if (!existsSync(resolve(target.cwd, 'package.json'))) continue;
	const child = spawn(target.cmd, target.args, {
		cwd: target.cwd,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, FORCE_COLOR: '1' },
	});
	children.push(child);
	const prefix = `${target.color}[${target.name}]\x1b[0m `;
	const pipe = (stream, out) => {
		let buffer = '';
		stream.on('data', (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) out.write(prefix + line + '\n');
		});
	};
	pipe(child.stdout, process.stdout);
	pipe(child.stderr, process.stderr);
	child.on('exit', (code) => {
		if (shuttingDown) return;
		process.stderr.write(`${prefix}exited with code ${code}\n`);
	});
}

function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const child of children) {
		try {
			child.kill('SIGTERM');
		} catch {
			/* ignore */
		}
	}
	setTimeout(() => process.exit(0), 300).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
