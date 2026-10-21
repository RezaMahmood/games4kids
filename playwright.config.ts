import { defineConfig, devices } from '@playwright/test';
import { PORT_BASE, REAL_PORT_BASE } from './test/e2e/ports.ts';

export default defineConfig({
	testDir: 'test/e2e',
	testMatch: '*.spec.ts',
	fullyParallel: true,
	workers: 1,
	retries: 0,
	timeout: 90_000,
	expect: { timeout: 15_000 },
	reporter: [['list']],
	use: { ignoreHTTPSErrors: true, trace: 'retain-on-failure' },
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: [
		{
			command: `node --conditions=source tools/dev.mjs --fixtures --port-base ${PORT_BASE}`,
			url: `http://localhost:${PORT_BASE}/config.json`,
			reuseExistingServer: false,
			timeout: 60_000,
			stdout: 'pipe',
			stderr: 'pipe',
		},
		{
			command: `node --conditions=source tools/dev.mjs --port-base ${REAL_PORT_BASE}`,
			url: `http://localhost:${REAL_PORT_BASE}/config.json`,
			reuseExistingServer: false,
			timeout: 60_000,
			stdout: 'pipe',
			stderr: 'pipe',
		},
	],
});
