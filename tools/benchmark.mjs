#!/usr/bin/env node
/**
 * Measure the terminal engine's throughput.
 *
 * Usage: `node tools/benchmark.mjs`
 */

import { CTerm } from '../packages/core/dist/index.js';

const MB = 1024 * 1024;

/** Build a representative ANSI byte stream. */
function buildPayload(bytes) {
	const parts = [];
	const encoder = new TextEncoder();
	const chunks = [
		'\x1b[1;32mBright green text with a background\x1b[0m\r\n',
		'\x1b[44;37m  Blue background, white text   \x1b[0m\r\n',
		'\x1b[10;20HPositioned text\x1b[5;5HAnother position',
		'\xdb\xdc\xdb\xdb\xdb\xba\xc9\xcd\xcd\xcd\xbb\xba\xc8\xcd\xcd\xcd\xbc',
		'plain ascii line of text that wraps around the eighty column margin\r\n',
	];
	let length = 0;
	// A single clear at the start, as a real stream would have.
	const prologue = encoder.encode('\x1b[2J\x1b[H');
	parts.push(prologue);
	length += prologue.length;
	while (length < bytes) {
		for (const chunk of chunks) {
			const encoded = encoder.encode(chunk);
			parts.push(encoded);
			length += encoded.length;
			if (length >= bytes) break;
		}
	}
	const out = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		if (offset >= length) break;
		out.set(part.subarray(0, Math.min(part.length, length - offset)), offset);
		offset += part.length;
	}
	return out;
}

const payload = buildPayload(4 * MB);
const term = new CTerm({ cols: 132, rows: 60 });

const start = process.hrtime.bigint();
term.write(payload);
const elapsed = Number(process.hrtime.bigint() - start) / 1e6;

const seconds = elapsed / 1000;
const megabytes = payload.length / MB;
const bitsPerSecond = (payload.length * 8) / seconds;
const budget = (payload.length / 65536) * 8;

console.log('WebSyncTERM terminal engine benchmark');
console.log('  payload            :', payload.length.toLocaleString(), 'bytes');
console.log('  screen             : 132x60');
console.log('  elapsed            :', elapsed.toFixed(1), 'ms');
console.log('  throughput         :', megabytes.toFixed(2), 'MB/s');
console.log('  equivalent bitrate :', (bitsPerSecond / 1e6).toFixed(2), 'Mbit/s');
console.log('  budget (8 ms / 64 KiB chunk):', elapsed < budget ? 'PASS' : 'FAIL', `(${elapsed.toFixed(1)} ms vs ${budget.toFixed(1)} ms)`);
console.log('  per 64 KiB chunk           :', (elapsed / (payload.length / 65536)).toFixed(2), 'ms');
