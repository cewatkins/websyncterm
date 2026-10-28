import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const renderSrc = fileURLToPath(new URL('../../packages/render/src/index.ts', import.meta.url));
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
			'/api': { target: 'http://localhost:8023', changeOrigin: true },
			'/health': { target: 'http://localhost:8023', changeOrigin: true },
			'/ws': { target: 'ws://localhost:8023', ws: true },
		},
	},
	build: {
		outDir: 'dist',
		sourcemap: true,
	},
});
