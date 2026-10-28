import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const coreSrc = fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url));
const renderSrc = fileURLToPath(new URL('../../packages/render/src/index.ts', import.meta.url));

/**
 * The standalone `<script src="…/web-syncterm.js">` bundle.
 *
 * It is emitted as an IIFE so that it can be dropped into any page.
 */
export default defineConfig({
	resolve: {
		alias: {
			'@websyncterm/core': coreSrc,
			'@websyncterm/render': renderSrc,
		},
	},
	define: { 'process.env.NODE_ENV': '"production"' },
	build: {
		outDir: 'dist',
		// The page build (`vite build`) writes index.html and the assets into
		// the same directory; emptying it here would delete the page and
		// leave the gateway's /embed/ route without an index.
		emptyOutDir: false,
		lib: {
			entry: fileURLToPath(new URL('./src/main.ts', import.meta.url)),
			name: 'WebSyncTerm',
			formats: ['iife'],
			fileName: () => 'web-syncterm.js',
		},
	},
});
