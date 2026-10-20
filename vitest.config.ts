import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * drawpad's own pure-logic suites (scoring, the stencil, the canvas maths, the upload queue, the usage tracker) keep
 * the Vitest they were written for. Everything else in the repo runs on node:test. The shell is a run-time import in a
 * page, so a test that reaches it gets the one class the pages take from it, ApiFailure.
 */
export default defineConfig({
  resolve: {
    alias: {
      '/shell/v1/index.js': fileURLToPath(new URL('./apps/shared/api-client.ts', import.meta.url)),
      '@g4k/sdk': fileURLToPath(new URL('./packages/sdk/src/index.ts', import.meta.url)),
    },
  },
  test: { environment: 'node', include: ['games/**/*.test.ts'] },
});
