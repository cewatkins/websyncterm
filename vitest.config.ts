import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const coreSrc = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));
const renderSrc = fileURLToPath(new URL('./packages/render/src/index.ts', import.meta.url));
const xferSrc = fileURLToPath(new URL('./packages/xfer/src/index.ts', import.meta.url));
const ripSrc = fileURLToPath(new URL('./packages/rip/src/index.ts', import.meta.url));
const audioSrc = fileURLToPath(new URL('./packages/audio/src/index.ts', import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			'@websyncterm/core': coreSrc,
			'@websyncterm/render': renderSrc,
			'@websyncterm/xfer': xferSrc,
			'@websyncterm/rip': ripSrc,
			'@websyncterm/audio': audioSrc,
		},
	},
	test: {
		include: [
			'packages/*/test/**/*.test.ts',
			'apps/*/test/**/*.test.ts',
			'test/**/*.test.ts',
		],
		environment: 'node',
		globals: false,
	},
});
