import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

process.loadEnvFile('../../.env');

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Recusa ambiente de producao e banco sem a marca de banco de testes (test/env-guard.ts).
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    env: { NODE_ENV: 'test', DB_NAME: process.env.DB_NAME_TEST ?? '', STORAGE_DIR: path.join(tmpdir(), 'loja-test-storage') },
  },
});
