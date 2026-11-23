import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname) } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Blocks the global fetch in every test file (see the file).
    setupFiles: ['tests/setup/no-network.ts'],
  },
});
