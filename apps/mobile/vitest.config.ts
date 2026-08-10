import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Unit tests for mobile run in plain Node, same as api and web — there is no
// jsdom anywhere in this repo. That is affordable only because the logic under
// test (token store contract, refresh sequencing, post-sign-in routing) is kept
// out of components on purpose. `app/` is excluded rather than merely unmatched
// so a future .test.tsx next to a screen fails loudly instead of silently
// booting a React Native renderer this config cannot serve.
export default defineConfig({
  // Mirrors the "@/*" -> "./*" mapping in tsconfig.json; vitest does not read
  // tsconfig paths on its own (same reason apps/web/vitest.config.ts has it).
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
    exclude: ['node_modules/**', 'app/**', '.expo/**'],
  },
})
