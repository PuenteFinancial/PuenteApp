import { defineConfig } from 'vitest/config'

// Unit tests for web run in a plain Node environment — the lib helpers under
// test (idempotency key holder, error-envelope mapping) are pure and need no
// DOM. Playwright end-to-end specs live under e2e/ with their own runner and
// are excluded here so the two test layers never collide.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules/**', '.next/**', 'e2e/**'],
  },
})
