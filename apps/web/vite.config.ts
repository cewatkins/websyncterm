import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const renderSrc = fileURLToPath(new URL('../../packages/render/src/index.ts', import.meta.url));

/** The gateway the dev server proxies to. */
const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8023';
const coreSrc = fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url));

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			'@websyncterm/core': coreSrc,
			'@websyncterm/render': renderSrc,
		},
	},
	server: {
		port: 5173,
		strictPort: false,
		proxy: {
			'/api': { target: gatewayUrl, changeOrigin: true },
			'/health': { target: gatewayUrl, changeOrigin: true },
			'/ws': { target: gatewayUrl.replace(/^http/, 'ws'), ws: true },
		},
	},
	build: {
		outDir: 'dist',
		sourcemap: true,
	},
});
