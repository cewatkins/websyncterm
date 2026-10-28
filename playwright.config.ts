import { defineConfig, devices } from '@playwright/test';

const gatewayPort = Number(process.env.E2E_GATEWAY_PORT ?? 18023);
const bbsPort = Number(process.env.E2E_BBS_PORT ?? 18099);
const webPort = Number(process.env.E2E_WEB_PORT ?? 15173);

export default defineConfig({
	testDir: './e2e',
	timeout: 30_000,
	expect: { timeout: 10_000 },
	fullyParallel: false,
	workers: 1,
	reporter: process.env.CI ? 'line' : 'list',
	use: {
		baseURL: `http://127.0.0.1:${webPort}`,
		trace: 'retain-on-failure',
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: [
		{
			command: `node e2e/mock-bbs.mjs`,
			env: { MOCK_BBS_PORT: String(bbsPort) },
			port: bbsPort,
			reuseExistingServer: true,
			stdout: 'pipe',
		},
		{
			command: `node apps/gateway/dist/index.js`,
			env: {
				GATEWAY_PORT: String(gatewayPort),
				GATEWAY_ALLOW_PRIVATE: '1',
				GATEWAY_ALLOWLIST: '127.0.0.1',
				GATEWAY_ALLOWED_ORIGINS: '',
			},
			port: gatewayPort,
			reuseExistingServer: true,
			stdout: 'pipe',
		},
		{
			command: `pnpm --filter @websyncterm/web exec vite --port ${webPort} --strictPort`,
			env: { GATEWAY_URL: `http://127.0.0.1:${gatewayPort}` },
			port: webPort,
			reuseExistingServer: true,
			stdout: 'pipe',
			timeout: 120_000,
		},
	],
});
