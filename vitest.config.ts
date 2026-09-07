import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // End-to-end console scenarios have their own config (vitest.e2e.config.ts).
    exclude: ['test/e2e/**', 'node_modules/**'],
    environment: 'node',
  },
});
