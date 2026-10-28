#!/usr/bin/env node
/**
 * A mock BBS used by the end-to-end tests.
 *
 * It speaks just enough telnet and then emits ANSI so the terminal has
 * something to render.
 */

import { createServer } from 'node:net';

const port = Number(process.env.MOCK_BBS_PORT ?? 18099);

const server = createServer((socket) => {
	// IAC WILL ECHO
	socket.write(Buffer.from([0xff, 0xfb, 0x01]));
	socket.write('\x1b[2J\x1b[H');
	socket.write('Welcome to the mock BBS\r\n');
	socket.write('\x1b[1;32mGreen text\x1b[0m\r\n');
	socket.write('\x1b[44;33mBlue on yellow\x1b[0m\r\n');
	socket.on('error', () => {});
});

server.listen(port, '127.0.0.1', () => {
	console.error(`mock BBS listening on 127.0.0.1:${port}`);
});
