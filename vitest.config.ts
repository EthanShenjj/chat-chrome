import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], testTimeout: 20000, pool: 'forks', maxWorkers: 1, fileParallelism: false } });
