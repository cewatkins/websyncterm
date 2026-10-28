import { loadConfig } from './config.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
	const config = loadConfig();

	let server;
	try {
		server = await buildServer(config);
	} catch (error) {
		// Configuration/TLS-file errors only; no credentials are involved.
		console.error(`Failed to start gateway: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}

	const { app, sessions } = server;

	let shuttingDown = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		app.log.info(`received ${signal}, shutting down`);
		sessions.closeAll();
		try {
			await app.close();
		} catch (error) {
			app.log.error(error);
		}
		process.exit(0);
	};

	process.once('SIGINT', () => void shutdown('SIGINT'));
	process.once('SIGTERM', () => void shutdown('SIGTERM'));

	try {
		const address = await app.listen({ port: config.port, host: config.listenHost });
		app.log.info(
			`WebSyncTERM gateway listening on ${address} (${config.openDirectory ? 'open directory' : `${config.allowlist.length} allowlisted host(s)`})`,
		);
	} catch (error) {
		app.log.error(error);
		process.exit(1);
	}
}

void main();
