import Fastify, { LogController, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import type { GatewayConfig } from './config.js';
import { redactUrl, validateOrigin } from './security.js';
import { parseSessionRequest, SessionManager } from './sessions.js';
import { errorMessage } from './protocols/util.js';

export interface GatewayServer {
	app: FastifyInstance;
	sessions: SessionManager;
}

function rootPage(embedAvailable: boolean): string {
	const embed = embedAvailable
		? '<p><a href="/embed/">Open the embeddable WebSyncTERM widget</a></p>'
		: '<p>The embeddable widget has not been built. Run <code>pnpm --filter @websyncterm/embed build</code> and restart the gateway to serve it at <code>/embed/</code>.</p>';

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WebSyncTERM Gateway</title>
<style>
body{font-family:system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem;line-height:1.55;color:#ddd;background:#111}
a{color:#6cf}code{background:#222;padding:.1rem .3rem;border-radius:.2rem}
</style>
</head>
<body>
<h1>WebSyncTERM Gateway</h1>
<p>This service proxies browser WebSocket connections to BBS systems over
Telnet, Telnet over TLS, SSH, RLogin or raw TCP. Terminal negotiation happens
in the browser; the gateway forwards bytes unchanged.</p>
${embed}
<h2>Endpoints</h2>
<ul>
<li><code>GET /health</code> — liveness and active session count</li>
<li><code>GET /api/hosts</code> — this gateway's host allowlist</li>
<li><code>GET /api/config</code> — allowlist, limits and rate limits</li>
<li><code>GET /ws?host=…&amp;port=…&amp;proto=…</code> — WebSocket byte pipe</li>
</ul>
<p>WebSocket clients may request the <code>websyncterm</code> subprotocol.
Connections without a subprotocol are also accepted.</p>
<p>In production this gateway must sit behind a TLS terminator (nginx, Caddy or
similar); it speaks plain HTTP/WebSocket unless
<code>GATEWAY_TLS_CERT</code>/<code>GATEWAY_TLS_KEY</code> are configured.</p>
</body>
</html>`;
}

/**
 * Build the Fastify application. Plugins are registered before routes so
 * `@fastify/websocket` can hook the `/ws` route; call `app.listen()` (or
 * `app.ready()`) to start it.
 */
export async function buildServer(config: GatewayConfig): Promise<GatewayServer> {
	const tls =
		config.tlsCertPath && config.tlsKeyPath
			? { cert: readFileSync(config.tlsCertPath), key: readFileSync(config.tlsKeyPath) }
			: undefined;

	const app = Fastify({
		logger: { level: process.env.LOG_LEVEL ?? 'info' },
		logController: new LogController({ disableRequestLogging: true }),
		trustProxy: config.trustProxy,
		...(tls ? { https: tls } : {}),
	});

	// Request logging never includes credentials: `user`, `pass`, `syspass`,
	// `key` and related parameters are masked before the URL is written.
	app.addHook('onResponse', async (request, reply) => {
		request.log.info(
			{
				method: request.method,
				url: redactUrl(request.url),
				statusCode: reply.statusCode,
				durationMs: Math.round(reply.elapsedTime),
				ip: request.ip,
			},
			'request completed',
		);
	});

	await app.register(cors, {
		origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : true,
		methods: ['GET', 'OPTIONS'],
	});

	await app.register(rateLimit, {
		global: true,
		max: config.rateLimit,
		timeWindow: 60_000,
	});

	await app.register(websocket, {
		options: {
			maxPayload: config.maxMessageBytes,
			// Reject upgrades from disallowed origins before the socket opens.
			verifyClient: (info, callback) => {
				const origin = info.origin || info.req.headers.origin;
				if (validateOrigin(origin, config.allowedOrigins)) {
					callback(true);
					return;
				}
				app.log.warn(`rejected WebSocket upgrade from origin ${origin ?? '(none)'}`);
				callback(false, 403, 'Forbidden');
			},
			// Permissive: pick `websyncterm` when offered, otherwise echo the
			// client's first protocol. Connections with no protocol are fine.
			handleProtocols: (protocols) => {
				if (protocols.has('websyncterm')) return 'websyncterm';
				const first = protocols.values().next();
				return first.done ? false : first.value;
			},
		},
	});

	const embedAvailable = existsSync(config.embedDistPath);
	if (embedAvailable) {
		await app.register(fastifyStatic, {
			root: config.embedDistPath,
			prefix: '/embed/',
		});
		app.get('/embed', async (_request, reply) => reply.redirect('/embed/'));
	}

	const sessions = new SessionManager({ config, logger: app.log });

	if (config.allowedOrigins.length === 0) {
		app.log.warn(
			'GATEWAY_ALLOWED_ORIGINS is not set: WebSocket upgrades from any origin are accepted',
		);
	}
	if (!tls) {
		app.log.warn(
			'Built-in TLS is disabled: put this gateway behind a TLS terminator in production',
		);
	}

	app.get('/health', async () => ({
		ok: true,
		uptime: process.uptime(),
		sessions: sessions.count,
	}));

	app.get('/api/hosts', async () => (config.openDirectory ? [] : [...config.allowlist]));

	app.get('/api/config', async () => ({
		allowlist: [...config.allowlist],
		openDirectory: config.openDirectory,
		maxSessions: config.maxSessions,
		rateLimit: config.rateLimit,
		sessionRateLimit: config.sessionRateLimit,
		idleTimeoutMs: config.idleTimeoutMs,
	}));

	app.get('/', async (_request, reply) => {
		reply.type('text/html; charset=utf-8').send(rootPage(embedAvailable));
	});

	app.get(
		'/ws',
		{ websocket: true, config: { rateLimit: false } },
		(socket, request) => {
			let params;
			try {
				params = parseSessionRequest(request.query as Record<string, unknown>);
			} catch (error) {
				try {
					socket.send(JSON.stringify({ type: 'error', message: errorMessage(error) }));
					socket.close(1008, 'invalid connection parameters');
				} catch {
					// Socket already gone.
				}
				return;
			}
			sessions.accept(socket, request.ip, params);
		},
	);

	app.addHook('onClose', async () => {
		sessions.dispose();
	});

	return { app, sessions };
}
