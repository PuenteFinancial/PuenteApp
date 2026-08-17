import { dirname } from 'node:path'
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
  //
  // Resolved through `dirname(fileURLToPath(...))` rather than `new URL('./',
  // import.meta.url)`. Once `expo start` has run once it generates
  // expo-env.d.ts, which this tsconfig includes and which pulls in Expo's DOM
  // lib — and DOM's `URL` is then not assignable to node:url's `URL`, so the
  // whole workspace stops typechecking. CI never hits it (nothing runs `expo
  // start` there); every developer does, exactly once, and the error names a
  // file they did not touch.
  resolve: {
    alias: {
      '@': dirname(fileURLToPath(import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
    exclude: ['node_modules/**', 'app/**', '.expo/**'],
    // lib/api.ts throws at import time when this is missing — deliberately, so
    // a broken build fails with one legible message instead of a scatter of
    // "fetch failed to undefined/v1/...". That makes it an import-time
    // dependency for anything that pulls the api singleton in transitively,
    // including the query fetchers. The value is never dialled: every test that
    // reaches the network mocks the client.
    env: {
      EXPO_PUBLIC_API_URL: 'http://api.test',
    },
  },
})
