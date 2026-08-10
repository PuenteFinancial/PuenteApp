import { defineConfig } from 'tsup'

// Two configs rather than one so only `theme` pays for a CommonJS build.
// NativeWind's tailwind.config.js is CJS and `require()`s the tokens; every
// other consumer (apps/api, apps/web, Metro) is ESM, and emitting .cjs for the
// 1,300-line i18n entry would double the build output for nothing.
//
// `clean` stays off: the two configs write to disjoint directories inside one
// process, and cleaning would have the second wipe the first.
export default defineConfig([
  {
    entry: ['src/index.ts', 'src/i18n/index.ts'],
    format: ['esm'],
    dts: true,
    outDir: 'dist',
  },
  {
    entry: ['src/theme/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    outDir: 'dist/theme',
  },
])
