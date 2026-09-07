import { defineConfig } from 'vitest/config';

// End-to-end console tests: real harness process, real terminal (ConPTY via
// node-pty when available, emulated otherwise), scripted model. Slow and
// serial by design — run with `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
