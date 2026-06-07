import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // forks mode: each file runs in a separate child process — required for
    // better-sqlite3 (native addon) and ensures full module-registry isolation
    // between test files (each file gets its own :memory: DB instance).
    pool: 'forks',
    include: ['tests/**/*.test.ts'],
    // Populate the posts table (seed → DB) once per worker before any test runs.
    setupFiles: ['tests/setup.ts'],
    // Clear mock call history + pending "once" queues before each test.
    // Does NOT reset persistent implementations set with mockResolvedValue().
    clearMocks: true,
    // Guarantee env is set before ANY module is evaluated — db.ts opens the DB
    // at module load from process.env.DATABASE_URL, so this must be earliest.
    env: {
      DATABASE_URL: ':memory:',
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'test-key',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/test',
      DEVTO_API_KEY: 'test-devto-key',
      LINKDAPI_KEY: 'test-linkdapi-key',
      BASE_URL: 'http://localhost:3000',
      MAX_REVISIONS: '3',
      PORT: '3001',
    },
  },
});
