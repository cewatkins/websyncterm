import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { WebSocket } from 'ws';
import { CTerm, TelnetNegotiator } from '@websyncterm/core';

/**
 * A mock BBS that speaks a little telnet and then emits ANSI.
 */
function startMockBbs(): Promise<{ port: number; server: Server; close: () => Promise<void> }> {
	const server = createServer((socket) => {
		socket.write('IAC WILL ECHO\r\n'.replace('IAC WILL ECHO\r\n', '\xff\xfb\x01'));
		socket.write('\x1b[2J\x1b[H');
		socket.write('Welcome to the mock BBS\r\n');
		socket.write('\x1b[1;32mGreen text\x1b[0m\r\n');
		socket.on('data', () => {
			/* echo nothing */
		});
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			resolve({
				port,
				server,
				close: () =>
					new Promise<void>((done) => {
						server.close(() => done());
					}),
			});
		});
	});
}

describe('end-to-end', () => {
	let bbs: Awaited<ReturnType<typeof startMockBbs>>;
	let gateway: { close: () => Promise<void>; port: number };

	beforeAll(async () => {
		bbs = await startMockBbs();
		// The gateway is started as a child process so that the test exercises
		// the real HTTP/WebSocket stack.
		const { spawn } = await import('node:child_process');
		const port = 18023;
		// Run the TypeScript source directly so the test does not depend on a
		// prior build.
		const child = spawn('npx', ['tsx', 'src/index.ts'], {
			cwd: new URL('../', import.meta.url).pathname,
			env: {
				...process.env,
				GATEWAY_PORT: String(port),
				GATEWAY_ALLOW_PRIVATE: '1',
				GATEWAY_ALLOWLIST: '127.0.0.1',
			},
			stdio: 'ignore',
		});
		gateway = {
			port,
			close: async () => {
				child.kill('SIGTERM');
				await new Promise((r) => setTimeout(r, 200));
			},
		};
		// Wait for the gateway to come up.
		for (let i = 0; i < 50; i++) {
			try {
				const response = await fetch(`http://127.0.0.1:${port}/health`);
				if (response.ok) return;
			} catch {
				/* not up yet */
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error('The gateway did not start');
	});

	afterAll(async () => {
		await gateway.close();
		await bbs.close();
	});

	it('relays the BBS output through the gateway to a terminal', async () => {
		const socket = new WebSocket(
			`ws://127.0.0.1:${gateway.port}/ws?host=127.0.0.1&port=${bbs.port}&proto=telnet&term=syncterm&cols=80&rows=25&naws=1`,
		);
		const term = new CTerm({ cols: 80, rows: 25 });
		const negotiator = new TelnetNegotiator(() => {}, { terminalType: 'syncterm' });

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Timed out waiting for the BBS output')), 10_000);
			socket.on('open', () => {
				negotiator.start();
			});
			socket.on('message', (data: Buffer | ArrayBuffer | string) => {
				if (typeof data === 'string') return;
				const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : data);
				const payload = negotiator.process(bytes);
				if (payload.length > 0) term.write(payload);
				for (let row = 0; row < term.rows; row++) {
					if (term.screen.rowText(row, (c) => c).includes('Green text')) {
						clearTimeout(timer);
						resolve();
						return;
					}
				}
			});
			socket.on('error', reject);
		});

		let greenIndex = -1;
		for (let row = 0; row < term.rows && greenIndex < 0; row++) {
			const line = term.screen.rowText(row, (c) => c);
			const at = line.indexOf('Green');
			if (at >= 0) greenIndex = row * term.cols + at;
		}
		expect(greenIndex).toBeGreaterThanOrEqual(0);
		// The green attribute must have survived the round trip. The mock
		// BBS sends SGR 1 (bold) then SGR 32 (green), so the foreground
		// index is green (2) with the intensity bit (8) set.
		expect(term.screen.fg[greenIndex]).toBe(10);
		expect(term.screen.flags[greenIndex] & 1).toBe(1);
		socket.close();
	}, 30_000);
});
