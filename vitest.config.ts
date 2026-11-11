import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/phase*.test.ts'],
    setupFiles: ['./test/setup_env.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
});

