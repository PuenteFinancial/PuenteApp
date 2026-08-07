import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Unit tests for web run in a plain Node environment — the lib helpers under
// test (idempotency key holder, error-envelope mapping) are pure and need no
// DOM. Playwright end-to-end specs live under e2e/ with their own runner and
// are excluded here so the two test layers never collide.
export default defineConfig({
  // Mirrors the "@/*" -> "./*" mapping in tsconfig.json. Vitest does not read
  // tsconfig paths on its own, so without this any module that imports via the
  // alias — every route handler under app/ — is untestable.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules/**', '.next/**', 'e2e/**'],
  },
})
