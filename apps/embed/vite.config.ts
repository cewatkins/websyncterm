import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const coreSrc = fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url));
const renderSrc = fileURLToPath(new URL('../../packages/render/src/index.ts', import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			'@websyncterm/core': coreSrc,
			'@websyncterm/render': renderSrc,
		},
	},
	server: { port: 5174 },
	build: { outDir: 'dist' },
});
