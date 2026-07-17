import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./src/test/setup.ts'],
    // The *.db.test.ts files truncate shared tables between tests, so parallel
    // test files corrupt each other's seeds. Serialize files only when the DB
    // gate is on; the pure unit/route run keeps full parallelism.
    fileParallelism: process.env.RUN_DB_TESTS !== '1',
  },
})
